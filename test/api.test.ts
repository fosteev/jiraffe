import { describe, expect, it, vi } from 'vitest';
import { createApi, type ApiDeps } from '../src/api';
import { localDate, type LogForm } from '../src/jira/worklog';
import { maybeSaved } from '../src/jira/http';
import type { Instance } from '../src/jira/types';

const inst = (id: string, kind: 'dc' | 'cloud' = 'dc'): Instance => ({ id, name: id.toUpperCase(), baseUrl: `https://${id}.test`, kind });

function deps(over: Partial<ApiDeps> = {}): ApiDeps {
  const all = [inst('a'), inst('b', 'cloud')];
  return {
    list: () => all,
    visible: (id) => all.find((i) => i.id === id),
    client: vi.fn(),
    open: vi.fn(),
    onDidChangeInstances: vi.fn() as never,
    logForm: vi.fn(async () => ({ tempo: false, attributes: [], unsupportedRequired: [] })),
    changed: vi.fn(),
    ...over,
  };
}

describe('JiraffeApi v1 (читающая часть)', () => {
  it('форма API по контракту', () => {
    const api = createApi(deps());
    expect(api.apiVersion).toBe(2);
    expect(Object.keys(api).sort()).toEqual(['addComment', 'apiVersion', 'instances', 'issue', 'logWork', 'myself', 'onDidChangeInstances', 'openIssue', 'transition', 'transitions']);
  });

  it('instances — только публичные поля, без токенов и служебного', () => {
    const api = createApi(deps({ list: () => [{ ...inst('a'), email: 'x@y', caps: { tempo: true, epicLinkField: null, checkedAt: '' } }] }));
    expect(api.instances()).toEqual([{ id: 'a', name: 'A', baseUrl: 'https://a.test', kind: 'dc' }]);
  });

  it('openIssue: ключ нормализуется, beside пробрасывается; чужой инстанс и мусорный ключ — ошибка', async () => {
    const d = deps();
    const api = createApi(d);
    await api.openIssue('a', 'abc-1', true);
    await api.openIssue('a', 'ABC-2');
    expect(d.open).toHaveBeenNthCalledWith(1, 'a', 'ABC-1', true);
    expect(d.open).toHaveBeenNthCalledWith(2, 'a', 'ABC-2', false);
    await expect(api.openIssue('zzz', 'ABC-1')).rejects.toThrow(/unknown instance/);
    await expect(api.openIssue('a', 'nope')).rejects.toThrow(/invalid issue key/);
  });

  it('myself: Cloud — accountId, DC — без него', async () => {
    // клиент Jiraffe на Cloud кладёт accountId и в name — наружу он уходить не должен
    const client = vi.fn().mockResolvedValue({ myself: async () => ({ id: 'acc-1', name: 'acc-1', displayName: 'Ann', email: 'ann@x.test' }) });
    const api = createApi(deps({ client }));
    expect(await api.myself('b')).toEqual({ accountId: 'acc-1', displayName: 'Ann' });
    expect(await api.myself('a')).toEqual({ name: 'acc-1', displayName: 'Ann' });
  });

  it('issue: данные клиента, описание санитизировано', async () => {
    const issue = {
      instanceId: 'a', key: 'ABC-1', summary: 's', type: 'Bug', status: 'Open', statusCategory: 'new', updated: 'u', watchers: [],
      descriptionHtml: '<p>hi<script>alert(1)</script></p>', fixVersions: [], labels: [], components: [], created: 'c', timetracking: {},
      attachments: [], comments: [{ id: 'c1', created: 'c', bodyHtml: '<a href="javascript:alert(1)">x</a><img src="data:image/png;base64,AA">' }], history: [],
    };
    const issueDetail = vi.fn(async () => ({ issue, worklogs: [{ id: '1' }] }));
    const client = vi.fn().mockResolvedValue({ issueDetail });
    const r = await createApi(deps({ client })).issue('a', ' abc-1 ');
    expect(issueDetail).toHaveBeenCalledWith('ABC-1', expect.objectContaining({ id: 'a' }));
    expect(r.worklogs).toHaveLength(1);
    expect(r.issue.descriptionHtml).not.toContain('<script');
    expect(r.issue.key).toBe('ABC-1');
    expect(r.issue.comments[0].bodyHtml).not.toMatch(/javascript:|data:/);
    client.mockClear();
    await expect(createApi(deps({ client, visible: () => undefined })).issue('a', 'ABC-1')).rejects.toThrow(/unknown instance/);
    await expect(createApi(deps({ client })).issue('a', 'ABC-1; DROP')).rejects.toThrow(/invalid issue key/);
    await expect(createApi(deps({ client })).myself('zzz')).rejects.toThrow(/unknown instance/);
    expect(issueDetail).toHaveBeenCalledTimes(1); // до клиента мусор не доходит
  });
});

