import { describe, expect, it, vi } from 'vitest';
import { createApi, type ApiDeps } from '../src/api';
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
    ...over,
  };
}

describe('JiraffeApi v1', () => {
  it('форма API по контракту', () => {
    const api = createApi(deps());
    expect(api.apiVersion).toBe(1);
    expect(Object.keys(api).sort()).toEqual(['apiVersion', 'instances', 'issue', 'myself', 'onDidChangeInstances', 'openIssue']);
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
