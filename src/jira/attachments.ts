// Вложения и картинки: чистые функции без vscode (тестируются в vitest, используются хостом и smoke).
import * as path from 'node:path';
import { isOwnUrl, normalizeBaseUrl } from './http';
import type { Attachment, InstanceKind, IssueDetail } from './types';

/** Жёсткий потолок для «Скачать» (файлы держим в памяти до записи на диск). Картинки — `jiraffe.maxImageMb`. */
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
/** Открыть в редакторе — не больше этого (большие логи VS Code всё равно открывает без подсветки и тормозит). */
export const MAX_TEXT_OPEN_BYTES = 50 * 1024 * 1024;

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_NAME_BYTES = 180;

/**
 * Имя файла для диска из имени вложения Jira (которому не доверяем): без каталогов (`/`, `\`), без `..` и ведущих точек
 * (никаких скрытых `.gitignore`/`.envrc` от автора вложения), без управляющих символов и `<>:"|?*`, без зарезервированных
 * имён Windows, не длиннее 180 байт (расширение сохраняется). Пустой результат — `fallback`.
 */
export function safeFileName(name: string, fallback: string): string {
  let n = String(name ?? '').normalize('NFC');
  n = n.split(/[\\/]/).pop() ?? ''; // только последняя часть пути
  n = n.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ''); // управляющие и bidi
  n = n.replace(/[\u061c\u2028\u2029\ufeff]/g, ''); // прочие невидимые/направляющие
  n = n.replace(/[<>:"|?*\uff0f\uff3c\u2215\u29f8]/g, '_'); // + «похожие на слэш» (／ ＼ ∕ ⧸) — не путь, но вводят в заблуждение
  n = n.replace(/\s+/g, ' ').trim();
  n = n.replace(/^[.\s]+/, '').replace(/[.\s]+$/, ''); // ведущие точки (`..`, dotfiles) и хвостовые точки/пробелы (Windows)
  if (!n) return fallback;
  if (WIN_RESERVED.test(n)) n = `_${n}`;
  if (Buffer.byteLength(n) > MAX_NAME_BYTES) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : '';
    let stem = n.slice(0, n.length - ext.length);
    while (Buffer.byteLength(stem + ext) > MAX_NAME_BYTES) stem = Array.from(stem).slice(0, -1).join('');
    n = stem.trim() + ext;
  }
  return n || fallback;
}

/**
 * Имена файлов вложений задачи: санитизированные и уникальные в пределах задачи (в Jira бывает несколько `image.png`) —
 * повтор получает суффикс ` (id)`. Одно и то же вложение всегда даёт одно имя, так что повторное скачивание перезаписывает.
 */
export function attachmentFileNames(atts: readonly Attachment[]): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  const ordered = [...atts].sort((a, b) => (a.created === b.created ? cmpId(a.id, b.id) : a.created < b.created ? -1 : 1));
  for (const a of ordered) {
    let n = safeFileName(a.filename, `attachment-${safeFileName(a.id, 'x')}`);
    const base = n;
    for (let k = 0; seen.has(n.toLowerCase()); k++) {
      // Суффикс приклеивается ПОСЛЕ обрезки до лимита: иначе у длинных тёзок он отрезался и два вложения писались в один файл.
      const suffix = ` (${safeFileName(a.id, 'x').slice(0, 20)}${k ? `-${k}` : ''})`;
      const dot = base.lastIndexOf('.');
      const ext = dot > 0 && base.length - dot <= 16 ? base.slice(dot) : '';
      let stem = base.slice(0, base.length - ext.length);
      while (stem && Buffer.byteLength(stem + suffix + ext) > MAX_NAME_BYTES) stem = Array.from(stem).slice(0, -1).join('');
      n = `${stem.trim()}${suffix}${ext}`;
    }
    seen.add(n.toLowerCase());
    out.set(a.id, n);
  }
  return out;
}
const cmpId = (a: string, b: string): number => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Адреса содержимого и превью вложения — только адреса инстанса. Если Jira отдала ссылку на другой хост (неверный
 * `jira.baseurl`, прокси), адрес собирается заново из `baseUrl` и числового id; иначе — `undefined` (не качаем).
 */
