// Журнал работ и Tempo (этап 6): payload'ы записи — только на моке fetch, живые Jira не трогаем.
import { describe, expect, it } from 'vitest';
import { createJiraClient, type MyselfInfo } from '../src/jira/client';
import { HttpClient, JiraError } from '../src/jira/http';
import { findAiTokensAttr, mapTempoWorklog, mapWorkAttribute, TempoClient, tempoPayload, withTempoAttributes, type WorkAttribute } from '../src/jira/tempo';
import type { Instance, Worklog } from '../src/jira/types';
import {
  appendAiTokens, isIsoDate, loadToday, localDate, logFormFor, mineOn, parseTokens, remainingAfter, startedWithOffset, submitWorklog, sumToday, validateDraft,
  type LogForm, type TodayInstance,
} from '../src/jira/worklog';
import type { IssueCard, TodayView } from '../src/panels/protocol';
import { statusBarLines, statusBarText, TodayService } from '../src/state/today';
import { renderLogDialog, renderWorklog } from '../webview/render';
import { dayLabel, renderToday } from '../webview/today';

const TOKEN = 'secret-token-123';

interface Call { url: URL; method: string; body?: unknown; headers: Record<string, string>; redirect?: string }
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

function mockClient(kind: 'dc' | 'cloud', route: (c: Call) => Reply, baseUrl = 'https://jira.example.test/jira') {
  const calls: Call[] = [];
  const fetchImpl = (async (u: string, init: RequestInit = {}) => {
    const c: Call = {
      url: new URL(u), method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, redirect: init.redirect,
      ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    };
    calls.push(c);
    const r = route(c);
    if (!r) return new Response('{"errorMessages":["nope"]}', { status: 404 });
    const text = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(r.status === 204 ? null : text, { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { client: createJiraClient({ id: 'i1', kind, baseUrl, email: 'a@example.test' }, TOKEN, { fetchImpl }), calls };
}

const AI: WorkAttribute = { key: '_AITokensUsed_', name: 'AI Tokens', type: 'INPUT_NUMERIC', kind: 'number', required: false };
const LIST: WorkAttribute = { key: '_Kind_', name: 'Тип работ', type: 'STATIC_LIST', kind: 'list', required: true, values: [{ value: 'dev', name: 'Разработка' }, { value: 'review', name: 'Ревью' }] };

describe('атрибуты Tempo', () => {
  it('формат живого ответа work-attribute (type — объект с value)', () => {
    const a = mapWorkAttribute({ id: 1, key: '_AITokensUsed_', name: 'AI Tokens', type: { name: 'Числовое поле ввода', value: 'INPUT_NUMERIC', systemType: false }, required: false, sequence: 0 });
    expect(a).toEqual(AI);
    expect(findAiTokensAttr([a!])?.key).toBe('_AITokensUsed_');
    expect(findAiTokensAttr([{ ...AI, key: '_x_', name: ' ai tokens ' }])?.key).toBe('_x_');
  });
  it('STATIC_LIST: без удалённых, по sequence; неизвестный тип — unsupported', () => {
    const a = mapWorkAttribute({ key: 'k', name: 'K', type: { value: 'STATIC_LIST' }, required: true, staticListValues: [
      { value: 'b', name: 'B', sequence: 2 }, { value: 'x', name: 'X', removed: true, sequence: 0 }, { value: 'a', name: 'A', sequence: 1 },
    ] });
    expect(a?.values).toEqual([{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }]);
    expect(mapWorkAttribute({ key: 'acc', name: 'Account', type: { value: 'ACCOUNT' } })?.kind).toBe('unsupported');
    expect(mapWorkAttribute({ name: 'без ключа' })).toBeUndefined();
  });
  it('форма: AI Tokens — атрибут, неподдержанный обязательный — предупреждение; без Tempo — без атрибутов', () => {
    const acc: WorkAttribute = { key: 'acc', name: 'Account', type: 'ACCOUNT', kind: 'unsupported', required: true };
    const f = logFormFor(true, [LIST, AI, acc]);
    expect(f).toEqual({ tempo: true, attributes: [LIST, AI], aiTokensAttr: '_AITokensUsed_', unsupportedRequired: ['Account'] });
    expect(logFormFor(false, [AI])).toEqual({ tempo: false, attributes: [], unsupportedRequired: [] });
  });
});

describe('payload Tempo', () => {
  it('как cmd_worklog: issue.remainingEstimateSeconds, author.name, dateStarted без зоны, worklogAttributes', () => {
    const p = tempoPayload({ issueKey: 'ABC-123', author: 'ivan', date: '2026-10-04', timeSpentSec: 5400, comment: 'сделано', attributes: { _AITokensUsed_: '120000', empty: '' }, remainingEstimateSec: 1800 });
    expect(p).toEqual({
      issue: { key: 'ABC-123', remainingEstimateSeconds: 1800 },
      author: { name: 'ivan' },
      timeSpentSeconds: 5400,
      dateStarted: '2026-10-04T12:00:00.000',
      comment: 'сделано',
      worklogAttributes: [{ key: '_AITokensUsed_', value: '120000' }],
    });
    expect(String(p.dateStarted)).not.toMatch(/[+-]\d{4}$|Z$/);
  });
  it('без комментария и атрибутов — полей нет; остаток не отрицательный', () => {
    const p = tempoPayload({ issueKey: 'ABC-1', author: 'ivan', date: '2026-01-02', timeSpentSec: 60, comment: '', attributes: {}, remainingEstimateSec: -5 });
    expect(p).not.toHaveProperty('comment');
    expect(p).not.toHaveProperty('worklogAttributes');
    expect((p.issue as { remainingEstimateSeconds: number }).remainingEstimateSeconds).toBe(0);
  });
  it('remainingAfter = max(remaining − spent, 0)', () => {
    expect(remainingAfter(7200, 5400)).toBe(1800);
    expect(remainingAfter(3600, 5400)).toBe(0);
    expect(remainingAfter(undefined, 60)).toBe(0);
  });

  it('submitWorklog на Tempo: /myself + свежий timetracking → POST tempo v3, AI Tokens — атрибутом', async () => {
    const { client, calls } = mockClient('dc', (c) => {
      const p = c.url.pathname;
      if (p.endsWith('/rest/api/2/myself')) return { body: { name: 'ivan', displayName: 'Ivan Petrov' } };
      if (p.endsWith('/rest/api/2/issue/ABC-123')) return { body: { fields: { timetracking: { remainingEstimateSeconds: 36000, timeSpentSeconds: 100 } } } };
      if (p.endsWith('/rest/tempo-timesheets/3/worklogs/') && c.method === 'POST') return { body: [{ id: 777 }] };
      return undefined;
    });
    const form: LogForm = logFormFor(true, [LIST, AI]);
    const r = await submitWorklog(client, 'ABC-123', form, { timeSpentSec: 5400, date: '2026-10-04', comment: 'c', aiTokens: 120000, attributes: { _Kind_: 'dev' } });
    expect(r).toEqual({ via: 'tempo', id: '777' });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url.pathname).toBe('/jira/rest/tempo-timesheets/3/worklogs/');
    expect(post.redirect).toBe('manual');
    expect(post.headers['Content-Type']).toBe('application/json');
    expect(post.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(post.body).toEqual({
      issue: { key: 'ABC-123', remainingEstimateSeconds: 36000 - 5400 },
      author: { name: 'ivan' }, timeSpentSeconds: 5400, dateStarted: '2026-10-04T12:00:00.000', comment: 'c',
      worklogAttributes: [{ key: '_Kind_', value: 'dev' }, { key: '_AITokensUsed_', value: '120000' }],
    });
    expect(calls.find((c) => c.url.pathname.endsWith('/issue/ABC-123'))?.url.searchParams.get('fields')).toBe('timetracking');
  });
  it('Tempo без атрибута AI Tokens — «(AI Tokens: N)» в комментарий', async () => {
    const { client, calls } = mockClient('dc', (c) => {
      if (c.url.pathname.endsWith('/myself')) return { body: { name: 'ivan' } };
      if (c.url.pathname.endsWith('/issue/ABC-1')) return { body: { fields: { timetracking: {} } } };
      if (c.method === 'POST') return { body: { id: 1 } };
      return undefined;
    });
    await submitWorklog(client, 'ABC-1', logFormFor(true, []), { timeSpentSec: 60, date: '2026-10-04', comment: '', aiTokens: 5, attributes: {} });
    const body = calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
    expect(body.comment).toBe('(AI Tokens: 5)');
    expect(body).not.toHaveProperty('worklogAttributes');
    expect((body.issue as Record<string, unknown>).remainingEstimateSeconds).toBe(0);
  });
});

describe('payload стандартный', () => {
  it('started — полдень с локальным смещением', () => {
    const s = startedWithOffset('2026-10-04');
    expect(s).toMatch(/^2026-10-04T12:00:00\.000[+-]\d{4}$/);
    const off = -new Date(2026, 9, 4, 12).getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    expect(s.slice(-5)).toBe(`${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`);
  });
  it('started — смещение на выбранную дату (DST), без двоеточия; localDate — по локальному поясу', () => {
    const prev = process.env.TZ;
    try {
      process.env.TZ = 'Europe/Berlin';
      expect(startedWithOffset('2026-07-01')).toBe('2026-07-01T12:00:00.000+0200');
      expect(startedWithOffset('2026-12-01')).toBe('2026-12-01T12:00:00.000+0100');
      expect(startedWithOffset('2026-10-25')).toBe('2026-10-25T12:00:00.000+0100'); // день перевода часов
      process.env.TZ = 'America/St_Johns';
      expect(startedWithOffset('2026-12-01')).toBe('2026-12-01T12:00:00.000-0330');
      process.env.TZ = 'Europe/Moscow';
      expect(localDate(new Date('2026-10-04T22:30:00Z'))).toBe('2026-10-05'); // 01:30 по Москве — уже завтра, не UTC
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });
  it('POST /issue/{key}/worklog?adjustEstimate=leave, AI Tokens в конце комментария', async () => {
    const { client, calls } = mockClient('dc', (c) => (c.method === 'POST' ? { status: 201, body: { id: '10001' } } : undefined));
    const r = await submitWorklog(client, 'ABC-123', logFormFor(false, []), { timeSpentSec: 5400, date: '2026-10-04', comment: 'Ревью', aiTokens: 120000, attributes: {} });
    expect(r).toEqual({ via: 'jira', id: '10001' });
    const post = calls[0];
    expect(calls).toHaveLength(1); // без /myself и timetracking
    expect(post.url.pathname).toBe('/jira/rest/api/2/issue/ABC-123/worklog');
    expect(post.url.searchParams.get('adjustEstimate')).toBe('leave');
    expect(post.body).toEqual({ started: startedWithOffset('2026-10-04'), timeSpentSeconds: 5400, comment: 'Ревью (AI Tokens: 120000)' });
  });
  it('Cloud: тот же путь (Basic), без комментария — поля нет', async () => {
    const { client, calls } = mockClient('cloud', (c) => (c.method === 'POST' ? { body: { id: 5 } } : undefined), 'https://x.atlassian.net');
    await submitWorklog(client, 'ABC-2', logFormFor(false, []), { timeSpentSec: 900, date: '2026-10-04', comment: '', attributes: {} });
    expect(calls[0].headers.Authorization).toMatch(/^Basic /);
    expect(calls[0].body).toEqual({ started: startedWithOffset('2026-10-04'), timeSpentSeconds: 900 });
  });
  it('appendAiTokens', () => {
    expect(appendAiTokens('', 3)).toBe('(AI Tokens: 3)');
    expect(appendAiTokens('done', 3)).toBe('done (AI Tokens: 3)');
  });
});

describe('HttpClient.postJson', () => {
  const http = (route: (url: string, init: RequestInit) => Response | Promise<Response>) =>
    new HttpClient({ baseUrl: 'https://jira.example.test/jira', kind: 'dc', token: TOKEN, fetchImpl: ((u: string, i: RequestInit) => route(u, i)) as unknown as typeof fetch });
  it('3xx — ошибка redirect, по Location не идём; login.jsp — 401', async () => {
    let n = 0;
    const h = http(() => { n++; return new Response(null, { status: 302, headers: { location: 'https://evil.example.test/x' } }); });
    await expect(h.postJson('/rest/x', {})).rejects.toMatchObject({ code: 'redirect' });
    expect(n).toBe(1);
    const h2 = http(() => new Response(null, { status: 302, headers: { location: '/jira/login.jsp?os_destination=x' } }));
    await expect(h2.postJson('/rest/x', {})).rejects.toMatchObject({ status: 401 });
  });
  it('таймаут — «запись могла сохраниться», токена в тексте нет', async () => {
    const h = http(() => { const e = new Error(`boom ${TOKEN}`); e.name = 'TimeoutError'; throw e; });
    const err = (await h.postJson('/rest/x', { a: 1 }).then(() => undefined, (e: unknown) => e)) as JiraError;
    expect(err).toBeInstanceOf(JiraError);
    expect(err.message).toMatch(/may have been saved/);
    expect(err.message).not.toContain(TOKEN);
    const h2 = http(() => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET', message: TOKEN } }); });
    const e2 = (await h2.postJson('/rest/x', {}).then(() => undefined, (e: unknown) => e)) as JiraError;
    expect(e2.message).not.toContain(TOKEN);
    expect(e2.message).toMatch(/may have been saved/); // сброс соединения — запрос мог уйти
    const h3 = http(() => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
    const e3 = (await h3.postJson('/rest/x', {}).then(() => undefined, (e: unknown) => e)) as JiraError;
    expect(e3.message).not.toMatch(/may have been saved/); // соединения не было — запись точно не ушла
  });
  it('502/503/504 прокси — «запись могла сохраниться» (code network); 500 — обычная ошибка', async () => {
    const h = http(() => new Response('<html>Gateway Timeout</html>', { status: 504 }));
    const e = (await h.postJson('/rest/x', {}).then(() => undefined, (x: unknown) => x)) as JiraError;
    expect(e).toMatchObject({ status: 504, code: 'network' });
    expect(e.message).toMatch(/may have been saved/);
    const h2 = http(() => new Response('{"errorMessages":["boom"]}', { status: 500 }));
    const e2 = (await h2.postJson('/rest/x', {}).then(() => undefined, (x: unknown) => x)) as JiraError;
    expect(e2.code).toBe('http');
    expect(e2.message).not.toMatch(/may have been saved/);
  });
  it('400 с errors Tempo — текст в сообщении; 204 — undefined', async () => {
    const h = http(() => new Response(JSON.stringify({ errors: { user: 'Пользователь недействителен' } }), { status: 400 }));
    await expect(h.postJson('/rest/x', {})).rejects.toThrow(/Пользователь недействителен/);
    const h2 = http(() => new Response(null, { status: 204 }));
    await expect(h2.postJson('/rest/x', {})).resolves.toBeUndefined();
  });
  it('адрес вне инстанса не отправляется', async () => {
    let n = 0;
    const h = http(() => { n++; return new Response('{}'); });
    await expect(h.postJson('/../../evil', {})).rejects.toMatchObject({ code: 'blocked' }); // путь вышел из context path
    expect(n).toBe(0);
    let sent = '';
    const h2 = http((u) => { sent = u; return new Response('{}'); });
    await h2.postJson('/rest/api/2/issue/ABC-1/worklog', {}, { adjustEstimate: 'leave' });
    expect(sent).toBe('https://jira.example.test/jira/rest/api/2/issue/ABC-1/worklog?adjustEstimate=leave');
  });
});

describe('проверка формы (validateDraft)', () => {
  const form = logFormFor(true, [LIST, AI]);
  const ok = { duration: '1ч 30м', date: '2026-10-04', comment: ' c ', aiTokens: '120 000', attributes: { _Kind_: 'dev' } };
  it('валидная форма → запрос', () => {
    expect(validateDraft(ok, form)).toEqual({ ok: true, req: { timeSpentSec: 5400, date: '2026-10-04', comment: 'c', aiTokens: 120000, attributes: { _Kind_: 'dev' } } });
  });
  it('ошибки с полем', () => {
    expect(validateDraft({ ...ok, duration: 'полтора' }, form)).toMatchObject({ ok: false, field: 'duration' });
    expect(validateDraft({ ...ok, duration: '25h' }, form)).toMatchObject({ ok: false, field: 'duration' });
    expect(validateDraft({ ...ok, date: '2026-02-30' }, form)).toMatchObject({ ok: false, field: 'date' });
    expect(validateDraft({ ...ok, aiTokens: '12k' }, form)).toMatchObject({ ok: false, field: 'aiTokens' });
    expect(validateDraft({ ...ok, attributes: {} }, form)).toMatchObject({ ok: false, field: 'attr:_Kind_' });
    expect(validateDraft({ ...ok, attributes: { _Kind_: 'hack' } }, form)).toMatchObject({ ok: false, field: 'attr:_Kind_' });
    expect(validateDraft({ ...ok, comment: 'x'.repeat(30_001) }, form)).toMatchObject({ ok: false, field: 'comment' });
    expect(validateDraft(null, form)).toMatchObject({ ok: false, field: 'duration' });
    expect(validateDraft({ ...ok, duration: 5400 }, form)).toMatchObject({ ok: false, field: 'duration' });
    expect(validateDraft({ ...ok, date: '2026-10-05' }, form, '2026-10-04')).toMatchObject({ ok: false, field: 'date' }); // будущее
    expect(validateDraft({ ...ok, date: '2026-10-04' }, form, '2026-10-04')).toMatchObject({ ok: true });
    expect(validateDraft({ ...ok, duration: '0m' }, form)).toMatchObject({ ok: false, field: 'duration' });
    expect(validateDraft({ ...ok, duration: '24h' }, form)).toMatchObject({ ok: true });
  });
  it('лишние ключи атрибутов отбрасываются, числа и флажки нормализуются', () => {
    const f = logFormFor(true, [
      { key: 'n', name: 'N', type: 'INPUT_NUMERIC', kind: 'number', required: false },
      { key: 'b', name: 'B', type: 'CHECKBOX', kind: 'checkbox', required: false },
    ]);
    const r = validateDraft({ duration: '30m', date: '2026-10-04', comment: '', aiTokens: '', attributes: { n: '1,5', b: 'yes', evil: 'x', __proto__: 'y' } }, f);
    expect(r).toEqual({ ok: true, req: { timeSpentSec: 1800, date: '2026-10-04', comment: '', attributes: { n: '1.5' } } });
    expect(validateDraft({ duration: '30m', date: '2026-10-04', comment: '', aiTokens: '', attributes: { n: '1e9' } }, f)).toMatchObject({ ok: false, field: 'attr:n' });
  });
  it('без Tempo атрибуты игнорируются, AI Tokens остаётся', () => {
    expect(validateDraft({ ...ok, attributes: { _Kind_: 'x' } }, logFormFor(false, []))).toEqual({ ok: true, req: { timeSpentSec: 5400, date: '2026-10-04', comment: 'c', aiTokens: 120000, attributes: {} } });
  });
  it('isIsoDate / parseTokens', () => {
    expect(isIsoDate('2026-10-04')).toBe(true);
    expect(isIsoDate('1999-12-31')).toBe(false);
    expect(isIsoDate('2026-1-4')).toBe(false);
    expect(parseTokens('')).toBeNull();
    expect(parseTokens('1 000')).toBe(1000);
    expect(parseTokens('-5')).toBeUndefined();
  });
});

describe('чтение Tempo', () => {
  const raw = {
    timeSpentSeconds: 3600, dateStarted: '2026-10-04T00:00:00.000', comment: 'c', id: 11, jiraWorklogId: 11,
    author: { name: 'ivan', displayName: 'Ivan Petrov' }, issue: { key: 'ABC-123', summary: 'S', remainingEstimateSeconds: 0 },
    worklogAttributes: [{ key: '_AITokensUsed_', value: '120000.0' }],
  };
  it('mapTempoWorklog', () => {
    expect(mapTempoWorklog(raw)).toEqual({
      id: '11', author: { id: 'ivan', name: 'Ivan Petrov' }, started: '2026-10-04T00:00:00.000', timeSpentSec: 3600, comment: 'c',
      attributes: { _AITokensUsed_: '120000.0' }, issueKey: 'ABC-123', issueSummary: 'S',
    });
  });
  it('worklogs: dateFrom/dateTo/username в query, фильтр задачи — на клиенте', async () => {
    const { client, calls } = mockClient('dc', () => ({ body: [raw, { ...raw, id: 12, issue: { key: 'ABC-9' } }] }));
    const t = new TempoClient(client.http);
    const all = await t.worklogs({ dateFrom: '2026-10-04', dateTo: '2026-10-04', username: 'ivan' });
    expect(all).toHaveLength(2);
    const q = calls[0].url;
    expect(q.pathname).toBe('/jira/rest/tempo-timesheets/3/worklogs');
    expect(Object.fromEntries(q.searchParams)).toEqual({ dateFrom: '2026-10-04', dateTo: '2026-10-04', username: 'ivan' });
    expect(await t.worklogs({ dateFrom: 'a', dateTo: 'b', issueKey: 'ABC-9' })).toHaveLength(1);
  });
  it('withTempoAttributes: атрибуты по id; 404 — без атрибутов; 401 — прекращаем', async () => {
    const wl = (id: string, started: string): Worklog => ({ id, started, timeSpentSec: 60, comment: '' });
    const { client, calls } = mockClient('dc', (c) => {
      const id = c.url.pathname.split('/').pop();
      if (id === '1') return { body: { ...raw, id: 1 } };
      if (id === '2') return undefined; // 404
      return { status: 401, body: {} };
    });
    const out = await withTempoAttributes(new TempoClient(client.http), [wl('2', '2026-10-03'), wl('1', '2026-10-04'), wl('3', '2026-10-02'), wl('4', '2026-10-01')], 50, 1);
    expect(out.map((w) => w.attributes)).toEqual([undefined, { _AITokensUsed_: '120000.0' }, undefined, undefined]);
    expect(calls.map((c) => c.url.pathname.split('/').pop())).toEqual(['1', '2', '3']); // новые первыми; 401 — стоп, до '4' не дошли
  });
});

describe('сводка «сегодня»', () => {
  const me: MyselfInfo = { id: 'ivan', name: 'ivan', displayName: 'Ivan' };
  const inst = (tempo: boolean): Pick<Instance, 'id' | 'name' | 'caps'> => ({ id: tempo ? 'p' : 's', name: tempo ? 'Northwind' : 'SCC', caps: { tempo, epicLinkField: null, checkedAt: '' } });
  it('mineOn: автор и префикс даты', () => {
    const w = (id: string, author: string, started: string): Worklog => ({ id, author: { id: author, name: author }, started, timeSpentSec: 60, comment: '' });
    expect(mineOn([w('1', 'ivan', '2026-10-04T12:00:00.000+0300'), w('2', 'anna', '2026-10-04T12:00:00.000+0300'), w('3', 'ivan', '2026-10-03T23:00:00.000+0300')], 'ivan', '2026-10-04').map((x) => x.id)).toEqual(['1']);
  });
  it('Tempo: один GET за день по логину', async () => {
    const { client, calls } = mockClient('dc', () => ({ body: [
      { id: 1, timeSpentSeconds: 3600, dateStarted: '2026-10-04T00:00:00.000', comment: 'a', author: { name: 'ivan' }, issue: { key: 'ABC-1' } },
      { id: 2, timeSpentSeconds: 1800, dateStarted: '2026-10-04T00:00:00.000', comment: 'b', author: { name: 'ivan' }, issue: { key: 'ABC-2' } },
    ] }));
    const r = await loadToday(client, inst(true), '2026-10-04', me);
    expect(r.totalSec).toBe(5400);
    expect(r.entries.map((e) => e.key)).toEqual(['ABC-1', 'ABC-2']);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get('username')).toBe('ivan');
    // логины Jira регистронезависимы: автор «Ivan» — тоже я
    const { client: c2 } = mockClient('dc', () => ({ body: [{ id: 1, timeSpentSeconds: 60, dateStarted: '2026-10-04T12:00:00.000', author: { name: 'Ivan' }, issue: { key: 'ABC-1' } }] }));
    expect((await loadToday(c2, inst(true), '2026-10-04', me)).totalSec).toBe(60);
  });
  it('без Tempo: JQL worklogDate, журнал задач, фильтр по автору и дате', async () => {
    const { client, calls } = mockClient('dc', (c) => {
      if (c.url.pathname.endsWith('/search')) return { body: { total: 2, issues: [{ key: 'ABC-1', fields: { summary: 'One' } }, { key: 'ABC-2', fields: { summary: 'Two' } }] } };
      if (c.url.pathname.endsWith('/ABC-1/worklog')) return { body: { worklogs: [
        { id: 1, author: { name: 'ivan' }, started: '2026-10-04T12:00:00.000+0300', timeSpentSeconds: 3600, comment: 'x' },
        { id: 2, author: { name: 'anna' }, started: '2026-10-04T12:00:00.000+0300', timeSpentSeconds: 999 },
      ] } };
      if (c.url.pathname.endsWith('/ABC-2/worklog')) return { body: { worklogs: [
        { id: 3, author: { name: 'ivan' }, started: '2026-10-03T12:00:00.000+0300', timeSpentSeconds: 999 },
        { id: 4, author: { name: 'ivan' }, started: '2026-10-04T09:00:00.000+0300', timeSpentSeconds: 900 },
      ] } };
      return undefined;
    });
    const r = await loadToday(client, inst(false), '2026-10-04', me);
    expect(calls[0].url.searchParams.get('jql')).toBe('worklogAuthor = currentUser() AND worklogDate = "2026-10-04" ORDER BY updated DESC');
    expect(r.totalSec).toBe(4500);
    expect(r.entries.map((e) => [e.key, e.timeSpentSec])).toEqual([['ABC-2', 900], ['ABC-1', 3600]]);
  });
  it('журнал задачи: постраничный ответ дочитывается по startAt', async () => {
    const wl = (id: number) => ({ id: String(id), author: { name: 'ivan', displayName: 'Иван' }, started: '2026-10-04T12:00:00.000+0300', timeSpentSeconds: 60 });
    const { client, calls } = mockClient('dc', (c) => {
      const at = Number(c.url.searchParams.get('startAt') ?? 0);
      return { body: { startAt: at, maxResults: 2, total: 5, worklogs: [wl(at + 1), wl(at + 2)].filter((w) => Number(w.id) <= 5) } };
    });
    const list = await client.worklogs('ABC-1');
    expect(list.map((w) => w.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(calls.map((c) => c.url.searchParams.get('startAt'))).toEqual([null, '2', '4']);
  });
  it('сумма по инстансам и строка состояния', () => {
    const list: TodayInstance[] = [
      { instanceId: 'p', name: 'Northwind', tempo: true, totalSec: 5400, entries: [] },
      { instanceId: 's', name: 'SCC', tempo: false, totalSec: 6300, entries: [] },
      { instanceId: 'c', name: 'Cloud', tempo: false, totalSec: 0, entries: [], error: 'нет связи' },
    ];
    expect(sumToday(list)).toBe(11700);
    const s = { date: '2026-10-04', loading: false, loaded: true, instances: list, totalSec: 11700 };
    expect(statusBarText(s, 8 * 3600)).toBe('$(clock) Today 3h 15m / 8h $(warning)');
    expect(statusBarText({ ...s, loaded: false }, 8 * 3600)).toBe('$(clock) Today …');
    expect(statusBarLines(s)).toEqual(['Northwind: 1h 30m · Tempo', 'SCC: 1h 45m', 'Cloud: error — нет связи']);
  });
  it('TodayService: упавший инстанс не мешает остальным, устаревший ответ отбрасывается', async () => {
    const insts: Instance[] = [
      { id: 'a', name: 'A', baseUrl: 'https://a.example.test', kind: 'dc', caps: { tempo: true, epicLinkField: null, checkedAt: '' } },
      { id: 'b', name: 'B', baseUrl: 'https://b.example.test', kind: 'dc' },
    ];
    const store = { list: () => insts, onDidChange: () => ({ dispose() {} }) };
    const { client } = mockClient('dc', () => ({ body: [{ id: 1, timeSpentSeconds: 600, dateStarted: '2026-10-04T00:00:00.000', author: { name: 'ivan' }, issue: { key: 'ABC-1' } }] }));
    const meta = {
      client: async (i: Instance) => { if (i.id === 'b') throw new Error('token not found'); return client; },
      myself: async () => me,
    };
    const svc = new TodayService(store as never, meta as never, () => new Date(2026, 9, 4, 10));
    const seen: boolean[] = [];
    svc.onDidChange((s) => seen.push(s.loading));
    const p1 = svc.refresh();
    const p2 = svc.refresh();
    await Promise.all([p1, p2]);
    expect(seen).toEqual([true, true, false]);
    const s = svc.get();
    expect(s.date).toBe('2026-10-04');
    expect(s.totalSec).toBe(600);
    expect(s.instances.find((i) => i.instanceId === 'b')?.error).toMatch(/token/);
  });
  it('localDate — локальная дата', () => {
    expect(localDate(new Date(2026, 0, 2, 23, 59))).toBe('2026-01-02');
  });
});

describe('разметка', () => {
  const base: IssueCard = {
    instanceId: 'p', instanceName: 'Northwind', host: 'jira.example.test', kind: 'dc', tempo: true, pinned: false, tab: 'wl',
    issue: {
      instanceId: 'p', key: 'ABC-123', summary: 'S', type: 'Task', status: 'Open', statusCategory: 'new', updated: '2026-10-04T10:00:00.000+0300',
      watchers: [], descriptionHtml: '', fixVersions: [], labels: [], components: [], created: '2026-10-01T10:00:00.000+0300',
      timetracking: {}, attachments: [], comments: [], history: [],
    },
    worklogs: [
      { id: '1', author: { id: 'ivan', name: 'Ivan' }, started: '2026-10-04T12:00:00.000+0300', timeSpentSec: 3600, comment: '<b>c</b>', attributes: { _AITokensUsed_: '120000.0', _Kind_: 'dev' } },
      { id: '2', author: { id: 'anna', name: 'Anna' }, started: '2026-10-03T12:00:00.000+0300', timeSpentSec: 1800, comment: '', attributes: { _AITokensUsed_: '5', '<x>': 'y' } },
    ],
    workAttributes: [LIST, AI],
    attachments: [],
  };
  it('журнал Tempo: колонки атрибутов, названия значений списка, сумма чисел, экранирование', () => {
    const html = renderWorklog(base);
    expect(html).toContain('<th>Тип работ</th>');
    expect(html).toContain('<th class="num">AI Tokens</th>');
    expect(html).toContain('<th>&lt;x&gt;</th>'); // ключ без описания — колонкой с ключом
    expect(html).toContain('<td>Разработка</td>');
    expect(html).toContain((120005).toLocaleString('en'));
    expect(html).toContain('&lt;b&gt;c&lt;/b&gt;');
    expect(html).not.toContain('<b>c</b>');
  });
  it('журнал без Tempo — без колонок атрибутов', () => {
    const html = renderWorklog({ ...base, tempo: false });
    expect(html).not.toContain('AI Tokens</th>');
    expect(html).toContain('No Tempo on Northwind');
  });
  it('диалог: поля атрибутов по форме, AI Tokens; без Tempo — заметка про комментарий', () => {
    const f = { ...logFormFor(true, [LIST, AI]), instanceName: 'Northwind', summary: 'S <script>', today: '2026-10-04' };
    const html = renderLogDialog('ABC-123', f);
    expect(html).toContain('data-attr="_Kind_"');
    expect(html).toContain('<option value="dev">Разработка</option>');
    expect(html).toContain('<option value="" disabled selected>— select —</option>'); // обязательный список: первое значение молча не выбирается
    expect(html).toContain('max="2026-10-04"');
    expect(html).toContain('id="lg-tok"');
    expect(html).not.toContain('data-attr="_AITokensUsed_"');
    expect(html).toContain('value="2026-10-04"');
    expect(html).toContain('S &lt;script&gt;');
    expect(html).not.toMatch(/ style=/);
    const plain = renderLogDialog('ABC-1', { ...logFormFor(false, []), instanceName: 'SCC', summary: 's', today: '2026-10-04' });
    expect(plain).toContain('AI Tokens are appended to the comment');
    expect(plain).not.toContain('fieldset');
  });
  it('раздел Tempo: «сегодня», строки задач, ошибки инстансов', () => {
    const v: TodayView = {
      date: '2026-10-04', loading: false, totalSec: 11700, workdaySec: 8 * 3600, noInstances: false,
      instances: [
        { instanceId: 'p', name: 'Northwind', tempo: true, totalSec: 11700, entries: [{ key: 'ABC-1', comment: '<i>x</i>', timeSpentSec: 11700, started: '' }] },
        { instanceId: 'c', name: 'Cloud', tempo: false, totalSec: 0, entries: [], error: 'нет <связи>' },
      ],
    };
    const html = renderToday(v);
    expect(html).toContain(`Today, ${dayLabel('2026-10-04')}`);
    expect(html).toContain('3h 15m');
    expect(html).toContain('of 8h · 4h 45m left');
    expect(html).toContain('data-w="41"');
    expect(html).toContain('data-inst="p" data-key="ABC-1"');
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;');
    expect(html).toContain('Cloud: нет &lt;связи&gt;');
    expect(html).not.toMatch(/ style=/);
    expect(renderToday({ ...v, noInstances: true })).toContain('data-act="addInstance"');
  });
});
