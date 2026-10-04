import type { InstanceKind } from './types';

export class JiraError extends Error {
  constructor(
    public readonly status: number, // 0 — сеть/таймаут/невалидный ответ
    message: string,
    public readonly url: string,
    /**
     * 'format' — 200, но не JSON (типично: редирект на login.jsp у endpoint'а, которого нет);
     * 'redirect' — сервер увёл на другой origin (http→https, другой хост): fetch снял Authorization.
     * 'blocked' — адрес не принадлежит инстансу (чужой origin/вне context path): авторизованный запрос не отправлен.
     * 'limit' — ответ больше разрешённого размера, скачивание оборвано.
     */
    public readonly code: 'http' | 'network' | 'format' | 'redirect' | 'blocked' | 'limit' = 'http',
  ) {
    super(message);
    this.name = 'JiraError';
  }
}

export interface HttpOptions {
  baseUrl: string;
  kind: InstanceKind;
  token: string;
  email?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type Query = Record<string, string | number | undefined>;

/** Убирает хвостовые слэши; context path (`/jira`) сохраняется. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Страницы UI Jira, после которых начинается не context path, а путь внутри приложения. */
const APP_PATH = /\/(browse|secure|projects|issues|plugins|rest|servicedesk|login\.jsp)(\/|$)/i;

/**
 * Адрес инстанса из того, что вставил пользователь: без query/hash, без хвоста страницы UI
 * (`/browse/KEY-1`, `/secure/Dashboard.jspa`), без хвостовых слэшей. Cloud (`*.atlassian.net`) — только origin.
 */
export function canonicalBaseUrl(input: string): string {
  const u = new URL(input.trim());
  if (u.hostname.endsWith('.atlassian.net')) return u.origin;
  const m = APP_PATH.exec(u.pathname);
  const path = m ? u.pathname.slice(0, m.index) : u.pathname;
  return normalizeBaseUrl(u.origin + path);
}

/**
 * Адрес принадлежит инстансу: http(s), тот же origin и путь под context path `baseUrl`.
 * Только на такие адреса уходит `Authorization` (атрибутам из HTML Jira и полям ответа не доверяем).
 */
export function isOwnUrl(url: string, baseUrl: string): boolean {
  try {
    const u = new URL(url);
    const base = new URL(normalizeBaseUrl(baseUrl));
    const root = base.pathname.replace(/\/*$/, '/');
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === base.origin && !u.username && !u.password && u.pathname.startsWith(root);
  } catch {
    return false;
  }
}

export interface BinaryResult {
  bytes: Uint8Array;
  /** Content-Type ответа — как есть, НЕ доверенный: тип картинки определяется по сигнатуре, «текст ли» — по имени и содержимому. */
  mime: string;
}

export interface BinaryOptions {
  maxBytes: number;
  timeoutMs?: number;
}

const MAX_REDIRECTS = 5;
const mb = (n: number): string => `${Math.round((n / 1024 / 1024) * 10) / 10} МБ`;

export function authHeader(kind: InstanceKind, token: string, email?: string): string {
  if (kind === 'cloud') {
    return 'Basic ' + Buffer.from(`${email ?? ''}:${token}`).toString('base64');
  }
  return `Bearer ${token}`;
}

function describeBody(text: string): string {
  try {
    const j = JSON.parse(text) as { errorMessages?: unknown; errors?: unknown; message?: unknown };
    const parts: string[] = [];
    if (Array.isArray(j.errorMessages)) parts.push(...j.errorMessages.map(String));
    if (j.errors && typeof j.errors === 'object') parts.push(...Object.values(j.errors).map(String));
    if (typeof j.message === 'string') parts.push(j.message);
    return parts.join('; ');
  } catch {
    return '';
  }
}

export function messageForStatus(status: number, details: string): string {
  const tail = details ? ` (${details})` : '';
  switch (status) {
    case 401:
      return 'Не авторизован: проверьте токен (для Cloud — и email)' + tail;
    case 403:
      return 'Доступ запрещён: у токена нет прав на этот ресурс' + tail;
    case 404:
      return 'Не найдено: проверьте адрес инстанса и ключ';
    default:
      return `Ошибка Jira (HTTP ${status})${details ? ': ' + details : ''}`;
  }
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /** Строки, которые не должны попасть ни в одно сообщение об ошибке. */
  private readonly secrets: string[];
  private readonly badToken: boolean;

  constructor(opts: HttpOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    const token = opts.token.trim();
    // Пробел/перевод строки/не-ASCII в токене undici отвергает с текстом заголовка в сообщении — ловим заранее.
    this.badToken = !/^[\x21-\x7e]+$/.test(token);
    this.auth = authHeader(opts.kind, token, opts.email?.trim());
    this.secrets = [this.auth, token, this.auth.replace(/^\S+ /, '')].filter((x) => x.length >= 4);
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  url(path: string, query?: Query): string {
    const u = this.baseUrl + (path.startsWith('/') ? path : '/' + path);
    if (!query) return u;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    const s = qs.toString();
    return s ? `${u}?${s}` : u;
  }

  /** GET с разбором JSON. Токен в сообщения и url не попадает. */
  async getJson<T>(path: string, query?: Query): Promise<T> {
    const url = this.url(path, query);
    if (this.badToken) throw new JiraError(0, 'Токен содержит пробелы, переводы строк или не-ASCII символы — скопируйте его заново', url, 'format');
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: this.auth, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new JiraError(
        0,
        timeout
          ? `Нет ответа от ${this.baseUrl}: превышено время ожидания`
          : `Нет соединения с ${this.baseUrl}: ${this.scrub(networkReason(e))}`,
        url,
        'network',
      );
    }
    if (res.redirected && res.url && new URL(res.url).origin !== new URL(url).origin) {
      // Authorization на чужой origin fetch не несёт — дальше был бы непонятный 401 или HTML.
      void res.body?.cancel().catch(() => undefined);
      throw new JiraError(0, `Сервер перенаправил на ${new URL(res.url).origin} — укажите этот адрес инстанса`, url, 'redirect');
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new JiraError(0, `Ответ от ${this.baseUrl} оборвался (превышено время ожидания или разрыв соединения)`, url, 'network');
    }
    if (!res.ok) {
      const denied = res.headers.get('x-authentication-denied-reason'); // DC: CAPTCHA после неудачных входов
      const details = [describeBody(text), denied ? `X-Authentication-Denied-Reason: ${denied}` : ''].filter(Boolean).join('; ');
      throw new JiraError(res.status, messageForStatus(res.status, this.scrub(details)), url);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new JiraError(0, 'Ответ не похож на JSON: проверьте адрес инстанса (возможно, нужен context path, например /jira)', url, 'format');
    }
  }

  /**
   * Бинарный GET (вложения, превью). Отличия от `getJson`:
   * - адрес — абсолютный и обязан принадлежать инстансу (`isOwnUrl`), иначе `blocked` без запроса;
   * - редиректы ведём сами (`redirect: 'manual'`): `Authorization` — только на адреса инстанса; на чужой origin
   *   (Cloud: `api.media.atlassian.com` с подписанной ссылкой) идём только по https и БЕЗ авторизации;
   *   редирект на `login.jsp` — ошибка «нет доступа», а не HTML вместо файла;
   * - тело читается потоком до `maxBytes` (Content-Length сверх лимита — отказ до чтения), дальше — обрыв с `limit`.
   * В сообщения об ошибках не попадают ни токен, ни адреса редиректов (в подписанной ссылке свой токен).
   */
  async getBinary(url: string, opts: BinaryOptions): Promise<BinaryResult> {
    if (!isOwnUrl(url, this.baseUrl)) throw new JiraError(0, 'Адрес не относится к инстансу — скачивание с авторизацией запрещено', '', 'blocked');
    if (this.badToken) throw new JiraError(0, 'Токен содержит пробелы, переводы строк или не-ASCII символы — скопируйте его заново', url, 'format');
    const signal = AbortSignal.timeout(opts.timeoutMs ?? Math.max(this.timeoutMs, 120_000));
    let current = url;
    // Покинув инстанс, цепочка больше не получает Authorization — даже если чужой хост вернул её на адрес инстанса.
    let left = false;
    for (let hop = 0; ; hop++) {
      const own = !left && isOwnUrl(current, this.baseUrl);
      let res: Response;
      try {
        res = await this.fetchImpl(current, {
          method: 'GET',
          headers: own ? { Authorization: this.auth, Accept: '*/*' } : { Accept: '*/*' },
          redirect: 'manual',
          signal,
        });
      } catch (e) {
        const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
        const where = own ? this.baseUrl : safeOrigin(current);
        throw new JiraError(0, timeout ? `Нет ответа от ${where}: превышено время ожидания` : `Нет соединения с ${where}: ${this.scrub(networkReason(e))}`, url, 'network');
      }
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        void res.body?.cancel().catch(() => undefined);
        const loc = res.headers.get('location');
        let next: URL;
        try {
          next = new URL(loc ?? '', current);
        } catch {
          throw new JiraError(res.status, 'Сервер вернул некорректный редирект', url, 'redirect');
        }
        if (!loc) throw new JiraError(res.status, 'Сервер вернул перенаправление без адреса', url, 'redirect');
        if (hop >= MAX_REDIRECTS) throw new JiraError(res.status, 'Слишком много перенаправлений при скачивании', url, 'redirect');
        if (/\/login\.jsp$/i.test(next.pathname)) throw new JiraError(401, 'Jira перенаправила на страницу входа — нет доступа к файлу или токен недействителен', url);
        if (!isOwnUrl(next.toString(), this.baseUrl) && next.protocol !== 'https:') {
          throw new JiraError(0, `Сервер перенаправил скачивание на небезопасный адрес (${next.protocol}//${next.host}) — отменено`, url, 'redirect');
        }
        const base = new URL(this.baseUrl);
        if (!left && base.protocol === 'http:' && next.protocol === 'https:' && next.hostname === base.hostname) {
          // Инстанс заведён по http, а сервер уводит на https: без токена дальше будет невнятная 401 — говорим прямо.
          throw new JiraError(res.status, `Сервер перенаправил на https — укажите в настройках инстанса адрес https://${next.host}`, url, 'redirect');
        }
        if (!isOwnUrl(next.toString(), this.baseUrl)) left = true;
        current = next.toString();
        continue;
      }
      if (!res.ok) {
        let details = '';
        try {
          if (own) details = describeBody((await res.text()).slice(0, 4096));
          else void res.body?.cancel().catch(() => undefined);
        } catch { /* тело ошибки не важно */ }
        throw new JiraError(res.status, messageForStatus(res.status, this.scrub(details)), url);
      }
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > opts.maxBytes) {
        void res.body?.cancel().catch(() => undefined);
        throw new JiraError(0, `Файл больше лимита ${mb(opts.maxBytes)} (${mb(len)})`, url, 'limit');
      }
      const bytes = await readLimited(res, opts.maxBytes, () => new JiraError(0, `Файл больше лимита ${mb(opts.maxBytes)}`, url, 'limit'),
        () => new JiraError(0, `Скачивание с ${this.baseUrl} оборвалось (превышено время ожидания или разрыв соединения)`, url, 'network'));
      return { bytes, mime: res.headers.get('content-type') ?? '' };
    }
  }

  private scrub(text: string): string {
    return this.secrets.reduce((t, x) => t.split(x).join('***'), text);
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'сервера';
  }
}

/** Читает тело потоком, не больше `max` байт: превышение — `tooLarge()`, обрыв — `broken()`. */
async function readLimited(res: Response, max: number, tooLarge: () => Error, broken: () => Error): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let r: ReadableStreamReadResult<Uint8Array>;
    try {
      r = await reader.read();
    } catch {
      throw broken();
    }
    if (r.done) break;
    total += r.value.byteLength;
    if (total > max) {
      void reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(r.value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** undici прячет причину («fetch failed») в `cause`: код ошибки сокета/TLS — самое полезное. */
function networkReason(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: { code?: unknown; message?: unknown } }).cause;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  const msg = typeof cause?.message === 'string' ? cause.message : '';
  const reason = [e.message, code || msg].filter(Boolean).join(': ');
  return /CERT|SIGNATURE|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code + msg)
    ? `${reason} — сертификат сервера не доверен; корпоративный CA можно подключить через NODE_EXTRA_CA_CERTS`
    : reason;
}