export function attachmentUrls(a: Attachment, inst: { baseUrl: string; kind: InstanceKind }): { content?: string; thumbnail?: string } {
  const base = normalizeBaseUrl(inst.baseUrl);
  const idOk = /^\d{1,18}$/.test(a.id);
  const content = isOwnUrl(a.contentUrl, base)
    ? a.contentUrl
    : idOk ? (inst.kind === 'cloud' ? `${base}/rest/api/2/attachment/content/${a.id}` : `${base}/secure/attachment/${a.id}/${encodeURIComponent(a.filename || a.id)}`) : undefined;
  let thumbnail: string | undefined;
  if (a.thumbnailUrl) {
    thumbnail = isOwnUrl(a.thumbnailUrl, base)
      ? a.thumbnailUrl
      : idOk ? (inst.kind === 'cloud' ? `${base}/rest/api/2/attachment/thumbnail/${a.id}` : `${base}/secure/thumbnail/${a.id}/_thumb_${a.id}.png`) : undefined;
  }
  return { ...(content ? { content } : {}), ...(thumbnail ? { thumbnail } : {}) };
}

const ext = (name: string): string => {
  const m = /\.([a-z0-9]{1,10})$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
};

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);
const TEXT_EXT = new Set(['txt', 'log', 'json', 'xml', 'csv', 'tsv', 'md', 'yaml', 'yml', 'ini', 'conf', 'cfg', 'properties', 'sql', 'diff', 'patch', 'har']);

/** Стоит ли пробовать превью. Это только подсказка по метаданным Jira — тип картинки потом проверяется по сигнатуре. */
export const isImageAttachment = (a: Pick<Attachment, 'filename' | 'mimeType'>): boolean =>
  /^image\//i.test(a.mimeType) || IMAGE_EXT.has(ext(a.filename));

/**
 * Показывать ли «Открыть в редакторе»: расширение из списка или mime из МЕТАДАННЫХ Jira (`text/*`, json, xml).
 * Content-Type ответа при скачивании не учитывается; перед открытием содержимое ещё проверяется `looksLikeText`.
 */
export const isTextAttachment = (a: Pick<Attachment, 'filename' | 'mimeType'>): boolean =>
  TEXT_EXT.has(ext(a.filename)) || /^(text\/[\w.+-]+|application\/(json|xml|x-ndjson))(;|$)/i.test(a.mimeType.trim());

/** Текст, а не бинарь: нет NUL в первых 64 КБ (UTF-8, cp1251 и прочие однобайтовые проходят). */
export function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 65536);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}

/** Тип картинки по сигнатуре (Content-Type ответа не используется). Не картинка — `undefined`. */
export function sniffImage(b: Uint8Array): string | undefined {
  const at = (i: number, ...xs: number[]): boolean => xs.every((x, k) => b[i + k] === x);
  const ascii = (i: number, s: string): boolean => at(i, ...Array.from(s, (c) => c.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'BM') && b.length > 26) return 'image/bmp';
  if (at(0, 0, 0, 1, 0) && b.length > 6) return 'image/x-icon';
  // SVG в <img> безопасен (скрипты и внешние ресурсы не исполняются), но признаём только настоящий <svg> в начале.
  if (looksLikeText(b) && svgAtStart(new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 4096)))) return 'image/svg+xml';
  return undefined;
}

/**
 * Пролог SVG: BOM, пробелы, `<?xml …?>`, комментарии, `<!DOCTYPE …>`, затем `<svg`. Линейный проход без регэкспа с
 * повторяющимися группами — у того был экспоненциальный откат на файле из сотен `<!---->` (вешал extension host).
 */
function svgAtStart(text: string): boolean {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    const rest = text.slice(i, i + 9).toLowerCase();
    if (rest.startsWith('<?xml')) {
      const end = text.indexOf('?>', i);
      if (end < 0) return false;
      i = end + 2;
    } else if (rest.startsWith('<!--')) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) return false;
      i = end + 3;
    } else if (rest.startsWith('<!doctype')) {
      const end = text.indexOf('>', i);
      if (end < 0) return false;
      i = end + 1;
    } else {
      return /^<svg[\s>]/i.test(text.slice(i, i + 5));
    }
  }
}

/** Не больше стольких пикселей у картинки для webview (5 МБ PNG может раскрыться в гигабайты RGBA). */
export const MAX_IMAGE_PIXELS = 50_000_000;
/** SVG — не больше (защита от `<use>`-бомб: размер в пикселях у SVG не ограничивает работу рендерера). */
export const MAX_SVG_BYTES = 1024 * 1024;

