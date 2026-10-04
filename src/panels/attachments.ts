// Вложения: картинки для webview (data: URI), сохранение на диск, открытие текстовых файлов в редакторе.
// Безопасность: качаем только адреса инстанса (HttpClient.getBinary сам проверяет origin/context path и редиректы),
// тип картинки — по сигнатуре, имя файла — safeFileName, запись — атомарно через rename (симлинк на месте файла не
// «пробивается»), каталоги-симлинки и чужой tmp-каталог отвергаются.
import { randomBytes } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  attachmentFileNames, attachmentPath, attachmentUrls, fmtMb, isImageAttachment, isTextAttachment, limiter, looksLikeText,
  imageRejection, LruCache, MAX_DOWNLOAD_BYTES, MAX_TEXT_OPEN_BYTES, noticeText, resolveAttachmentsRoot, sniffImage, toDataUri,
} from '../jira/attachments';
import type { JiraClient } from '../jira/client';
import type { Attachment, Instance } from '../jira/types';

export type ImageResult = { dataUri: string } | { error: string };

/** Что нужно сервису от карточки: инстанс, клиент, ключ, вложения с адресами и адреса картинок описания. */
export interface AttachmentContext {
  inst: Instance;
  client: JiraClient;
  key: string;
  files: readonly Attachment[];
  inlineUrls: readonly string[];
  /** Карточка ещё показана (не закрыта и не сменилась): задачи из очереди для «мёртвой» карточки не стартуют. */
  alive?: () => boolean;
}

const TMP_TTL_MS = 7 * 24 * 3600 * 1000;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** Недоверенное (имя из Jira, текст ошибки) — в уведомление только через `noticeText` (там работают markdown-ссылки). */
const q = (s: string): string => `«${noticeText(s, 120)}»`;
const CANCELLED = 'отменено: карточка закрыта или сменилась';

export class AttachmentService implements vscode.Disposable {
  /** ~64 МБ data URI на все карточки; ключ — инстанс + адрес. Ошибки не кэшируются (повтор при следующем показе). */
  private readonly cache = new LruCache<string>(64 * 1024 * 1024);
  private readonly inflight = new Map<string, { p: Promise<ImageResult>; alive: (() => boolean)[] }>();
  private readonly limit = limiter(3);
  /** Сохранения (до 200 МБ в памяти каждое) — не больше двух одновременно. */
  private readonly saveLimit = limiter(2);
  private warned = false;

