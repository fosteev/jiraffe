import type { InstanceKind } from './types';

export class JiraError extends Error {
  constructor(
    public readonly status: number, // 0 — сеть/таймаут/невалидный ответ
    message: string,
    public readonly url: string,
    /**
     * 'format' — 200, но не JSON (типично: редирект на login.jsp у endpoint'а, которого нет);
     * 'redirect' — сервер увёл на другой origin (http→https, другой хост): fetch снял Authorization.
     */
    public readonly code: 'http' | 'network' | 'format' | 'redirect' = 'http',
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

  private scrub(text: string): string {
    return this.secrets.reduce((t, x) => t.split(x).join('***'), text);
  }
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
