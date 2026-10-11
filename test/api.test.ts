import { describe, expect, it, vi } from 'vitest';
import { createApi, type ApiAccess, type ApiDeps, type JiraffeApi } from '../src/api';
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
    access: () => ({ read: true, write: true }),
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

describe('JiraffeApi: доступ из настроек (jiraffe.api.enabled / jiraffe.api.allowWrites)', () => {
  const ON: ApiAccess = { read: true, write: true };
  const READ_ONLY: ApiAccess = { read: true, write: false };
  const OFF: ApiAccess = { read: false, write: false };
  // Два разных текста: отказ чтения не должен совпасть с отказом записи (поэтому якорь `^`).
  const READ_OFF = /^Jiraffe: the API is disabled in Jiraffe settings$/;
  const WRITE_OFF = /^Jiraffe: writing through the API is disabled in Jiraffe settings$/;

  const issue = {
    instanceId: 'a', key: 'ABC-1', summary: 's', type: 'Bug', status: 'Open', statusCategory: 'new', updated: 'u', watchers: [],
    descriptionHtml: '<p>hi</p>', fixVersions: [], labels: [], components: [], created: 'c', timetracking: {}, attachments: [], comments: [], history: [],
  };
  /** Клиент со шпионом на каждый метод, до которого вообще может дойти вызов API. */
  const fakeClient = () => ({
    issueDetail: vi.fn(async () => ({ issue, worklogs: [] })),
    myself: vi.fn(async () => ({ id: 'me', name: 'me', displayName: 'Me' })),
    transitions: vi.fn(async () => [{ id: '11', name: 'T11', to: { name: 'Done', category: 'done' }, fields: [] }]),
    transition: vi.fn(async () => undefined),
    addComment: vi.fn(async () => ({ id: '1' })),
    addWorklog: vi.fn(async () => ({ id: '2' })),
  });
  const setup = (access: () => ApiAccess) => {
    const all = [inst('a'), inst('b', 'cloud')];
    const c = fakeClient();
    const d = deps({ access, list: vi.fn(() => all), visible: vi.fn((id: string) => all.find((i) => i.id === id)), client: vi.fn().mockResolvedValue(c) });
    return { d, c, api: createApi(d) };
  };
  type Setup = ReturnType<typeof setup>;
  const READS: Record<string, (api: JiraffeApi) => Promise<unknown>> = {
    issue: (api) => api.issue('a', 'ABC-1'),
    myself: (api) => api.myself('a'),
    openIssue: (api) => api.openIssue('a', 'ABC-1', true),
    transitions: (api) => api.transitions('a', 'ABC-1'),
  };
  const WRITES: Record<string, (api: JiraffeApi) => Promise<unknown>> = {
    addComment: (api) => api.addComment('a', 'ABC-1', 'hi'),
    transition: (api) => api.transition('a', 'ABC-1', '11'),
    logWork: (api) => api.logWork('a', 'ABC-1', { seconds: 60 }),
  };
  /** При отказе гейта не тронуто ничего: ни клиент (а значит и Jira), ни форма Tempo, ни карточка, ни обновление вида / «последняя запись». */
  const untouched = ({ d, c }: Setup): void => {
    expect(d.client).not.toHaveBeenCalled();
    expect(d.logForm).not.toHaveBeenCalled();
    expect(d.open).not.toHaveBeenCalled();
    expect(d.changed).not.toHaveBeenCalled();
    for (const [name, fn] of Object.entries(c)) expect(fn, name).not.toHaveBeenCalled();
  };

  it('чтение выключено: instances() пуст, все семь методов отказывают, список и клиент не тронуты', async () => {
    const s = setup(() => OFF);
    expect(s.api.instances()).toEqual([]);
    for (const [name, call] of Object.entries({ ...READS, ...WRITES })) await expect(call(s.api), name).rejects.toThrow(READ_OFF);
    expect(s.d.list).not.toHaveBeenCalled();
    expect(s.d.visible).not.toHaveBeenCalled();
    untouched(s);
  });

  it('чтение выключено: отказ один и тот же для чужого инстанса и мусорных аргументов — id по ответу не подобрать', async () => {
    const s = setup(() => OFF);
    await expect(s.api.issue('zzz', 'not a key')).rejects.toThrow(READ_OFF);
    await expect(s.api.myself(undefined as never)).rejects.toThrow(READ_OFF);
    await expect(s.api.openIssue('zzz', 'x')).rejects.toThrow(READ_OFF);
    await expect(s.api.transitions('a', 'x')).rejects.toThrow(READ_OFF);
    await expect(s.api.addComment('zzz', 'x', 5 as never)).rejects.toThrow(READ_OFF);
    await expect(s.api.transition('zzz', 'x', 7 as never)).rejects.toThrow(READ_OFF);
    await expect(s.api.logWork('zzz', 'x', null as never)).rejects.toThrow(READ_OFF);
    expect(s.d.visible).not.toHaveBeenCalled();
    untouched(s);
  });

  it('запись выключена: addComment / transition / logWork отказывают, Jira и форма Tempo не вызываются', async () => {
    const s = setup(() => READ_ONLY);
    for (const [name, call] of Object.entries(WRITES)) await expect(call(s.api), name).rejects.toThrow(WRITE_OFF);
    untouched(s);
  });

  it('запись выключена: чтение работает как обычно', async () => {
    const s = setup(() => READ_ONLY);
    expect(s.api.instances()).toHaveLength(2);
    await expect(s.api.issue('a', ' abc-1 ')).resolves.toMatchObject({ issue: { key: 'ABC-1' } });
    await expect(s.api.myself('a')).resolves.toEqual({ name: 'me', displayName: 'Me' });
    await expect(s.api.transitions('a', 'ABC-1')).resolves.toEqual([{ id: '11', name: 'T11', to: { name: 'Done', category: 'done' }, requiresFields: false }]);
    await s.api.openIssue('a', 'abc-1', true);
    expect(s.d.open).toHaveBeenCalledWith('a', 'ABC-1', true);
    expect(s.c.transition).not.toHaveBeenCalled();
    expect(s.c.addComment).not.toHaveBeenCalled();
    expect(s.c.addWorklog).not.toHaveBeenCalled();
    expect(s.d.changed).not.toHaveBeenCalled();
  });

  it('всё включено — как раньше: чтение, три записи, обновление вида после каждой', async () => {
    const s = setup(() => ON);
    expect(s.api.instances()).toHaveLength(2);
    for (const [name, call] of Object.entries({ ...READS, ...WRITES })) await expect(call(s.api), name).resolves.not.toThrow();
    expect(s.c.addComment).toHaveBeenCalledTimes(1);
    expect(s.c.transition).toHaveBeenCalledTimes(1);
    expect(s.c.addWorklog).toHaveBeenCalledTimes(1);
    expect(s.d.changed).toHaveBeenNthCalledWith(1, 'comment', 'a', 'ABC-1');
    expect(s.d.changed).toHaveBeenNthCalledWith(2, 'transition', 'a', 'ABC-1');
    expect(s.d.changed).toHaveBeenNthCalledWith(3, 'worklog', 'a', 'ABC-1');
  });

  it('доступ читается на каждый вызов, а не при создании API', async () => {
    let now: ApiAccess = ON;
    const access = vi.fn(() => now);
    const s = setup(access);
    await expect(s.api.addComment('a', 'ABC-1', 'x')).resolves.toBeDefined();
    now = READ_ONLY;
    await expect(s.api.addComment('a', 'ABC-1', 'x')).rejects.toThrow(WRITE_OFF);
    expect(s.api.instances()).toHaveLength(2);
    now = OFF;
    expect(s.api.instances()).toEqual([]);
    await expect(s.api.issue('a', 'ABC-1')).rejects.toThrow(READ_OFF);
    now = ON;
    expect(s.api.instances()).toHaveLength(2);
    await expect(s.api.addComment('a', 'ABC-1', 'x')).resolves.toBeDefined();
    expect(s.c.addComment).toHaveBeenCalledTimes(2);
    expect(access).toHaveBeenCalled();
  });

  it('отказ гейта не съедает метку «запись могла сохраниться»: она сработает после включения', async () => {
    let now: ApiAccess = ON;
    const s = setup(() => now);
    s.c.addComment.mockRejectedValueOnce(new Error(`No response: timed out; ${maybeSaved()}`));
    await expect(s.api.addComment('a', 'ABC-1', 'x')).rejects.toThrow(/timed out/);
    now = READ_ONLY;
    await expect(s.api.addComment('a', 'ABC-1', 'x')).rejects.toThrow(WRITE_OFF);
    now = ON;
    await expect(s.api.addComment('a', 'ABC-1', 'x')).rejects.toThrow(/may have been saved/);
    await expect(s.api.addComment('a', 'ABC-1', 'x')).resolves.toEqual({ id: '1' });
    expect(s.c.addComment).toHaveBeenCalledTimes(2);
  });

  it('гейт раньше замка «уже отправляется»; запись, разрешённая на момент вызова, доходит до конца', async () => {
    let now: ApiAccess = ON;
    const s = setup(() => now);
    let release!: () => void;
    s.c.addComment.mockImplementationOnce(() => new Promise<{ id: string }>((r) => { release = () => r({ id: '7' }); }));
    const first = s.api.addComment('a', 'ABC-1', 'x');
    await new Promise((r) => setTimeout(r, 0));
    now = READ_ONLY;
    await expect(s.api.addComment('a', 'ABC-1', 'y')).rejects.toThrow(WRITE_OFF);
    release();
    await expect(first).resolves.toEqual({ id: '7' });
    expect(s.c.addComment).toHaveBeenCalledTimes(1);
  });

  it('запись выключили, пока API ждал клиента / переходы / форму Tempo, — в Jira она не уходит и вид не обновляется', async () => {
    // комментарий: ждём клиента
    let now: ApiAccess = ON;
    const s1 = setup(() => now);
    (s1.d.client as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { now = READ_ONLY; return s1.c; });
    await expect(s1.api.addComment('a', 'ABC-1', 'x')).rejects.toThrow(WRITE_OFF);
    expect(s1.c.addComment).not.toHaveBeenCalled();
    expect(s1.d.changed).not.toHaveBeenCalled();
    // переход: ждём список переходов
    now = ON;
    const s2 = setup(() => now);
    s2.c.transitions.mockImplementationOnce(async () => { now = READ_ONLY; return [{ id: '11', name: 'T11', to: { name: 'Done', category: 'done' }, fields: [] }]; });
    await expect(s2.api.transition('a', 'ABC-1', '11')).rejects.toThrow(WRITE_OFF);
    expect(s2.c.transition).not.toHaveBeenCalled();
    expect(s2.d.changed).not.toHaveBeenCalled();
    // время: ждём форму Tempo
    now = ON;
    const s3 = setup(() => now);
    (s3.d.logForm as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { now = READ_ONLY; return { tempo: false, attributes: [], unsupportedRequired: [] }; });
    await expect(s3.api.logWork('a', 'ABC-1', { seconds: 60 })).rejects.toThrow(WRITE_OFF);
    expect(s3.c.addWorklog).not.toHaveBeenCalled();
    expect(s3.d.changed).not.toHaveBeenCalled();
    // отказ посреди вызова замок и метку не оставляет: после включения те же вызовы проходят
    now = ON;
    await expect(s1.api.addComment('a', 'ABC-1', 'x')).resolves.toEqual({ id: '1' });
  });

  it('API выключили, пока чтение ждало Jira, — ответ наружу не отдаётся', async () => {
    let now: ApiAccess = ON;
    const s = setup(() => now);
    s.c.issueDetail.mockImplementationOnce(async () => { now = OFF; return { issue, worklogs: [] }; });
    await expect(s.api.issue('a', 'ABC-1')).rejects.toThrow(READ_OFF);
    now = ON;
    s.c.myself.mockImplementationOnce(async () => { now = OFF; return { id: 'me', name: 'me', displayName: 'Me' }; });
    await expect(s.api.myself('a')).rejects.toThrow(READ_OFF);
    now = ON;
    s.c.transitions.mockImplementationOnce(async () => { now = OFF; return []; });
    await expect(s.api.transitions('a', 'ABC-1')).rejects.toThrow(READ_OFF);
    // выключили только запись — чтение в полёте отдаётся как обычно
    now = ON;
    s.c.issueDetail.mockImplementationOnce(async () => { now = READ_ONLY; return { issue, worklogs: [] }; });
    await expect(s.api.issue('a', 'ABC-1')).resolves.toMatchObject({ issue: { key: 'ABC-1' } });
  });

  it('объект API заморожен: потребитель не подменит методы под другими расширениями', () => {
    const { api } = setup(() => ON);
    expect(Object.isFrozen(api)).toBe(true);
    expect(() => { (api as { addComment: unknown }).addComment = () => undefined; }).toThrow(TypeError);
  });

  it('access() сломан или врёт — закрыто: исключение, пусто, не boolean, запись без чтения', async () => {
    const bad: [string, () => unknown][] = [
      ['исключение', () => { throw new Error('config unavailable'); }],
      ['undefined', () => undefined],
      ['пустой объект', () => ({})],
      ['не boolean', () => ({ read: 'yes', write: 'yes' })],
      ['запись без чтения', () => ({ read: false, write: true })],
    ];
    for (const [name, access] of bad) {
      const s = setup(access as () => ApiAccess);
      expect(s.api.instances(), name).toEqual([]);
      await expect(s.api.issue('a', 'ABC-1'), name).rejects.toThrow(READ_OFF);
      await expect(s.api.addComment('a', 'ABC-1', 'x'), name).rejects.toThrow(READ_OFF);
      untouched(s);
    }
    // чтение открывает только настоящее true; запись — только настоящее true при открытом чтении
    const s = setup((() => ({ read: true, write: 'yes' })) as unknown as () => ApiAccess);
    await expect(s.api.issue('a', 'ABC-1')).resolves.toBeDefined();
    await expect(s.api.addComment('a', 'ABC-1', 'x')).rejects.toThrow(WRITE_OFF);
    expect(s.c.addComment).not.toHaveBeenCalled();
  });
});
