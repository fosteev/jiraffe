import { t } from '../l10n';
import type { InstanceKind } from './types';

/** Хвост сообщения об ошибке записи, после которой запрос мог дойти до Jira (таймаут, обрыв, 5xx прокси, не-JSON 2xx). */
export const maybeSaved = (): string => t('the write may have been saved; check the issue log before retrying');

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
const mb = (n: number): string => t('{0} MB', Math.round((n / 1024 / 1024) * 10) / 10);

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
      return t('Not authorized: check the token (and email for Cloud)') + tail;
    case 403:
      return t('Access denied: the token has no permission for this resource') + tail;
    case 404:
      return t('Not found: check the instance URL and the key');
    default:
      return t('Jira error (HTTP {0})', status) + (details ? ': ' + details : '');
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
    if (this.badToken) throw new JiraError(0, t('The token contains spaces, line breaks or non-ASCII characters. Copy it again.'), url, 'format');
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
          ? t('No response from {0}: timed out', this.baseUrl)
          : t('No connection to {0}: {1}', this.baseUrl, this.scrub(networkReason(e))),
        url,
        'network',
      );
    }
    if (res.redirected && res.url && new URL(res.url).origin !== new URL(url).origin) {
      // Authorization на чужой origin fetch не несёт — дальше был бы непонятный 401 или HTML.
      void res.body?.cancel().catch(() => undefined);
      throw new JiraError(0, t('The server redirected to {0}. Use this instance URL.', new URL(res.url).origin), url, 'redirect');
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new JiraError(0, t('The response from {0} was cut off (timeout or connection lost)', this.baseUrl), url, 'network');
    }
    if (!res.ok) {
      const denied = res.headers.get('x-authentication-denied-reason'); // DC: CAPTCHA после неудачных входов
      const details = [describeBody(text), denied ? `X-Authentication-Denied-Reason: ${denied}` : ''].filter(Boolean).join('; ');
      throw new JiraError(res.status, messageForStatus(res.status, this.scrub(details)), url);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new JiraError(0, t('The response is not JSON. Check the instance URL (a context path such as /jira may be needed).'), url, 'format');
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
    if (!isOwnUrl(url, this.baseUrl)) throw new JiraError(0, t('The URL does not belong to the instance. Authorized download is blocked.'), '', 'blocked');
    if (this.badToken) throw new JiraError(0, t('The token contains spaces, line breaks or non-ASCII characters. Copy it again.'), url, 'format');
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
        throw new JiraError(0, timeout ? t('No response from {0}: timed out', where) : t('No connection to {0}: {1}', where, this.scrub(networkReason(e))), url, 'network');
      }
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        void res.body?.cancel().catch(() => undefined);
        const loc = res.headers.get('location');
        let next: URL;
        try {
          next = new URL(loc ?? '', current);
        } catch {
          throw new JiraError(res.status, t('The server returned an invalid redirect'), url, 'redirect');
        }
        if (!loc) throw new JiraError(res.status, t('The server returned a redirect without a location'), url, 'redirect');
        if (hop >= MAX_REDIRECTS) throw new JiraError(res.status, t('Too many redirects while downloading'), url, 'redirect');
        if (/\/login\.jsp$/i.test(next.pathname)) throw new JiraError(401, t('Jira redirected to the login page. No access to the file, or the token is invalid.'), url);
        if (!isOwnUrl(next.toString(), this.baseUrl) && next.protocol !== 'https:') {
          throw new JiraError(0, t('The server redirected the download to an insecure address ({0}//{1}). Canceled.', next.protocol, next.host), url, 'redirect');
        }
        const base = new URL(this.baseUrl);
        if (!left && base.protocol === 'http:' && next.protocol === 'https:' && next.hostname === base.hostname) {
          // Инстанс заведён по http, а сервер уводит на https: без токена дальше будет невнятная 401 — говорим прямо.
          throw new JiraError(res.status, t('The server redirected to https. Set the instance URL to https://{0} in settings.', next.host), url, 'redirect');
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
        throw new JiraError(0, t('File exceeds the {0} limit ({1})', mb(opts.maxBytes), mb(len)), url, 'limit');
      }
      const bytes = await readLimited(res, opts.maxBytes, () => new JiraError(0, t('File exceeds the {0} limit', mb(opts.maxBytes)), url, 'limit'),
        () => new JiraError(0, t('Download from {0} was cut off (timeout or connection lost)', this.baseUrl), url, 'network'));
      return { bytes, mime: res.headers.get('content-type') ?? '' };
    }
  }

  /**
   * POST с JSON-телом (запись ворклога). Отличия от `getJson`:
   * - адрес — только `baseUrl` + путь, и он обязан пройти `isOwnUrl` (иначе `blocked` без запроса);
   * - `redirect: 'manual'`, **любой 3xx — ошибка** `redirect`: тело записи и `Authorization` никуда не пересылаем
   *   (fetch на 302/303 превратил бы POST в GET и молча «успешно» вернул HTML); `login.jsp` — 401;
   * - обрыв или таймаут после отправки — «запись могла сохраниться»: повторять только после проверки журнала.
   * Пустой ответ (204) — `undefined`. В сообщения не попадают ни токен, ни тело запроса.
   */
  async postJson<T>(path: string, body: unknown, query?: Query): Promise<T | undefined> {
    const url = this.url(path, query);
    if (!isOwnUrl(url, this.baseUrl)) throw new JiraError(0, t('The URL does not belong to the instance. Authorized request is blocked.'), '', 'blocked');
    if (this.badToken) throw new JiraError(0, t('The token contains spaces, line breaks or non-ASCII characters. Copy it again.'), url, 'format');
    const saved = maybeSaved();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: this.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      // Соединение не установлено (отказ, DNS, сертификат) — запрос точно не ушёл; иначе (сброс и т. п.) — мог уйти.
      const notSent = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|CERT|SIGNATURE|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(networkReason(e));
      throw new JiraError(
        0,
        timeout
          ? t('No response from {0}: timed out; {1}', this.baseUrl, saved)
          : t('No connection to {0}: {1}', this.baseUrl, this.scrub(networkReason(e))) + (notSent ? '' : `; ${saved}`),
        url,
        'network',
      );
    }
    if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
      void res.body?.cancel().catch(() => undefined);
      const loc = res.headers.get('location') ?? '';
      if (/\/login\.jsp(?:[?#]|$)/i.test(loc)) throw new JiraError(401, t('Jira redirected to the login page. The token is invalid or lacks write access.'), url);
      throw new JiraError(res.status, t('The server redirected a write request. Request canceled; check the instance URL (https, context path).'), url, 'redirect');
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new JiraError(0, t('The response from {0} was cut off; {1}', this.baseUrl, saved), url, 'network');
    }
    if (!res.ok) {
      const denied = res.headers.get('x-authentication-denied-reason');
      const details = [describeBody(text), denied ? `X-Authentication-Denied-Reason: ${denied}` : ''].filter(Boolean).join('; ');
      // 502/503/504 — ответил прокси перед Jira, сама Jira запрос могла дописать: та же неоднозначность, что и таймаут.
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        throw new JiraError(res.status, `${messageForStatus(res.status, this.scrub(details))}; ${saved}`, url, 'network');
      }
      throw new JiraError(res.status, messageForStatus(res.status, this.scrub(details)), url);
    }
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      // 2xx, но не JSON: запись, скорее всего, прошла — сообщаем, но не как «не сохранено».
      throw new JiraError(0, t('The write response is not JSON; {0}', saved), url, 'format');
    }
  }

  private scrub(text: string): string {
    return this.secrets.reduce((acc, x) => acc.split(x).join('***'), text);
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return t('the server');
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
    ? t('{0}. The server certificate is not trusted. A corporate CA can be added via NODE_EXTRA_CA_CERTS.', reason)
    : reason;
}