  dispose(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  maxImageBytes(): number {
    const v = vscode.workspace.getConfiguration('jiraffe').get<number>('maxImageMb', 5);
    const n = Number.isFinite(v) ? Math.min(Math.max(v, 1), 50) : 5;
    return Math.round(n * 1024 * 1024);
  }

  /** Картинка по id протокола (`iN`, `tID`, `fID`) → data URI или текст ошибки. Id уже проверен по формату. */
  image(ctx: AttachmentContext, id: string): Promise<ImageResult> {
    const max = this.maxImageBytes();
    if (id.startsWith('i')) {
      const url = ctx.inlineUrls[Number(id.slice(1))];
      return url ? this.fetchImage(ctx, url, max) : Promise.resolve({ error: 'картинка не найдена' });
    }
    const att = ctx.files.find((a) => a.id === id.slice(1));
    if (!att) return Promise.resolve({ error: 'вложение не найдено' });
    if (!isImageAttachment(att)) return Promise.resolve({ error: 'не картинка' });
    const urls = attachmentUrls(att, ctx.inst);
    const full = (): Promise<ImageResult> => {
      if (!urls.content) return Promise.resolve({ error: 'адрес вложения не относится к инстансу' });
      if (att.size > max) return Promise.resolve({ error: `больше лимита превью ${fmtMb(max)} (${fmtMb(att.size)}) — скачайте файл` });
      return this.fetchImage(ctx, urls.content, max);
    };
    if (id.startsWith('t') && urls.thumbnail) {
      return this.fetchImage(ctx, urls.thumbnail, max).then((r) => ('error' in r ? full() : r));
    }
    return full();
  }

  private fetchImage(ctx: AttachmentContext, url: string, max: number): Promise<ImageResult> {
    const k = `${ctx.inst.id}\n${url}`;
    const hit = this.cache.get(k);
    if (hit) return Promise.resolve({ dataUri: hit });
    const alive = ctx.alive ?? ((): boolean => true);
    const running = this.inflight.get(k);
    if (running) {
      running.alive.push(alive);
      return running.p;
    }
    const waiters = [alive];
    const p = this.limit(async (): Promise<ImageResult> => {
      // Пока задача стояла в очереди, карточку могли закрыть или сменить — тогда не качаем (и не кэшируем отказ).
      if (!waiters.some((a) => a())) return { error: CANCELLED };
      try {
        const { bytes } = await ctx.client.downloadAttachment(url, max);
        const mime = sniffImage(bytes);
        if (!mime) return { error: 'файл не является картинкой (или нет доступа)' };
        const rejected = imageRejection(bytes, mime);
        if (rejected) return { error: rejected };
        const dataUri = toDataUri(mime, bytes);
        this.cache.set(k, dataUri, dataUri.length);
        return { dataUri };
      } catch (e) {
        return { error: errText(e) };
      }
    }).finally(() => this.inflight.delete(k));
    this.inflight.set(k, { p, alive: waiters });
    return p;
  }

  /** Корень сохранения с учётом настройки и workspace; создаётся и проверяется (не симлинк, tmp — свой). */
  private async root(): Promise<{ root: string; inWorkspace: boolean; ws?: string }> {
    const cfg = vscode.workspace.getConfiguration('jiraffe');
    const ins = cfg.inspect<string>('attachmentsDir');
    const wsVal = ins?.workspaceFolderValue ?? ins?.workspaceValue;
    const setting = wsVal ?? ins?.globalValue ?? ins?.defaultValue;
    const ws = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri.fsPath;
    const r = resolveAttachmentsRoot({ setting, fromWorkspace: wsVal !== undefined, workspaceDir: ws, tmpDir: os.tmpdir() });
    if (r.warning && !this.warned) {
      this.warned = true;
      void vscode.window.showWarningMessage(`Jiraffe: ${r.warning}`);
    }
    // Промежуточный каталог-симлинк (`docs -> ~` при attachmentsDir = docs/att) уводил бы запись из workspace —
    // проверяем ДО mkdir (по ближайшему существующему предку), чтобы не создать каталоги снаружи, и после.
    if (r.inWorkspace && ws) await assertInside(ws, await existingAncestor(r.root), r.root);
    await fs.mkdir(r.root, { recursive: true, mode: 0o700 });
    if (r.inWorkspace || r.tmp) await assertRealDir(r.root, r.tmp);
    else if (!(await fs.stat(r.root)).isDirectory()) throw new Error(`${r.root} — не каталог; сохранение отменено`); // путь пользователя: симлинк допустим
    if (r.inWorkspace && ws) await assertInside(ws, r.root, r.root);
    if (r.inWorkspace && r.isDefault) {
      // .jiraffe не должен уехать в git пользователя: `*` в своём .gitignore (wx — не трогаем существующий и симлинк).
      await fs.writeFile(path.join(r.root, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined);
    }
    return { root: r.root, inWorkspace: r.inWorkspace, ws };
  }

  /**
   * Скачать и сохранить одно вложение в `<root>/<KEY>/<имя>`; повторное скачивание перезаписывает. Байты наружу не
   * отдаются (до 200 МБ не должны жить, пока висит уведомление) — только вывод, текст ли это.
   */
  save(ctx: AttachmentContext, att: Attachment, maxBytes = MAX_DOWNLOAD_BYTES): Promise<{ file: string; shown: string; text: boolean }> {
    return this.saveLimit(() => this.saveNow(ctx, att, maxBytes));
  }

  private async saveNow(ctx: AttachmentContext, att: Attachment, maxBytes: number): Promise<{ file: string; shown: string; text: boolean }> {
    if (att.size > maxBytes) throw new Error(`больше лимита ${fmtMb(maxBytes)} (${fmtMb(att.size)})`);
    const url = attachmentUrls(att, ctx.inst).content;
    if (!url) throw new Error('адрес вложения не относится к инстансу — скачивание запрещено');
    const name = attachmentFileNames(ctx.files).get(att.id) ?? `attachment-${att.id}`;
    const { root, inWorkspace, ws } = await this.root();
    const file = attachmentPath(root, ctx.key, name);
    if (!file) throw new Error('недопустимое имя файла');
    const { bytes } = await ctx.client.downloadAttachment(url, maxBytes);
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await assertRealDir(dir, false);
    const tmp = path.join(dir, `.jiraffe-${randomBytes(6).toString('hex')}.part`);
    try {
      await fs.writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 });
      await fs.rename(tmp, file); // rename заменяет сам путь: симлинк на месте файла не ведёт запись наружу
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    const shown = inWorkspace && ws ? path.relative(ws, file) : file;
    return { file, shown, text: looksLikeText(bytes) && bytes.length <= MAX_TEXT_OPEN_BYTES };
  }

  /** «Скачать»: прогресс в уведомлении, итог — «Показать в папке» / «Открыть в редакторе» (для текстовых). */
  async download(ctx: AttachmentContext, id: string): Promise<void> {
    const att = ctx.files.find((a) => a.id === id);
    if (!att) return void vscode.window.showWarningMessage('Jiraffe: вложение не найдено — обновите карточку');
    try {
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Jiraffe: скачиваю ${q(att.filename)}…` }, () => this.save(ctx, att));
      const actions = ['Показать в папке', ...(isTextAttachment(att) && r.text ? ['Открыть в редакторе'] : [])];
      const pick = await vscode.window.showInformationMessage(`Jiraffe: сохранено ${q(r.shown)}`, ...actions);
      if (pick === 'Показать в папке') void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(r.file));
      if (pick === 'Открыть в редакторе') await openText(r.file);
    } catch (e) {
      void vscode.window.showErrorMessage(`Jiraffe: не удалось скачать ${q(att.filename)}: ${noticeText(errText(e))}`);
    }
  }

  /** «Скачать все»: по одному, с отменой между файлами; ошибки отдельных файлов не останавливают остальные. */
  async downloadAll(ctx: AttachmentContext): Promise<void> {
    if (!ctx.files.length) return void vscode.window.showInformationMessage('Jiraffe: у задачи нет вложений');
    const failed: string[] = [];
    let saved = 0;
    let last = '';
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Jiraffe: вложения ${ctx.key}`, cancellable: true },
      async (progress, token) => {
        for (const [n, att] of ctx.files.entries()) {
          if (token.isCancellationRequested) break;
          progress.report({ message: `${n + 1}/${ctx.files.length}: ${q(att.filename)}`, increment: 100 / ctx.files.length });
          try {
            last = (await this.save(ctx, att)).file;
            saved++;
          } catch (e) {
            failed.push(`${q(att.filename)} — ${noticeText(errText(e), 120)}`);
          }
        }
      },
    );
    if (failed.length) void vscode.window.showWarningMessage(`Jiraffe: не скачано ${failed.length}: ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? '…' : ''}`);
    if (!saved) return;
    const pick = await vscode.window.showInformationMessage(`Jiraffe: сохранено ${saved} из ${ctx.files.length} в папку ${ctx.key}`, 'Показать в папке');
    if (pick && last) void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(last));
  }

  /**
   * «Открыть в редакторе»: только для текстовых по имени/метаданным Jira; файл сохраняется (как «Скачать») и
   * открывается из сохранённой копии, если содержимое действительно текст (нет NUL). Внешними программами не открываем.
   */
  async openInEditor(ctx: AttachmentContext, id: string): Promise<void> {
    const att = ctx.files.find((a) => a.id === id);
    if (!att) return void vscode.window.showWarningMessage('Jiraffe: вложение не найдено — обновите карточку');
    if (!isTextAttachment(att)) return void vscode.window.showWarningMessage(`Jiraffe: ${q(att.filename)} не текстовый файл — используйте «Скачать»`);
    try {
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Jiraffe: открываю ${q(att.filename)}…` }, () => this.save(ctx, att, MAX_TEXT_OPEN_BYTES));
      if (!r.text) {
        const pick = await vscode.window.showWarningMessage(`Jiraffe: ${q(att.filename)} не похож на текст — сохранён в ${q(r.shown)}, в редакторе не открываю`, 'Показать в папке');
        if (pick) void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(r.file));
        return;
      }
      await openText(r.file);
    } catch (e) {
      void vscode.window.showErrorMessage(`Jiraffe: не удалось открыть ${q(att.filename)}: ${noticeText(errText(e))}`);
    }
  }

  /** Очистка `<tmp>/jiraffe`: папки задач старше недели (best effort, при активации). */
  async cleanupTmp(): Promise<void> {
    const dir = path.join(os.tmpdir(), 'jiraffe');
    try {
      await assertRealDir(dir, true);
      const now = Date.now();
      for (const name of await fs.readdir(dir)) {
        const p = path.join(dir, name);
        const st = await fs.lstat(p);
        if (now - st.mtimeMs > TMP_TTL_MS) await fs.rm(p, { recursive: true, force: true });
      }
    } catch {
      /* нет каталога или он не наш — нечего чистить */
    }
  }
}

async function openText(file: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc, { preview: true });
}

/**
 * Каталог — настоящий (не симлинк: закоммиченный в репо `.jiraffe -> ~/.ssh` не уведёт запись наружу).
 * Для своего tmp-каталога ещё и владелец — текущий пользователь (на Linux /tmp общий).
 */
/** Ближайший существующий предок пути (сам путь, если он есть). */
async function existingAncestor(p: string): Promise<string> {
  for (let cur = path.resolve(p); ; cur = path.dirname(cur)) {
    try {
      await fs.lstat(cur);
      return cur;
    } catch {
      if (path.dirname(cur) === cur) return cur;
    }
  }
}

/** Реальный путь `p` (с раскрытыми симлинками) лежит внутри реального `ws`; иначе — отказ. */
async function assertInside(ws: string, p: string, shown: string): Promise<void> {
  const rel = path.relative(await fs.realpath(ws), await fs.realpath(p));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${shown} ведёт за пределы рабочей области (символическая ссылка); сохранение отменено`);
}

async function assertRealDir(dir: string, ownTmp: boolean): Promise<void> {
  let st: Stats;
  try {
    st = await fs.lstat(dir);
  } catch (e) {
    throw new Error(`каталог ${dir} недоступен: ${errText(e)}`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} — не каталог или символическая ссылка; сохранение отменено`);
  if (ownTmp && typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${dir} принадлежит другому пользователю; сохранение отменено`);
}