/** Размер растровой картинки из заголовка (png/gif/bmp/webp/jpeg); не разобрали — `undefined`. */
export function imageSize(b: Uint8Array, mime: string): { w: number; h: number } | undefined {
  const u16 = (i: number): number => b[i] | (b[i + 1] << 8);
  const u16be = (i: number): number => (b[i] << 8) | b[i + 1];
  const u24 = (i: number): number => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i: number): number => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const i32 = (i: number): number => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
  const chunk = (i: number): string => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  switch (mime) {
    case 'image/png': return b.length >= 24 ? { w: u32be(16), h: u32be(20) } : undefined;
    case 'image/gif': return b.length >= 10 ? { w: u16(6), h: u16(8) } : undefined;
    case 'image/bmp': return b.length >= 26 ? { w: Math.abs(i32(18)), h: Math.abs(i32(22)) } : undefined;
    case 'image/webp':
      if (b.length < 30) return undefined;
      if (chunk(12) === 'VP8X') return { w: 1 + u24(24), h: 1 + u24(27) };
      if (chunk(12) === 'VP8L') return { w: 1 + (((b[22] & 0x3f) << 8) | b[21]), h: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
      if (chunk(12) === 'VP8 ') return { w: u16(26) & 0x3fff, h: u16(28) & 0x3fff };
      return undefined;
    case 'image/jpeg': {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return undefined;
        const m = b[i + 1];
        if (m === 0xff) { i++; continue; }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: u16be(i + 7), h: u16be(i + 5) };
        i += 2 + u16be(i + 2);
      }
      return undefined;
    }
    default: return undefined;
  }
}

/** Почему картинку нельзя отдавать webview (слишком много пикселей / большой SVG); можно — `undefined`. */
export function imageRejection(b: Uint8Array, mime: string): string | undefined {
  if (mime === 'image/svg+xml') return b.length > MAX_SVG_BYTES ? `SVG больше ${fmtMb(MAX_SVG_BYTES)} — скачайте файл` : undefined;
  const d = imageSize(b, mime);
  return d && d.w * d.h > MAX_IMAGE_PIXELS ? `картинка ${d.w}×${d.h} слишком большая для показа — скачайте файл` : undefined;
}

export const toDataUri = (mime: string, bytes: Uint8Array): string => `data:${mime};base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')}`;

const unescAttr = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Плейсхолдер картинки, который выдаёт `sanitizeJiraHtml` (формат фиксированный — его пишет наш трансформ `img`). */
const IMG_PH = /<span class="img-ph" data-src="([^"]*)"((?: title="[^"]*")?)>([^<]*)<\/span>/g;

/**
 * Картинки описания и комментариев: `span.img-ph[data-src]` → `span.img-ph[data-img="iN"]`. Адреса остаются в хосте
 * (`urls[N]`), webview видит только номер и просит картинку по нему — подсунуть свой адрес он не может.
 * Адрес повторно проверяется на принадлежность инстансу; чужой — плейсхолдер без номера (не качаем).
 * HTML уже санитизирован; после подмены санитайзер не гоняем (data:-картинки вставляет webview через DOM).
 */
export function extractInlineImages(d: IssueDetail, baseUrl: string): { issue: IssueDetail; urls: string[] } {
  const urls: string[] = [];
  const index = new Map<string, number>();
  const rewrite = (html: string): string =>
    html.replace(IMG_PH, (_m, rawSrc: string, title: string, text: string) => {
      const src = unescAttr(rawSrc);
      if (!isOwnUrl(src, baseUrl)) return `<span class="img-ph"${title}>${text}</span>`;
      let n = index.get(src);
      if (n === undefined) {
        n = urls.length;
        urls.push(src);
        index.set(src, n);
      }
      return `<span class="img-ph" data-img="i${n}"${title}>${text}</span>`;
    });
  return {
    issue: { ...d, descriptionHtml: rewrite(d.descriptionHtml), comments: d.comments.map((c) => ({ ...c, bodyHtml: rewrite(c.bodyHtml) })) },
    urls,
  };
}

export interface AttachmentsRootInput {
  /** Значение `jiraffe.attachmentsDir` (по умолчанию `.jiraffe`). */
  setting: string | undefined;
  /** Значение пришло из настроек workspace/папки (их может прислать чужой репозиторий). */
  fromWorkspace: boolean;
  workspaceDir?: string;
  tmpDir: string;
}

