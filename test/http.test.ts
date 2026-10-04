import { describe, expect, it } from 'vitest';
import { HttpClient, JiraError, authHeader, canonicalBaseUrl, normalizeBaseUrl } from '../src/jira/http';

function mockFetch(status: number, body: unknown, calls: { url: string; init: RequestInit }[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

const fail = (p: Promise<unknown>): Promise<JiraError> =>
  p.then(() => { throw new Error('ожидалась ошибка'); }, (e: unknown) => e as JiraError);

describe('authHeader', () => {
  it('DC — Bearer', () => expect(authHeader('dc', 'tok')).toBe('Bearer tok'));
  it('Cloud — Basic email:token', () => {
    expect(authHeader('cloud', 'tok', 'u@example.com')).toBe('Basic ' + Buffer.from('u@example.com:tok').toString('base64'));
  });
});

describe('HttpClient', () => {
  it('шлёт заголовки DC и учитывает context path', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const http = new HttpClient({ baseUrl: 'https://host.example/jira/', kind: 'dc', token: 'tok', fetchImpl: mockFetch(200, { ok: 1 }, calls) });
    expect(await http.getJson('/rest/api/2/myself', { a: 1, b: undefined })).toEqual({ ok: 1 });
    expect(calls[0].url).toBe('https://host.example/jira/rest/api/2/myself?a=1');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(calls[0].init.method).toBe('GET');
  });

  it('шлёт Basic для Cloud', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const http = new HttpClient({ baseUrl: 'https://x.example', kind: 'cloud', token: 't', email: 'a@b.c', fetchImpl: mockFetch(200, {}, calls) });
    await http.getJson('/rest/api/2/myself');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it.each([
    [401, /Не авторизован/],
    [403, /Доступ запрещён/],
    [404, /Не найдено/],
    [500, /HTTP 500\): boom/],
  ])('статус %i → JiraError с русским сообщением', async (status, re) => {
    const http = new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 'SECRET', fetchImpl: mockFetch(status, { errorMessages: ['boom'] }) });
    const err = await fail(http.getJson('/p'));
    expect(err).toBeInstanceOf(JiraError);
    expect(err.status).toBe(status);
    expect(err.message).toMatch(re);
    expect(err.url).toBe('https://x.example/p');
    expect(err.message + err.url).not.toContain('SECRET');
  });

  it('сетевая ошибка → status 0', async () => {
    const f = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const err = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 't', fetchImpl: f }).getJson('/p'));
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/Нет соединения/);
  });

  it('не-JSON при 200 → понятная ошибка', async () => {
    const err = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 't', fetchImpl: mockFetch(200, '<html>') }).getJson('/p'));
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/JSON/);
  });

  it('normalizeBaseUrl убирает хвостовые слэши', () => {
    expect(normalizeBaseUrl(' https://h/jira// ')).toBe('https://h/jira');
  });

  it('обрыв тела ответа → JiraError network', async () => {
    const f = (async () => ({ ok: true, status: 200, text: async () => { throw new DOMException('aborted', 'TimeoutError'); } })) as unknown as typeof fetch;
    const err = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 't', fetchImpl: f }).getJson('/p'));
    expect(err).toBeInstanceOf(JiraError);
    expect(err.code).toBe('network');
  });
});

describe('HttpClient: безопасность и диагностика', () => {
  type Fake = { status?: number; ok?: boolean; headers?: Headers; redirected?: boolean; url?: string; body?: string };
  const fake = ({ body, ...r }: Fake) =>
    (async () => ({ ok: (r.status ?? 200) < 300, status: 200, headers: new Headers(), redirected: false, url: '', text: async () => body ?? '{}', ...r })) as unknown as typeof fetch;

  it('токен с \\r\\n обрезается; с пробелом внутри — понятная ошибка без токена', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 'SECRET123\r\n', fetchImpl: mockFetch(200, {}, calls) }).getJson('/p');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer SECRET123');
    const err = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 'SEC RET123', fetchImpl: mockFetch(200, {}) }).getJson('/p'));
    expect(err.message).toMatch(/Токен содержит/);
    expect(err.message).not.toContain('RET123');
  });

  it('токен вычищается из текста сетевой ошибки', async () => {
    const f = (async () => { throw new TypeError('Headers.append: "Bearer SECRET123" is an invalid header value'); }) as unknown as typeof fetch;
    const err = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 'SECRET123', fetchImpl: f }).getJson('/p'));
    expect(err.message).not.toContain('SECRET123');
  });

  it('cause сетевой ошибки попадает в сообщение, на TLS — подсказка про CA', async () => {
    const f = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }); }) as unknown as typeof fetch;
    const err = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 't', fetchImpl: f }).getJson('/p'));
    expect(err.message).toMatch(/DEPTH_ZERO_SELF_SIGNED_CERT.*NODE_EXTRA_CA_CERTS/);
  });

  it('редирект на другой origin → JiraError redirect; на тот же — обычная обработка', async () => {
    const cross = await fail(new HttpClient({ baseUrl: 'http://x.example', kind: 'dc', token: 't', fetchImpl: fake({ redirected: true, url: 'https://x.example/p' }) }).getJson('/p'));
    expect(cross.code).toBe('redirect');
    expect(cross.message).toContain('https://x.example');
    const same = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 't', fetchImpl: fake({ redirected: true, url: 'https://x.example/login.jsp', body: '<html>' }) }).getJson('/p'));
    expect(same.code).toBe('format');
  });

  it('401: errorMessages и X-Authentication-Denied-Reason в сообщении', async () => {
    const err = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 't',
      fetchImpl: fake({ status: 401, ok: false, headers: new Headers({ 'X-Authentication-Denied-Reason': 'CAPTCHA_CHALLENGE' }), body: '{"errorMessages":["nope"]}' }) }).getJson('/p'));
    expect(err.message).toMatch(/Не авторизован.*nope.*CAPTCHA_CHALLENGE/);
  });
});

describe('canonicalBaseUrl', () => {
  it.each([
    ['https://h.example/jira/', 'https://h.example/jira'],
    ['  https://H.example/jira/browse/ABC-1?focusedId=1#c  ', 'https://h.example/jira'],
    ['https://h.example/secure/Dashboard.jspa', 'https://h.example'],
    ['https://h.example/jira/projects/ABC/issues', 'https://h.example/jira'],
    ['https://h.example:8443/login.jsp', 'https://h.example:8443'],
    ['https://h.example/browser-jira', 'https://h.example/browser-jira'],
    ['https://x.atlassian.net/jira/software/projects/ABC/boards/1', 'https://x.atlassian.net'],
    ['https://user:pw@h.example/jira', 'https://h.example/jira'],
  ])('%s → %s', (input, out) => expect(canonicalBaseUrl(input)).toBe(out));
});
