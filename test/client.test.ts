import { describe, expect, it } from 'vitest';
import { detectCapabilities } from '../src/jira/capabilities';
import { createJiraClient } from '../src/jira/client';
import { JiraError } from '../src/jira/http';
import { InstanceStore, instanceIdFromUrl } from '../src/state/instances';

type Route = (url: URL) => { status?: number; body: unknown } | undefined;
function client(kind: 'dc' | 'cloud', route: Route, baseUrl = 'https://h.example/jira') {
  const urls: string[] = [];
  const fetchImpl = (async (u: string) => {
    urls.push(u);
    const r = route(new URL(u));
    if (!r) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { c: createJiraClient({ id: 'i1', kind, baseUrl, email: 'a@b.c' }, 'tok', { fetchImpl }), urls };
}

const rawIssue = (key: string, user: object | null) => ({
  key,
  fields: {
    summary: `S ${key}`, issuetype: { name: 'Bug', iconUrl: 'https://i/bug.png' },
    status: { name: 'В работе', statusCategory: { key: 'indeterminate' } },
    priority: { name: 'High' }, assignee: user, updated: '2026-01-01T10:00:00.000+0000',
  },
});

describe('JiraClient.search', () => {
  it('DC: /rest/api/2/search со startAt, next по total, пользователь по name', async () => {
    const { c, urls } = client('dc', () => ({ body: { total: 3, issues: [rawIssue('T-1', { name: 'ivan', displayName: 'Ivan' }), rawIssue('T-2', null)] } }));
    const p = await c.search('assignee = currentUser()', ['summary'], { startAt: 0, maxResults: 2 });
    const u = new URL(urls[0]);
    expect(u.pathname).toBe('/jira/rest/api/2/search');
    expect(u.searchParams.get('startAt')).toBe('0');
    expect(u.searchParams.get('maxResults')).toBe('2');
    expect(u.searchParams.get('fields')).toBe('summary');
    expect(p.total).toBe(3);
    expect(p.next).toEqual({ startAt: 2 });
    expect(p.issues[0]).toMatchObject({ instanceId: 'i1', key: 'T-1', type: 'Bug', statusCategory: 'indeterminate', priority: 'High', assignee: { id: 'ivan', name: 'Ivan' } });
    expect(p.issues[1].assignee).toBeUndefined();
  });

  it('DC: последняя страница — без next', async () => {
    const { c } = client('dc', () => ({ body: { total: 2, issues: [rawIssue('T-1', null), rawIssue('T-2', null)] } }));
    expect((await c.search('x', undefined, { startAt: 0 })).next).toBeUndefined();
  });

  it('Cloud: /search/jql, nextPageToken, пользователь по accountId', async () => {
    const { c, urls } = client('cloud', (u) => ({
      body: u.searchParams.get('nextPageToken')
        ? { issues: [rawIssue('C-2', null)], isLast: true }
        : { issues: [rawIssue('C-1', { accountId: 'acc1', displayName: 'Anna' })], nextPageToken: 'tok2', isLast: false },
    }));
    const p1 = await c.search('project = C');
    expect(new URL(urls[0]).pathname).toBe('/jira/rest/api/2/search/jql');
    expect(p1.issues[0].assignee).toEqual({ id: 'acc1', name: 'Anna' });
    expect(p1.next).toEqual({ nextPageToken: 'tok2' });
    const p2 = await c.search('project = C', undefined, p1.next);
    expect(new URL(urls[1]).searchParams.get('nextPageToken')).toBe('tok2');
    expect(p2.next).toBeUndefined();
  });

  it('Cloud: тот же курсор или пустая страница — без next (нет зацикливания)', async () => {
    const same = client('cloud', () => ({ body: { issues: [rawIssue('C-1', null)], nextPageToken: 'tok2', isLast: false } }));
    expect((await same.c.search('x', undefined, { nextPageToken: 'tok2' })).next).toBeUndefined();
    const empty = client('cloud', () => ({ body: { issues: [], nextPageToken: 'tok3' } }));
    expect((await empty.c.search('x')).next).toBeUndefined();
  });

  it('JQL с кириллицей, кавычками, & и # кодируется в query', async () => {
    const { c, urls } = client('dc', () => ({ body: { total: 0, issues: [] } }));
    const jql = 'text ~ "a&b #1 + задача"';
    await c.search(jql);
    expect(new URL(urls[0]).searchParams.get('jql')).toBe(jql);
  });

  it('maxResults зажимается в 1..100, не-массив вместо списка → []', async () => {
    const { c, urls } = client('dc', (u) => (u.pathname.endsWith('/project') ? { body: {} } : { body: { total: 0, issues: [] } }));
    await c.search('x', undefined, { maxResults: 500 });
    expect(new URL(urls[0]).searchParams.get('maxResults')).toBe('100');
    expect(await c.projects()).toEqual([]);
  });

  it('401 → JiraError(401)', async () => {
    const { c } = client('dc', () => ({ status: 401, body: {} }));
    await expect(c.myself()).rejects.toMatchObject({ status: 401 });
    await expect(c.myself()).rejects.toBeInstanceOf(JiraError);
  });
});

describe('JiraClient прочее', () => {
  it('myself: DC → name, Cloud → accountId', async () => {
    expect((await client('dc', () => ({ body: { name: 'ivan', displayName: 'Ivan' } })).c.myself()).id).toBe('ivan');
    expect((await client('cloud', () => ({ body: { accountId: 'a1', displayName: 'Anna' } })).c.myself()).id).toBe('a1');
  });
  it('issue, favouriteFilters, projects', async () => {
    const { c, urls } = client('dc', (u) => {
      if (u.pathname.endsWith('/filter/favourite')) return { body: [{ id: '1', name: 'F', jql: 'a=b' }] };
      if (u.pathname.endsWith('/project')) return { body: [{ id: '10', key: 'P', name: 'Proj' }] };
      return { body: { key: 'P-1' } };
    });
    expect((await c.issue('P-1', ['renderedFields', 'changelog'])).key).toBe('P-1');
    expect(new URL(urls[0]).searchParams.get('expand')).toBe('renderedFields,changelog');
    expect(await c.favouriteFilters()).toEqual([{ id: '1', name: 'F', jql: 'a=b' }]);
    expect(await c.projects()).toEqual([{ id: '10', key: 'P', name: 'Proj' }]);
  });
});

describe('detectCapabilities', () => {
  const fields = [{ id: 'customfield_1', name: 'Epic Link', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } }, { id: 'summary', name: 'S' }];
  it('DC с Tempo', async () => {
    const { c } = client('dc', (u) =>
      u.pathname.endsWith('/work-attribute') ? { body: [] } : u.pathname.endsWith('/field') ? { body: fields } : u.pathname.endsWith('/serverInfo') ? { body: { version: '9.12.0' } } : undefined);
    expect(await detectCapabilities(c)).toMatchObject({ tempo: true, epicLinkField: 'customfield_1', serverVersion: '9.12.0' });
  });
  it('DC без Tempo (404)', async () => {
    const { c } = client('dc', (u) => (u.pathname.endsWith('/field') ? { body: fields } : undefined));
    expect(await detectCapabilities(c)).toMatchObject({ tempo: false, epicLinkField: 'customfield_1' });
  });
  it('DC без Tempo: 200 с HTML вместо JSON (редирект на login.jsp)', async () => {
    const fetchImpl = (async (u: string) => new Response(new URL(u).pathname.endsWith('/work-attribute') ? '<html>login</html>' : JSON.stringify(new URL(u).pathname.endsWith('/field') ? fields : { version: '9.12' }), { status: 200 })) as unknown as typeof fetch;
    const c = createJiraClient({ id: 'i', kind: 'dc', baseUrl: 'https://h.example' }, 't', { fetchImpl });
    expect(await detectCapabilities(c)).toMatchObject({ tempo: false, epicLinkField: 'customfield_1' });
  });
  it('403 на Tempo — не молчим', async () => {
    const { c } = client('dc', (u) => (u.pathname.endsWith('/work-attribute') ? { status: 403, body: {} } : { body: [] }));
    await expect(detectCapabilities(c)).rejects.toMatchObject({ status: 403 });
  });
  it('Cloud: tempo=false, epicLinkField=null', async () => {
    const { c, urls } = client('cloud', (u) => (u.pathname.endsWith('/serverInfo') ? { body: { version: '1001.0' } } : undefined));
    expect(await detectCapabilities(c)).toMatchObject({ tempo: false, epicLinkField: null });
    expect(urls.some((u) => u.includes('tempo'))).toBe(false);
  });
});

describe('InstanceStore', () => {
  const mem = () => {
    const m = new Map<string, unknown>();
    return { get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d), update: async (k: string, v: unknown) => void m.set(k, v), keys: () => [...m.keys()] };
  };
  const make = () => {
    const secrets = new Map<string, string>();
    const store = new InstanceStore(mem() as never, { get: async (k: string) => secrets.get(k), store: async (k: string, v: string) => void secrets.set(k, v), delete: async (k: string) => void secrets.delete(k) } as never);
    return { store, secrets };
  };
  it('slug хоста', () => {
    expect(instanceIdFromUrl('https://atlassian.tatikoma.ru/jira/')).toBe('atlassian-tatikoma-ru-jira');
    expect(instanceIdFromUrl('https://Jira.Example.com')).toBe('jira-example-com');
  });
  it('CRUD: токен в SecretStorage, не в globalState', async () => {
    const { store, secrets } = make();
    const inst = { id: 'a', name: 'A', baseUrl: 'https://a.example', kind: 'dc' as const };
    await store.add(inst, 'tok');
    expect(store.list()).toEqual([inst]);
    expect(JSON.stringify(store.list())).not.toContain('tok');
    expect(secrets.get('jiraffe.token.a')).toBe('tok');
    await store.updateCaps('a', { tempo: true, epicLinkField: null, checkedAt: 'x' });
    expect(store.get('a')?.caps?.tempo).toBe(true);
    await store.remove('a');
    expect(store.list()).toEqual([]);
    expect(secrets.size).toBe(0);
  });
  it('замена с тем же id перезаписывает токен; упавший слушатель не мешает записи', async () => {
    const { store, secrets } = make();
    const inst = { id: 'a', name: 'A', baseUrl: 'https://a.example', kind: 'dc' as const };
    let fired = 0;
    store.onDidChange(() => { fired++; throw new Error('tree'); });
    await store.add(inst, 'old');
    await store.add({ ...inst, name: 'B' }, 'new');
    expect(store.list()).toEqual([{ ...inst, name: 'B' }]);
    expect(secrets.get('jiraffe.token.a')).toBe('new');
    expect(fired).toBe(2);
  });
});

