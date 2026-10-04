import { describe, expect, it } from 'vitest';
import fixture from './fixtures/issue-dc.json';
import { createJiraClient } from '../src/jira/client';
import { epicFieldOf, mapEpic, mapHistory, mapIssueDetail, mapWorklog } from '../src/jira/mappers';
import { sanitizeDetail, sanitizeJiraHtml } from '../src/jira/sanitize';
import type { Instance } from '../src/jira/types';

const raw = fixture.issue as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const dc: Pick<Instance, 'id' | 'kind' | 'epicLinkField' | 'caps'> = {
  id: 'i1', kind: 'dc', caps: { tempo: true, epicLinkField: 'customfield_10100', checkedAt: '2026-01-01T00:00:00Z' },
};
const watchers = fixture.watchers.watchers.map((w) => ({ id: w.name, name: w.displayName }));

describe('mapIssueDetail (фикстура DC)', () => {
  const d = mapIssueDetail(dc, raw, watchers);

  it('основные поля', () => {
    expect(d).toMatchObject({
      instanceId: 'i1', key: 'ABC-123', summary: 'Fix export of the report to CSV', type: 'Задача',
      status: 'В работе', statusCategory: 'indeterminate', priority: 'Medium',
      assignee: { id: 'ivan.petrov', name: 'Ivan Petrov' }, reporter: { id: 'ivan.petrov', name: 'Ivan Petrov' },
      labels: ['backend', 'urgent'], components: ['API'], fixVersions: [{ id: '20001', name: '1.7.0' }],
      created: '2026-07-17T08:51:23.135+0300',
    });
    expect(d.due).toBeUndefined();
    expect(d.watchers).toHaveLength(2);
  });

  it('эпик из Epic Link (caps) и из переопределения инстанса', () => {
    expect(d.epic).toEqual({ key: 'ABC-100' });
    expect(mapIssueDetail({ ...dc, epicLinkField: 'customfield_99999' }, raw).epic).toBeUndefined(); // переопределение главнее caps
    expect(mapIssueDetail({ ...dc, caps: { ...dc.caps!, epicLinkField: null } }, raw).epic).toBeUndefined();
  });

  it('время: remaining/spent из timetracking', () => {
    expect(d.timetracking).toEqual({ remainingSec: 0, spentSec: 2400 });
  });

  it('описание — rendered HTML; комментарии — rendered по id, автор по name', () => {
    expect(d.descriptionHtml).toContain('<h2>');
    expect(d.comments).toHaveLength(2);
    expect(d.comments[0]).toMatchObject({ id: '50000', author: { id: 'ivan.petrov' }, bodyHtml: '<p>Looks reproducible, taking it.</p>' });
    expect(d.comments[1].bodyHtml).toContain('<ol>');
  });

  it('описание без renderedFields — экранированный plain, а не «не заполнено»', () => {
    const d2 = mapIssueDetail(dc, { ...raw, renderedFields: undefined, fields: { ...raw.fields, description: 'a <b>\nb' } });
    expect(d2.descriptionHtml).toBe('<p>a &lt;b&gt;<br>b</p>');
  });
  it('вложения: contentUrl и thumbnailUrl', () => {
    expect(d.attachments).toEqual([expect.objectContaining({ id: '40001', filename: 'report.png', size: 20480, mimeType: 'image/png', contentUrl: expect.stringContaining('/secure/attachment/40001/'), thumbnailUrl: expect.stringContaining('thumb') })]);
  });

  it('история: «было → стало», новые сверху, шум (WorklogId, timespent) вычищен', () => {
    const fields = d.history.flatMap((h) => h.items.map((i) => i.field));
    expect(fields).not.toContain('WorklogId');
    expect(fields).not.toContain('timespent');
    const times = d.history.map((h) => Date.parse(h.created));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const status = d.history.flatMap((h) => h.items).find((i) => i.field === 'status' && i.from === 'Open');
    expect(status).toEqual({ field: 'status', from: 'Open', to: 'In Progress' });
    const fix = d.history.flatMap((h) => h.items).find((i) => i.field === 'Fix Version');
    expect(fix).toEqual({ field: 'Fix Version', from: null, to: '1.7.0' });
  });

  it('worklog: секунды, автор, комментарий', () => {
    const w = mapWorklog('dc', fixture.worklog.worklogs[0]);
    expect(w).toMatchObject({ id: '60000', timeSpentSec: 2400, comment: 'Investigation and fix', author: { id: 'ivan.petrov' } });
    expect(w.started).toBe('2026-07-17T12:00:00.000+0300');
  });

  it('фикстура обезличена', () => {
    // Белый список вместо перечня настоящих имён: в фикстуре только example.test, ключи ABC и три выдуманных человека.
    const s = JSON.stringify(fixture);
    const hosts = new Set([...s.matchAll(/https?:\/\/([^/"\\:]+)/g)].map((m) => m[1]));
    expect([...hosts].every((h) => h.endsWith('example.test'))).toBe(true);
    expect(s).not.toMatch(/@(?!example\.test)[\w.-]+\.\w+/);
    expect(new Set([...s.matchAll(/\b([A-Z][A-Z0-9_]+)-\d+\b/g)].map((m) => m[1]))).toEqual(new Set(['ABC']));
    const names = new Set([...s.matchAll(/"displayName":"([^"]*)"/g)].map((m) => m[1]));
    expect([...names].every((n) => ['Ivan Petrov', 'Anna Smirnova', 'Oleg Sidorov'].includes(n))).toBe(true);
  });
});

describe('контракт эпика', () => {
  it('DC: instance.epicLinkField ?? caps.epicLinkField; Cloud — null (поле не используется)', () => {
    expect(epicFieldOf({ kind: 'dc', epicLinkField: 'cf_1', caps: { tempo: false, epicLinkField: 'cf_2', checkedAt: '' } })).toBe('cf_1');
    expect(epicFieldOf({ kind: 'dc', caps: { tempo: false, epicLinkField: 'cf_2', checkedAt: '' } })).toBe('cf_2');
    expect(epicFieldOf({ kind: 'dc' })).toBeNull();
    expect(epicFieldOf({ kind: 'cloud', caps: { tempo: false, epicLinkField: 'cf_2', checkedAt: '' } })).toBeNull();
  });

  it('Cloud: parent с hierarchyLevel 1 — эпик (с названием), родитель подзадачи — нет', () => {
    const epic = { parent: { key: 'ABC-1', fields: { summary: 'Epic S', issuetype: { name: 'Epic', hierarchyLevel: 1 } } } };
    const sub = { parent: { key: 'ABC-2', fields: { summary: 'Task S', issuetype: { name: 'Task', hierarchyLevel: 0 } } } };
    expect(mapEpic('cloud', null, epic)).toEqual({ key: 'ABC-1', summary: 'Epic S' });
    expect(mapEpic('cloud', null, sub)).toBeUndefined();
    expect(mapEpic('cloud', null, {})).toBeUndefined();
    // на Cloud кастомное поле не смотрим, даже если его передали
    expect(mapEpic('cloud', 'customfield_10014', { customfield_10014: 'ABC-9' })).toBeUndefined();
  });
});

describe('mapHistory', () => {
  it('запись только из шума отбрасывается', () => {
    const h = mapHistory('dc', { histories: [{ created: '2026-01-01T00:00:00.000+0000', author: { name: 'a', displayName: 'A' }, items: [{ field: 'timespent', toString: '60' }] }] });
    expect(h).toEqual([]);
  });
});

describe('sanitize', () => {
  const base = 'https://h.example/jira';
  it('вычищает скрипты, обработчики, style и javascript:-ссылки; текст остаётся', () => {
    const out = sanitizeJiraHtml('<p onclick="x()" style="color:red">a<script>alert(1)</script><iframe src="//e"></iframe> <a href="javascript:alert(1)">bad</a> <a href="data:text/html,x">d</a></p>', base);
    expect(out).not.toMatch(/script|onclick|style|iframe|javascript:|data:/i);
    expect(out).toContain('a');
    expect(out).toContain('bad');
  });
  it('ссылки: относительные → абсолютные от origin, пустые якоря удалены, tt → code', () => {
    const out = sanitizeJiraHtml('<h2><a name="X"></a>Head</h2><a href="/jira/browse/ABC-1" class="external-link">k</a><tt>t</tt>', base);
    expect(out).toBe('<h2>Head</h2><a href="https://h.example/jira/browse/ABC-1">k</a><code>t</code>');
  });
  it('img → плейсхолдер с data-src, сам img не пропускается', () => {
    const out = sanitizeJiraHtml('<p><img src="/jira/secure/attachment/1/a.png" alt="shot"></p>', base);
    expect(out).not.toContain('<img');
    expect(out).toContain('class="img-ph"');
    expect(out).toContain('data-src="https://h.example/jira/secure/attachment/1/a.png"');
    expect(out).toContain('[картинка]');
  });
  it('data-src — только своя картинка (origin + context path); чужая — ссылкой, без data-src (токен не уйдёт наружу)', () => {
    for (const src of ['https://evil.example/p.png', '//evil.example/p.png', 'https://h.example.evil.example/jira/a.png', 'http://h.example:8080/jira/a.png', '/secure/admin/x.png']) {
      const out = sanitizeJiraHtml(`<img src="${src}">`, base);
      expect(out).not.toContain('data-src');
      expect(out).toMatch(/^<a href="https?:\/\/[^"]+">\[внешняя картинка\]<\/a>$/);
    }
    expect(sanitizeJiraHtml('<img src="/secure/attachment/1/a.png">', 'https://h.example')).toContain('data-src="https://h.example/secure/attachment/1/a.png"');
  });
  it('якоря #… теряют href, относительный путь без / — от baseUrl (context path сохраняется)', () => {
    expect(sanitizeJiraHtml('<a href="#sec">s</a><a href="browse/ABC-1">k</a>', base)).toBe('<a>s</a><a href="https://h.example/jira/browse/ABC-1">k</a>');
  });
  it('img-ph/data-src из самого HTML Jira не пропускаются; data-src только http(s)', () => {
    expect(sanitizeJiraHtml('<span class="img-ph" data-src="https://h.example/rest/api/2/myself" title="t">x</span>', base)).toBe('<span title="t">x</span>');
    for (const src of ['javascript:alert(1)', 'data:image/png;base64,AAA', 'file:///etc/passwd']) {
      const out = sanitizeJiraHtml(`<img src="${src}">`, base);
      expect(out).toContain('class="img-ph"');
      expect(out).not.toContain('data-src');
    }
  });
  it('чужие class не пропускаются (кроме img-ph)', () => {
    expect(sanitizeJiraHtml('<span class="btn pri">x</span><div class="code panel">y</div>', base)).toBe('<span>x</span><div>y</div>');
  });
  it('sanitizeDetail чистит описание и комментарии, не мутирует исходник', () => {
    const d = mapIssueDetail(dc, { ...raw, renderedFields: { ...raw.renderedFields, description: '<p>ok<script>1</script></p>' } });
    const s = sanitizeDetail(d, base);
    expect(s.descriptionHtml).toBe('<p>ok</p>');
    expect(d.descriptionHtml).toContain('<script>');
  });
});

describe('JiraClient: карточка', () => {
  function client(route: (u: URL) => { status?: number; body: unknown } | undefined, kind: 'dc' | 'cloud' = 'dc') {
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(u);
      const r = route(new URL(u));
      return r ? new Response(JSON.stringify(r.body), { status: r.status ?? 200 }) : new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    return { c: createJiraClient({ id: 'i1', kind, baseUrl: 'https://h.example', email: 'a@b.c' }, 'tok', { fetchImpl }), urls };
  }

  it('issueDetail: expand=renderedFields,changelog, watchers, worklog; название эпика DC дозапрашивается', async () => {
    const { c, urls } = client((u) => {
      if (u.pathname === '/rest/api/2/issue/ABC-123') return { body: raw };
      if (u.pathname === '/rest/api/2/issue/ABC-100') return { body: { fields: { summary: 'Epic title' } } };
      if (u.pathname.endsWith('/watchers')) return { body: fixture.watchers };
      if (u.pathname.endsWith('/worklog')) return { body: fixture.worklog };
      return undefined;
    });
    const { issue, worklogs } = await c.issueDetail('ABC-123', dc);
    const main = urls.map((x) => new URL(x)).find((u) => u.pathname === '/rest/api/2/issue/ABC-123')!;
    expect(main.searchParams.get('expand')).toBe('renderedFields,changelog');
    expect(issue.epic).toEqual({ key: 'ABC-100', summary: 'Epic title' });
    expect(issue.watchers).toHaveLength(2);
    expect(worklogs).toHaveLength(1);
  });

  it('watchers и worklog: 403 — пустой список, а не ошибка карточки; название эпика не критично', async () => {
    const { c } = client((u) => {
      if (u.pathname === '/rest/api/2/issue/ABC-123') return { body: raw };
      if (u.pathname.endsWith('/watchers') || u.pathname.endsWith('/worklog')) return { status: 403, body: { errorMessages: ['no'] } };
      return { status: 500, body: {} };
    });
    const { issue, worklogs, worklogError } = await c.issueDetail('ABC-123', dc);
    expect(issue.watchers).toEqual([]);
    expect(worklogs).toEqual([]);
    expect(worklogError).toBeUndefined();
    expect(issue.epic).toEqual({ key: 'ABC-100' });
  });

  it('watchers и worklog: 500 — карточка есть, журнал пуст с текстом ошибки; ошибка самой задачи — ошибка карточки', async () => {
    const { c } = client((u) => {
      if (u.pathname === '/rest/api/2/issue/ABC-123') return { body: raw };
      return { status: 500, body: { errorMessages: ['boom'] } };
    });
    const r = await c.issueDetail('ABC-123', dc);
    expect(r.issue.watchers).toEqual([]);
    expect(r.worklogs).toEqual([]);
    expect(r.worklogError).toBeTruthy();
    expect(r.worklogError).not.toContain('tok');
    const { c: c2 } = client(() => ({ status: 500, body: {} }));
    await expect(c2.issueDetail('ABC-123', dc)).rejects.toThrow();
  });

  it('Cloud: эпик из parent, дозапроса эпика нет, watchers по accountId', async () => {
    const cloudRaw = { key: 'X-2', fields: { summary: 's', issuetype: { name: 'Task' }, status: { name: 'To Do', statusCategory: { key: 'new' } }, parent: { key: 'X-1', fields: { summary: 'Epic', issuetype: { hierarchyLevel: 1 } } }, comment: { comments: [] } } };
    const { c, urls } = client((u) => {
      if (u.pathname === '/rest/api/2/issue/X-2') return { body: cloudRaw };
      if (u.pathname.endsWith('/watchers')) return { body: { watchers: [{ accountId: 'acc1', displayName: 'Anna' }] } };
      if (u.pathname.endsWith('/worklog')) return { body: { worklogs: [] } };
      return undefined;
    }, 'cloud');
    const { issue } = await c.issueDetail('X-2', { id: 'c', kind: 'cloud' });
    expect(issue.epic).toEqual({ key: 'X-1', summary: 'Epic' });
    expect(issue.watchers).toEqual([{ id: 'acc1', name: 'Anna' }]);
    expect(urls.some((u) => u.includes('/issue/X-1'))).toBe(false);
  });
});