export const DEFAULT_ATTACHMENTS_DIR = '.jiraffe';

/**
 * Корень для сохранения вложений. Относительный путь — от первой папки workspace и не выше неё; абсолютный — только из
 * пользовательских настроек (настройки workspace из чужого репо не должны уводить запись в `~/.ssh`). Без workspace —
 * `<tmp>/jiraffe` (или абсолютный путь из пользовательских настроек).
 */
export interface AttachmentsRoot { root: string; inWorkspace: boolean; isDefault: boolean; /** Общий временный каталог `<tmp>/jiraffe`. */ tmp: boolean; warning?: string }

export function resolveAttachmentsRoot(o: AttachmentsRootInput): AttachmentsRoot {
  const raw = (o.setting ?? '').trim() || DEFAULT_ATTACHMENTS_DIR;
  if (path.isAbsolute(raw)) {
    if (!o.fromWorkspace) return { root: path.resolve(raw), inWorkspace: false, isDefault: false, tmp: false };
    const fallback = o.workspaceDir ? path.join(o.workspaceDir, DEFAULT_ATTACHMENTS_DIR) : path.join(o.tmpDir, 'jiraffe');
    return { root: fallback, inWorkspace: !!o.workspaceDir, isDefault: true, tmp: !o.workspaceDir, warning: 'абсолютный jiraffe.attachmentsDir из настроек рабочей области игнорируется — задайте его в пользовательских настройках' };
  }
  if (!o.workspaceDir) return { root: path.join(o.tmpDir, 'jiraffe'), inWorkspace: false, isDefault: true, tmp: true };
  const ws = path.resolve(o.workspaceDir);
  const root = path.resolve(ws, raw);
  const rel = path.relative(ws, root);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { root: path.join(ws, DEFAULT_ATTACHMENTS_DIR), inWorkspace: true, isDefault: true, tmp: false, warning: `jiraffe.attachmentsDir «${raw}» выходит за пределы рабочей области — используется ${DEFAULT_ATTACHMENTS_DIR}` };
  }
  return { root, inWorkspace: true, isDefault: path.normalize(raw).replace(/[\\/]+$/, '') === DEFAULT_ATTACHMENTS_DIR, tmp: false };
}

/** Полный путь файла вложения; `undefined`, если после склейки он вышел за `root/<key>` (защита сверх `safeFileName`). */
export function attachmentPath(root: string, key: string, fileName: string): string | undefined {
  const dir = path.resolve(root, safeFileName(key, 'issue'));
  const full = path.resolve(dir, fileName);
  const rel = path.relative(dir, full);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep) ? full : undefined;
}

/** LRU по суммарному «весу» (длина data URI): кэш картинок в памяти хоста, чтобы смена вкладки не качала заново. */
export class LruCache<V> {
  private readonly map = new Map<string, { v: V; w: number }>();
  private total = 0;
  constructor(private readonly maxWeight: number) {}

  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }

  set(k: string, v: V, w: number): void {
    const old = this.map.get(k);
    if (old) {
      this.total -= old.w;
      this.map.delete(k);
    }
    if (w > this.maxWeight) return;
    this.map.set(k, { v, w });
    this.total += w;
    for (const [key, e] of this.map) {
      if (this.total <= this.maxWeight) break;
      this.map.delete(key);
      this.total -= e.w;
    }
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }

  get weight(): number {
    return this.total;
  }
}

/** Не больше `n` задач одновременно (скачивания картинок не должны забивать инстанс десятками запросов). */
export function limiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = (): void => {
    if (active >= n) return;
    const run = queue.shift();
    if (run) {
      active++;
      run();
    }
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve().then(fn).then(resolve, reject).finally(() => {
          active--;
          next();
        });
      });
      next();
    });
}

/**
 * Недоверенная строка (имя вложения, текст ошибки сервера) для уведомления VS Code: там `[текст](command:…)` становится
 * кликабельной ссылкой, в т.ч. на команду. Скобки заменяются похожими, длина — до `max`.
 */
export const noticeText = (s: string, max = 160): string => {
  const t = String(s).replace(/\[/g, '［').replace(/\]/g, '］').replace(/[\r\n]+/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

export const fmtMb = (bytes: number): string => `${Math.round((bytes / 1024 / 1024) * 10) / 10} МБ`;