describe('JiraClient.transitions', () => {
  it('маппит переходы, оставляет только обязательные поля без значения по умолчанию', async () => {
    const { c, urls } = client('dc', () => ({ body: { transitions: [
      { id: '11', name: 'В работу', to: { name: 'В работе', statusCategory: { key: 'indeterminate' } }, fields: {
        summary: { required: true, hasDefaultValue: true, name: 'Summary' },
      } },
      { id: '31', name: 'Закрыть', to: { name: 'Закрыта', statusCategory: { key: 'done' } }, fields: {
        resolution: { required: true, name: 'Решение', schema: { type: 'resolution' }, allowedValues: [{ id: '1', name: 'Fixed' }] },
        components: { required: true, name: 'Компоненты', schema: { type: 'array' }, allowedValues: [{ id: '5', name: 'API' }] },
        comment: { required: false, name: 'Comment' },
      } },
    ] } }));
    const ts = await c.transitions('T-1');
    expect(urls[0]).toContain('/rest/api/2/issue/T-1/transitions?expand=transitions.fields');
    expect(ts[0]).toEqual({ id: '11', name: 'В работу', to: { name: 'В работе', category: 'indeterminate' }, fields: [] });
    expect(ts[1].to.category).toBe('done');
    expect(ts[1].fields).toEqual([
      { id: 'resolution', name: 'Решение', array: false, allowedValues: [{ id: '1', name: 'Fixed' }] },
      { id: 'components', name: 'Компоненты', array: true, allowedValues: [{ id: '5', name: 'API' }] },
    ]);
  });

  it('transition шлёт id перехода и поля', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const c = createJiraClient({ id: 'i1', kind: 'dc', baseUrl: 'https://h.example/jira' }, 'tok', { fetchImpl });
    await c.transition('T-1', '31', { resolution: { id: '1' } });
    await c.transition('T-1', '11');
    expect(bodies).toEqual([{ transition: { id: '31' }, fields: { resolution: { id: '1' } } }, { transition: { id: '11' } }]);
  });
});