describe('JiraffeApi v2 (запись)', () => {
  const tr = (id: string, fields: unknown[] = []) => ({ id, name: `T${id}`, to: { name: 'Done', category: 'done' }, fields });
  const mk = (c: Record<string, unknown>, over: Partial<ApiDeps> = {}) => {
    const d = deps({ client: vi.fn().mockResolvedValue(c), ...over });
    return { d, api: createApi(d) };
  };

  it('addComment: нормализует ключ, шлёт тело как есть, уведомляет об изменении', async () => {
    const addComment = vi.fn(async () => ({ id: '7' }));
    const { d, api } = mk({ addComment });
    expect(await api.addComment('a', ' abc-1 ', 'h1. hi')).toEqual({ id: '7' });
    expect(addComment).toHaveBeenCalledWith('ABC-1', 'h1. hi');
    expect(d.changed).toHaveBeenCalledWith('comment', 'a', 'ABC-1');
  });

  it('addComment: чужой инстанс, мусорный ключ, не строка, пусто, слишком длинно — reject до клиента', async () => {
    const addComment = vi.fn(async () => ({}));
    const { d, api } = mk({ addComment });
    await expect(api.addComment('zzz', 'ABC-1', 'x')).rejects.toThrow(/unknown instance/);
    await expect(api.addComment('a', 'nope', 'x')).rejects.toThrow(/invalid issue key/);
    await expect(api.addComment('a', 'ABC-1', 5 as never)).rejects.toThrow(/non-empty string/);
    await expect(api.addComment('a', 'ABC-1', '  \n ')).rejects.toThrow(/non-empty string/);
    await expect(api.addComment('a', 'ABC-1', 'x'.repeat(32_001))).rejects.toThrow(/too long/);
    await expect(api.addComment('a', 'ABC-1', 'x'.repeat(32_000))).resolves.toBeDefined();
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(d.changed).toHaveBeenCalledTimes(1);
  });

  it('ошибка с чужим вводом обрезается до 50 символов', async () => {
    const { api } = mk({});
    const e = await api.transition('a', 'ABC-1', 'x'.repeat(100)).catch((x: Error) => x);
    expect((e as Error).message.length).toBeLessThan(120);
    const e2 = await api.addComment('y'.repeat(500), 'ABC-1', 'x').catch((x: Error) => x);
    expect((e2 as Error).message.length).toBeLessThan(120);
  });

  it('transitions: id, имя, статус, признак обязательных полей', async () => {
    const { api } = mk({ transitions: async () => [tr('11'), tr('31', [{ id: 'resolution' }])] });
    expect(await api.transitions('a', 'abc-1')).toEqual([
      { id: '11', name: 'T11', to: { name: 'Done', category: 'done' }, requiresFields: false },
      { id: '31', name: 'T31', to: { name: 'Done', category: 'done' }, requiresFields: true },
    ]);
    await expect(api.transitions('zzz', 'ABC-1')).rejects.toThrow(/unknown instance/);
  });

  it('transition: только id из transitions() этой задачи, без обязательных полей', async () => {
    const transition = vi.fn(async () => undefined);
    const { d, api } = mk({ transitions: async () => [tr('11'), tr('31', [{ id: 'resolution' }])], transition });
    await api.transition('a', 'abc-1', '11');
    expect(transition).toHaveBeenCalledWith('ABC-1', '11');
    expect(d.changed).toHaveBeenCalledWith('transition', 'a', 'ABC-1');
    await expect(api.transition('a', 'ABC-1', '99')).rejects.toThrow(/not available/);
    await expect(api.transition('a', 'ABC-1', '31')).rejects.toThrow(/requires fields/);
    await expect(api.transition('a', 'ABC-1', '')).rejects.toThrow(/invalid transition id/);
    await expect(api.transition('a', 'ABC-1', 11 as never)).rejects.toThrow(/invalid transition id/);
    await expect(api.transition('zzz', 'ABC-1', '11')).rejects.toThrow(/unknown instance/);
    await expect(api.transition('a', 'x', '11')).rejects.toThrow(/invalid issue key/);
    expect(transition).toHaveBeenCalledTimes(1);
  });

  it('logWork (Jira): секунды и дата проверяются, запись идёт в worklog', async () => {
    const addWorklog = vi.fn(async () => ({ id: '5' }));
    const { d, api } = mk({ addWorklog });
    expect(await api.logWork('a', 'abc-1', { seconds: 3600, started: '2026-10-05T09:00:00.000+0300', comment: ' work ', aiTokens: 100 })).toEqual({ via: 'jira', id: '5' });
    const [key, w] = addWorklog.mock.calls[0] as unknown as [string, { started: string; timeSpentSec: number; comment: string }];
    expect(key).toBe('ABC-1');
    expect(w.started.startsWith('2026-10-05T12:00:00.000')).toBe(true);
    expect(w.timeSpentSec).toBe(3600);
    expect(w.comment).toBe('work (AI Tokens: 100)');
    expect(d.changed).toHaveBeenCalledWith('worklog', 'a', 'ABC-1');
    await api.logWork('a', 'ABC-1', { seconds: 86_400, started: '2026-10-05' });
    for (const seconds of [0, -5, 1.5, 86_401, NaN, '60' as never]) await expect(api.logWork('a', 'ABC-1', { seconds })).rejects.toThrow(/seconds/);
    for (const started of ['yesterday', '2026-02-31', '2026-10-05 09:00', '2026-10-05Tjunk', 20261005 as never]) {
      await expect(api.logWork('a', 'ABC-1', { seconds: 60, started })).rejects.toThrow(/invalid started/);
    }
    await expect(api.logWork('a', 'ABC-1', { seconds: 60, comment: 'x'.repeat(30_001) })).rejects.toThrow(/comment/);
    await expect(api.logWork('a', 'ABC-1', { seconds: 60, aiTokens: -1 })).rejects.toThrow(/aiTokens/);
    await expect(api.logWork('zzz', 'ABC-1', { seconds: 60 })).rejects.toThrow(/unknown instance/);
    await expect(api.logWork('a', 'ABC-1', null as never)).rejects.toThrow(/seconds/);
    expect(addWorklog).toHaveBeenCalledTimes(2);
  });

  it('logWork (Tempo): обязательные атрибуты, которые API не заполняет, — reject; AI Tokens обязателен — нужен aiTokens', async () => {
    const addWorklog = vi.fn(async () => ({ id: '5' }));
    const attr = (key: string, required: boolean) => ({ key, name: key, kind: 'text', required });
    const form = (attributes: unknown[], aiTokensAttr?: string, unsupportedRequired: string[] = []) =>
      vi.fn(async () => ({ tempo: true, attributes, unsupportedRequired, ...(aiTokensAttr ? { aiTokensAttr } : {}) }) as LogForm);
    const c = { addWorklog };
    await expect(mk(c, { logForm: form([attr('_Team_', true)]) }).api.logWork('a', 'ABC-1', { seconds: 60 })).rejects.toThrow(/Tempo requires/);
    await expect(mk(c, { logForm: form([], undefined, ['Account']) }).api.logWork('a', 'ABC-1', { seconds: 60 })).rejects.toThrow(/Tempo requires/);
    await expect(mk(c, { logForm: form([attr('_AI_', true)], '_AI_') }).api.logWork('a', 'ABC-1', { seconds: 60 })).rejects.toThrow(/aiTokens is required/);
    expect(addWorklog).not.toHaveBeenCalled();
  });

  it('logWork: параллельный повтор по той же задаче — reject, после ответа замок снимается', async () => {
    let release!: () => void;
    const addWorklog = vi.fn(() => new Promise<{ id: string }>((r) => { release = () => r({ id: '1' }); }));
    const { api } = mk({ addWorklog });
    const first = api.logWork('a', 'ABC-1', { seconds: 60 });
    await new Promise((r) => setTimeout(r, 0));
    await expect(api.logWork('a', 'abc-1', { seconds: 60 })).rejects.toThrow(/already being sent/);
    release();
    await first;
    addWorklog.mockResolvedValueOnce({ id: '2' });
    await expect(api.logWork('a', 'ABC-1', { seconds: 60 })).resolves.toBeDefined();
  });
  it('logWork: дата-время — его локальная дата (toISOString около полуночи), будущее — reject', async () => {
    const addWorklog = vi.fn(async () => ({ id: '5' }));
    const { api } = mk({ addWorklog });
    for (const local of [new Date(2026, 9, 5, 0, 30), new Date(2026, 9, 5, 23, 30)]) {
      await api.logWork('a', 'ABC-1', { seconds: 60, started: local.toISOString() });
      const w = (addWorklog.mock.calls.at(-1) as unknown as [string, { started: string }])[1];
      expect(w.started.startsWith('2026-10-05T12:00:00.000')).toBe(true);
    }
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    await expect(api.logWork('a', 'ABC-1', { seconds: 60, started: localDate(tomorrow) })).rejects.toThrow(/in the future/);
    await expect(api.logWork('a', 'ABC-1', { seconds: 60, started: localDate() })).resolves.toBeDefined();
    expect(addWorklog).toHaveBeenCalledTimes(3);
  });

  it('logWork (Tempo): автор из myself, AI Tokens — атрибутом, via tempo', async () => {
    const postJson = vi.fn(async () => [{ tempoWorklogId: 9, id: 9 }]);
    const c = { http: { postJson }, myself: async () => ({ name: 'me', displayName: 'Me' }), timetracking: async () => ({ remainingSec: 7200 }) };
    const logForm = vi.fn(async () => ({ tempo: true, attributes: [{ key: '_AI_', name: 'AI', kind: 'number', required: true }], aiTokensAttr: '_AI_', unsupportedRequired: [] }) as unknown as LogForm);
    const { d, api } = mk(c, { logForm });
    expect(await api.logWork('a', 'abc-1', { seconds: 3600, comment: 'w', aiTokens: 42 })).toMatchObject({ via: 'tempo' });
    const [path, body] = postJson.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toContain('/rest/tempo-timesheets/3/worklogs');
    expect(JSON.stringify(body)).toContain('"key":"_AI_","value":"42"');
    expect(JSON.stringify(body)).toContain('"author":{"name":"me"}');
    expect(d.changed).toHaveBeenCalledWith('worklog', 'a', 'ABC-1');
  });

  it('замок снимается и после ошибки; отказ API до записи не обновляет вид', async () => {
    const addComment = vi.fn().mockRejectedValueOnce(new Error('Jira says no')).mockResolvedValueOnce({ id: '1' });
    const transition = vi.fn();
    const { d, api } = mk({ addComment, transitions: async () => [tr('11')], transition });
    await expect(api.addComment('a', 'ABC-1', 'x')).rejects.toThrow(/Jira says no/);
    await expect(api.addComment('a', 'ABC-1', 'x')).resolves.toEqual({ id: '1' });
    expect(d.changed).toHaveBeenCalledTimes(2);
    await expect(api.transition('a', 'ABC-1', '99')).rejects.toThrow(/not available/);
    expect(d.changed).toHaveBeenCalledTimes(2);
    expect(transition).not.toHaveBeenCalled();
  });

  it('сбой changed() не подменяет результат записи', async () => {
    const { api } = mk({ addComment: async () => ({ id: '3' }) }, { changed: vi.fn(() => { throw new Error('view'); }) });
    await expect(api.addComment('a', 'ABC-1', 'x')).resolves.toEqual({ id: '3' });
  });

  it('повтор сразу после «запись могла сохраниться» — первый раз reject, второй проходит', async () => {
    const addComment = vi.fn().mockRejectedValueOnce(new Error(`No response: timed out; ${maybeSaved()}`)).mockResolvedValue({ id: '2' });
    const { api } = mk({ addComment });
    await expect(api.addComment('a', 'ABC-1', 'x')).rejects.toThrow(/timed out/);
    await expect(api.addComment('a', 'abc-1', 'x')).rejects.toThrow(/may have been saved/);
    await expect(api.addComment('a', 'ABC-1', 'x')).resolves.toEqual({ id: '2' });
    expect(addComment).toHaveBeenCalledTimes(2);
  });
});
