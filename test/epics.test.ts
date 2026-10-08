import { describe, expect, it } from 'vitest';
import { createJiraClient } from '../src/jira/client';
import {
  MAX_PAGES, daysBetween, epicChildrenJql, epicsJql, loadEpics, mapListIssue, percent, priorityRank, progressOf, releaseIssuesJql, sortIssues, sortVersions,
} from '../src/jira/epics';
import { mapVersion } from '../src/jira/mappers';
import type { Version } from '../src/jira/types';
import { epicNames, listRow, loadEpicPage, loadReleasePage, releaseUrl } from '../src/panels/list';
import { isVersionId, isIssueKey } from '../src/panels/protocol';
import { SectionProject, sanitizeProjectSel } from '../src/state/sectionProject';
import { JiraError } from '../src/jira/http';
import { MAX_RELEASED, progressLabel, projectErrorText, visibleVersions } from '../src/views/format';
import { renderEpicPage, renderReleasePage, segBar, sortRows } from '../webview/listRender';
import type { EpicPage, ReleasePage } from '../src/panels/protocol';

const dc = { kind: 'dc' as const, epicLinkField: 'customfield_10100', caps: undefined };
const dcCaps = { kind: 'dc' as const, caps: { tempo: false, epicLinkField: 'customfield_10102', checkedAt: '' } };
const cloud = { kind: 'cloud' as const, caps: { tempo: false, epicLinkField: null, checkedAt: '' } };

describe('JQL эпиков и релизов', () => {
  it('эпики проекта: по имени типа и по id', () => {
    expect(epicsJql('ABC')).toBe('project = ABC AND issuetype = Epic AND resolution = Unresolved ORDER BY created DESC');
    expect(epicsJql('ABC', ['10000', '10001'])).toBe('project = ABC AND issuetype in (10000, 10001) AND resolution = Unresolved ORDER BY created DESC');
    expect(epicsJql('ABC', ['x; DROP'])).toContain('issuetype = Epic');
    expect(epicsJql('my proj')).toContain('project = "my proj"');
  });
  it('эпики проекта: фильтр «мои» и поиск по названию', () => {
    expect(epicsJql('ABC', undefined, { mine: true })).toBe('project = ABC AND issuetype = Epic AND resolution = Unresolved AND assignee = currentUser() ORDER BY created DESC');
    expect(epicsJql('ABC', undefined, { text: '  [UI]  релиз ' })).toBe('project = ABC AND issuetype = Epic AND resolution = Unresolved AND summary ~ "\\\\[UI\\\\] релиз" ORDER BY created DESC');
    expect(epicsJql('ABC', undefined, { mine: false, text: ' ' })).toBe(epicsJql('ABC'));
  });
  it('задачи эпика: DC — cf[id], поле из настроек приоритетнее caps; Cloud — parent', () => {
    expect(epicChildrenJql(dc, ['ABC-1'])).toBe('cf[10100] = ABC-1');
    expect(epicChildrenJql(dcCaps, ['ABC-1', 'ABC-2'])).toBe('cf[10102] in (ABC-1, ABC-2)');
    expect(epicChildrenJql({ ...dcCaps, epicLinkField: 'customfield_10100' }, ['ABC-1'])).toBe('cf[10100] = ABC-1');
    expect(epicChildrenJql(cloud, ['ABC-1'])).toBe('parent = ABC-1');
    expect(epicChildrenJql({ kind: 'cloud', epicLinkField: 'customfield_10014', caps: undefined }, ['ABC-1'])).toBe('parent = ABC-1');
  });
  it('DC без поля Epic Link и мусорные ключи — null', () => {
    expect(epicChildrenJql({ kind: 'dc', caps: { tempo: false, epicLinkField: null, checkedAt: '' } }, ['ABC-1'])).toBeNull();
    expect(epicChildrenJql(dc, ['ABC-1) OR (1=1'])).toBeNull();
    expect(epicChildrenJql(dc, [])).toBeNull();
  });
  it('релиз: fixVersion = id, только числа', () => {
    expect(releaseIssuesJql('10610')).toBe('fixVersion = 10610');
    expect(releaseIssuesJql('1 OR 2')).toBeNull();
    expect(isVersionId('10610') && !isVersionId('a') && isIssueKey('ABC-1') && !isIssueKey('abc')).toBe(true);
  });
});

describe('прогресс', () => {
  it('по statusCategory', () => {
    const p = progressOf(['done', 'done', 'indeterminate', 'new', 'new']);
    expect(p).toEqual({ total: 5, done: 2, prog: 1, todo: 2 });
    expect(percent(p)).toBe(40);
    expect(percent(progressOf([]))).toBe(0);
  });
  it('подпись в дереве', () => {
    expect(progressLabel({ key: 'A-1', summary: '', status: '', statusCategory: 'new', progress: progressOf(['done', 'new']) })).toBe('1/2');
    expect(progressLabel({ key: 'A-1', summary: '', status: '', statusCategory: 'new', progress: progressOf(['done']), partial: true })).toBe('1/1+');
    expect(progressLabel({ key: 'A-1', summary: '', status: '', statusCategory: 'new' })).toBeUndefined();
  });
});

describe('версии', () => {
  const v = (id: string, name: string, released: boolean, releaseDate?: string, archived = false): Version => ({ id, name, released, archived, overdue: false, ...(releaseDate ? { releaseDate } : {}) });
  it('mapVersion', () => {
    expect(mapVersion({ id: 5, name: '1.0', released: true, releaseDate: '2026-02-03', startDate: '2026-01-01', projectId: 7, description: 'd', archived: false }))
      .toEqual({ id: '5', name: '1.0', released: true, archived: false, overdue: false, description: 'd', startDate: '2026-01-01', releaseDate: '2026-02-03', projectId: '7' });
    expect(mapVersion({ id: 1, name: 'x' }).releaseDate).toBeUndefined();
  });
  it('порядок: не выпущенные по дате (без даты в конце), затем выпущенные свежие сверху, архивные скрыты', () => {
    const s = sortVersions([v('1', 'r-old', true, '2025-01-01'), v('2', 'u-late', false, '2026-12-01'), v('3', 'u-none', false), v('4', 'u-soon', false, '2026-11-01'), v('5', 'r-new', true, '2025-06-01'), v('6', 'arch', true, '2024-01-01', true)]);
    expect(s.map((x) => x.name)).toEqual(['u-soon', 'u-late', 'u-none', 'r-new', 'r-old']);
  });
  it('дерево: все не выпущенные + не больше MAX_RELEASED выпущенных', () => {
    const all = [v('u', 'u', false), ...Array.from({ length: MAX_RELEASED + 5 }, (_, i) => v(`r${i}`, `r${i}`, true, `2025-01-${String((i % 28) + 1).padStart(2, '0')}`))];
    const r = visibleVersions(all);
    expect(r.versions).toHaveLength(MAX_RELEASED + 1);
    expect(r.hidden).toBe(5);
  });
  it('daysBetween без сдвига по поясам', () => {
    expect(daysBetween('2026-10-04', '2026-10-14')).toBe(10);
    expect(daysBetween('2026-10-04', '2026-10-01')).toBe(-3);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
  });
  it('адрес «Открыть в Jira» для релиза', () => {
    expect(releaseUrl('https://h.example/jira/', 'ABC', '5')).toBe('https://h.example/jira/projects/ABC/versions/5');
    expect(releaseUrl('https://h.example', 'ABC', '5')).toBe('https://h.example/projects/ABC/versions/5');
    expect(releaseUrl('https://h.example', '', '5')).toBeUndefined();
  });
});

describe('строки таблицы', () => {
  const raw = (key: string, cat: string, prio: string, extra: object = {}) => ({
    key, fields: { summary: `S ${key}`, issuetype: { name: 'Task' }, status: { name: 'St', statusCategory: { key: cat } }, priority: { name: prio }, assignee: { name: 'ivan', displayName: 'Ivan' }, updated: '', ...extra },
  });
  it('сортировка: в работе, не начато, готово; внутри — приоритет и номер', () => {
    const rows = ['ABC-10', 'ABC-2', 'ABC-3', 'ABC-4'].map((k, i) => mapListIssue('i', dc, raw(k, ['done', 'new', 'indeterminate', 'new'][i], ['High', 'Low', 'Low', 'Highest'][i])));
    expect(sortIssues(rows).map((r) => r.key)).toEqual(['ABC-3', 'ABC-4', 'ABC-2', 'ABC-10']);
    expect(priorityRank('Blocker') < priorityRank('Medium')).toBe(true);
  });
  it('DC: эпик из Epic Link, релиз из fixVersions; Cloud: parent только уровня 1', () => {
    const d = mapListIssue('i', dc, raw('ABC-1', 'new', 'High', { customfield_10100: 'ABC-9', fixVersions: [{ name: '1.0' }, { name: '1.1' }] }));
    expect(d.epicKey).toBe('ABC-9');
    expect(d.fixVersion).toBe('1.0, 1.1');
    const c1 = mapListIssue('i', cloud, raw('ABC-1', 'new', 'High', { parent: { key: 'ABC-9', fields: { summary: 'E', issuetype: { hierarchyLevel: 1 } } } }));
    expect(c1.epicKey).toBe('ABC-9');
    expect(c1.epicName).toBe('E');
    const c2 = mapListIssue('i', cloud, raw('ABC-2', 'new', 'High', { parent: { key: 'ABC-1', fields: { summary: 'T', issuetype: { hierarchyLevel: 0 } } } }));
    expect(c2.epicKey).toBeUndefined();
  });
});

type Route = (url: URL) => unknown;
function mk(kind: 'dc' | 'cloud', route: Route) {
  const urls: string[] = [];
  const fetchImpl = (async (u: string) => {
    urls.push(u);
    const b = route(new URL(u));
    return b === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(b), { status: 200 });
  }) as unknown as typeof fetch;
  return { c: createJiraClient({ id: 'i', kind, baseUrl: 'https://h.example', email: 'a@b.c' }, 'tok', { fetchImpl }), urls };
}
const item = (key: string, cat: string, f: object = {}) => ({ key, fields: { summary: `S ${key}`, status: { name: 'St', statusCategory: { key: cat } }, issuetype: { name: 'Task' }, ...f } });

describe('loadEpics', () => {
  it('DC: эпики и прогресс одним запросом по `cf[id] in (…)`', async () => {
    const { c, urls } = mk('dc', (u) => {
      const jql = u.searchParams.get('jql') ?? '';
      if (jql.startsWith('project = ABC')) return { total: 2, issues: [item('ABC-1', 'new'), item('ABC-2', 'new')] };
      if (jql.startsWith('cf[10100] in (ABC-1, ABC-2)')) return { total: 3, issues: [item('X-1', 'done', { customfield_10100: 'ABC-1' }), item('X-2', 'new', { customfield_10100: 'ABC-1' }), item('X-3', 'indeterminate', { customfield_10100: 'ABC-2' })] };
      return undefined;
    });
    const r = await loadEpics(c, dc, 'ABC', { maxResults: 50 });
    expect(r.epics.map((e) => e.progress)).toEqual([{ total: 2, done: 1, prog: 0, todo: 1 }, { total: 1, done: 0, prog: 1, todo: 0 }]);
    expect(urls).toHaveLength(2);
    expect(r.next).toBeUndefined();
  });
  it('DC: JQL с `issuetype = Epic` дал 400 (русская локаль) — повтор по id типа', async () => {
    let first = true;
    const fetchImpl = (async (u: string) => {
      const url = new URL(u);
      const jql = url.searchParams.get('jql') ?? '';
      if (url.pathname.endsWith('/issuetype')) return new Response(JSON.stringify([{ id: '10000', name: 'Эпик' }, { id: '2', name: 'Task' }]), { status: 200 });
      if (jql.includes('issuetype = Epic') && first) { first = false; return new Response('{"errorMessages":["no such type"]}', { status: 400 }); }
      if (jql.includes('issuetype in (10000)')) return new Response(JSON.stringify({ total: 1, issues: [item('ABC-1', 'new')] }), { status: 200 });
      return new Response(JSON.stringify({ total: 0, issues: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createJiraClient({ id: 'i', kind: 'dc', baseUrl: 'https://h.example' }, 'tok', { fetchImpl });
    const r = await loadEpics(c, dc, 'ABC');
    expect(r.epics.map((e) => e.key)).toEqual(['ABC-1']);
    expect(r.jql).toContain('issuetype in (10000)');
  });
  it('Cloud: типы уровня 1 из проекта, прогресс по parent', async () => {
    const { c } = mk('cloud', (u) => {
      if (u.pathname === '/rest/api/2/project/ABC') return { issueTypes: [{ id: '10001', name: 'Epic', hierarchyLevel: 1 }, { id: '10003', name: 'Task', hierarchyLevel: 0 }] };
      const jql = u.searchParams.get('jql') ?? '';
      if (jql.includes('issuetype in (10001)')) return { issues: [item('ABC-1', 'new')], isLast: true };
      if (jql.startsWith('parent = ABC-1')) return { issues: [item('ABC-5', 'done', { parent: { key: 'ABC-1' } })], isLast: true };
      return undefined;
    });
    const r = await loadEpics(c, cloud, 'ABC');
    expect(r.epics[0].progress).toEqual({ total: 1, done: 1, prog: 0, todo: 0 });
  });
  it('DC без Epic Link: эпики есть, прогресса нет; ошибка прогресса не роняет список', async () => {
    const noField = { kind: 'dc' as const, caps: { tempo: false, epicLinkField: null, checkedAt: '' } };
    const a = mk('dc', () => ({ total: 1, issues: [item('ABC-1', 'new')] }));
    expect((await loadEpics(a.c, noField, 'ABC')).epics[0].progress).toBeUndefined();
    const b = mk('dc', (u) => ((u.searchParams.get('jql') ?? '').startsWith('project') ? { total: 1, issues: [item('ABC-1', 'new')] } : undefined));
    expect((await loadEpics(b.c, dc, 'ABC')).epics[0].progress).toBeUndefined();
    // Поле из настроек не вида customfield_N: в JQL не подставить — прогресса нет (а не «0/0»).
    const badField = { kind: 'dc' as const, epicLinkField: 'Epic Link', caps: undefined };
    const d = mk('dc', () => ({ total: 1, issues: [item('ABC-1', 'new')] }));
    expect((await loadEpics(d.c, badField, 'ABC')).epics[0].progress).toBeUndefined();
  });
});

describe('страницы эпика и релиза', () => {
  it('эпик: заголовок, строки отсортированы, прогресс; Epic Link в ответе', async () => {
    const { c } = mk('dc', (u) => {
      if (u.pathname.endsWith('/issue/ABC-1')) return { key: 'ABC-1', fields: { summary: 'Epic <b>', status: { name: 'Open', statusCategory: { key: 'new' } }, project: { key: 'ABC' } } };
      return { total: 2, issues: [item('ABC-5', 'done', { fixVersions: [{ name: '1.0' }] }), item('ABC-6', 'indeterminate')] };
    });
    const p = await loadEpicPage(c, { id: 'i', name: 'Sample', ...dc }, 'ABC-1');
    expect(p.rows.map((r) => r.key)).toEqual(['ABC-6', 'ABC-5']);
    expect(p.rows[1].extra).toBe('1.0');
    expect(p.progress.done).toBe(1);
    expect(p.link).toBe('customfield_10100');
  });
  it('релиз: версия, задачи, названия эпиков с DC одним запросом', async () => {
    const { c, urls } = mk('dc', (u) => {
      if (u.pathname.endsWith('/version/5')) return { id: '5', name: '1.0', released: false, releaseDate: '2026-10-14', projectId: '77' };
      const jql = u.searchParams.get('jql') ?? '';
      if (jql.startsWith('fixVersion = 5')) return { total: 2, issues: [item('ABC-1', 'new', { customfield_10100: 'ABC-9' }), item('ABC-2', 'done', { customfield_10100: 'ABC-9' })] };
      if (jql.startsWith('key in (ABC-9)')) return { total: 1, issues: [item('ABC-9', 'new')] };
      return undefined;
    });
    const p = await loadReleasePage(c, { id: 'i', name: 'Sample', ...dc }, '5', (pid) => (pid === '77' ? 'ABC' : undefined), '2026-10-04');
    expect(p.project).toBe('ABC');
    expect(p.daysLeft).toBe(10);
    expect(p.rows.map((r) => r.extra)).toEqual(['S ABC-9', 'S ABC-9']);
    expect(urls.filter((u) => u.includes('key+in') || u.includes('key%20in')).length).toBe(1);
    expect((await epicNames(c, ['bad key', 'ABC-9'])).get('ABC-9')).toBe('S ABC-9');
  });
});

describe('разметка', () => {
  const base = { instanceId: 'i', instanceName: 'Sample <i>', project: 'ABC', progress: progressOf(['done', 'new']), truncated: false };
  const row = { key: 'ABC-1', summary: 'S <img src=x onerror=1>', type: 'Bug', status: 'Open', statusCategory: 'new' as const, extra: '1.0 "x"' };
  it('эпик: экранирование, строка открывает карточку, без inline-стилей', () => {
    const page: EpicPage = { ...base, type: 'epic', key: 'ABC-9', summary: 'E <script>', status: 'Open', statusCategory: 'new', link: 'customfield_10100', kind: 'dc', rows: [row] };
    const html = renderEpicPage(page);
    expect(html).not.toMatch(/<script|<img| style=/);
    expect(html).toContain('&lt;img src=x');
    expect(html).toContain('data-act="open" data-key="ABC-1"');
    expect(html).toContain('1 of 2');
    expect(html).toContain('customfield_10100');
  });
  it('эпик на DC без поля — пояснение, не пустая таблица', () => {
    const html = renderEpicPage({ ...base, type: 'epic', key: 'ABC-9', summary: 'E', status: 'Open', statusCategory: 'new', link: null, kind: 'dc', rows: [], progress: progressOf([]) });
    expect(html).toContain('The Epic Link field was not found');
  });
  it('релиз: даты, осталось/просрочен, пустая версия', () => {
    const page: ReleasePage = { ...base, type: 'release', id: '5', name: 'R <b>', released: false, releaseDate: '2026-10-14', daysLeft: 10, rows: [row] };
    expect(renderReleasePage(page)).toContain('10 d left');
    expect(renderReleasePage({ ...page, daysLeft: -2 })).toContain('overdue by 2 d');
    expect(renderReleasePage({ ...page, rows: [], progress: progressOf([]) })).toContain('This version has no issues yet');
    expect(renderReleasePage(page)).not.toMatch(/<b>R|<b>\s*<\/b>R/);
  });
  it('сортировка по колонке: заголовок-кнопка, стрелка, aria-sort', () => {
    const page: ReleasePage = { ...base, type: 'release', id: '5', name: 'R', released: false, rows: [row, { ...row, key: 'ABC-10' }, { ...row, key: 'ABC-9' }] };
    const keys = (html: string): string[] => [...html.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]);
    expect(keys(renderReleasePage(page))).toEqual(['ABC-1', 'ABC-10', 'ABC-9']);
    const html = renderReleasePage(page, { col: 'key', desc: false });
    expect(keys(html)).toEqual(['ABC-1', 'ABC-9', 'ABC-10']);
    expect(html).toMatch(/aria-sort="ascending"><button class="th-sort on" data-act="sort" data-col="key"/);
    expect(keys(renderReleasePage(page, { col: 'key', desc: true }))).toEqual(['ABC-10', 'ABC-9', 'ABC-1']);
  });
  it('sortRows: приоритет по рангу, пустые в конце в обе стороны, стабильность', () => {
    const r = (key: string, o: Partial<typeof row> & { priority?: string; assignee?: { id: string; name: string } }) => ({ ...row, key, ...o });
    const rows = [r('A-1', { priority: 'Low' }), r('A-2', {}), r('A-3', { priority: 'Highest' }), r('A-4', { priority: 'Medium' }), r('A-5', { priority: 'Lowest' })];
    expect(sortRows(rows, { col: 'priority', desc: true }).map((x) => x.key)).toEqual(['A-3', 'A-4', 'A-1', 'A-5', 'A-2']);
    expect(sortRows(rows, { col: 'priority', desc: false }).map((x) => x.key)).toEqual(['A-1', 'A-5', 'A-4', 'A-3', 'A-2']);
    const people = [r('B-1', { assignee: { id: '2', name: 'Борис' } }), r('B-2', {}), r('B-3', { assignee: { id: '1', name: 'Анна' } })];
    expect(sortRows(people, { col: 'assignee', desc: true }).map((x) => x.key)).toEqual(['B-1', 'B-3', 'B-2']);
    expect(sortRows(rows, undefined)).toBe(rows);
  });
  it('полоса: ширины через data-w', () => {
    expect(segBar(progressOf(['done', 'new', 'new', 'indeterminate']))).toMatch(/b-done" data-w="25.0".*b-prog" data-w="25.0"/);
    expect(segBar(progressOf([]))).toContain('data-w="0"');
  });
});

describe('выбор проекта раздела', () => {
  it('sanitize и хранение', () => {
    expect(sanitizeProjectSel({ instanceId: 'i', key: 'ABC' })).toEqual({ instanceId: 'i', key: 'ABC' });
    expect(sanitizeProjectSel({ instanceId: 1, key: 'ABC' })).toBeUndefined();
    expect(sanitizeProjectSel(null)).toBeUndefined();
    const store = new Map<string, unknown>();
    const memento = { get: (k: string) => store.get(k), update: async (k: string, v: unknown) => void store.set(k, v), keys: () => [...store.keys()] };
    const sp = new SectionProject(memento as never, 'k');
    let fired = 0;
    sp.onDidChange(() => fired++);
    expect(sp.get()).toBeUndefined();
    sp.set({ instanceId: 'i', key: 'ABC' });
    expect(sp.get()).toEqual({ instanceId: 'i', key: 'ABC' });
    expect(fired).toBe(1);
  });
});

describe('доводка приёмки этапа 7', () => {
  const v = (id: string, name: string, released: boolean): Version => ({ id, name, released, archived: false, overdue: false });
  it('версии без дат — в порядке проекта (выпущенные — свежие сверху), а не строкой по имени', () => {
    const s = sortVersions([v('1', '1.2', true), v('2', '1.9', true), v('3', '1.10', true), v('4', '2.0', false), v('5', '1.11', false)]);
    expect(s.map((x) => x.name)).toEqual(['2.0', '1.11', '1.10', '1.9', '1.2']);
    const many = Array.from({ length: MAX_RELEASED + 5 }, (_, i) => v(String(i + 1), `1.${i + 1}`, true));
    const shown = visibleVersions(many);
    expect(shown.versions[0].name).toBe(`1.${MAX_RELEASED + 5}`);
    expect(shown.versions.map((x) => x.id)).not.toContain('1');
    expect(shown.hidden).toBe(5);
  });
  it('percent: 100 — только когда готово всё', () => {
    expect(percent({ total: 200, done: 199, prog: 1, todo: 0 })).toBe(99);
    expect(percent({ total: 3, done: 3, prog: 0, todo: 0 })).toBe(100);
  });
  it('лимит задач в пачке прогресса: `partial`, эпик без прочитанных задач — без прогресса (не «0/0+»)', async () => {
    let n = 0;
    const { c } = mk('dc', (u) => {
      const jql = u.searchParams.get('jql') ?? '';
      if (jql.startsWith('project = ABC')) return { total: 2, issues: [item('ABC-1', 'new'), item('ABC-2', 'new')] };
      if (jql.startsWith('cf[10100] in')) {
        n++;
        const start = Number(u.searchParams.get('startAt') ?? 0);
        return { total: 5000, issues: Array.from({ length: 100 }, (_, i) => item(`X-${start + i + 1}`, 'done', { customfield_10100: 'ABC-1' })) };
      }
      return undefined;
    });
    const r = await loadEpics(c, dc, 'ABC');
    expect(n).toBe(MAX_PAGES);
    expect(r.epics[0]).toMatchObject({ partial: true, progress: { total: MAX_PAGES * 100, done: MAX_PAGES * 100 } });
    expect(progressLabel(r.epics[0])).toBe(`${MAX_PAGES * 100}/${MAX_PAGES * 100}+`);
    expect(r.epics[1].partial).toBe(true);
    expect(r.epics[1].progress).toBeUndefined();
  });
  it('больше 10 эпиков — несколько пачек, у каждой свой запрос', async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `ABC-${i + 1}`);
    const { c, urls } = mk('dc', (u) => {
      const jql = u.searchParams.get('jql') ?? '';
      if (jql.startsWith('project = ABC')) return { total: 12, issues: keys.map((k) => item(k, 'new')) };
      if (jql.startsWith('cf[10100] in (ABC-11, ABC-12)')) return { total: 1, issues: [item('X-2', 'indeterminate', { customfield_10100: 'ABC-12' })] };
      if (jql.startsWith('cf[10100] in (ABC-1, ')) return { total: 1, issues: [item('X-1', 'done', { customfield_10100: 'ABC-3' })] };
      return undefined;
    });
    const r = await loadEpics(c, dc, 'ABC');
    expect(urls.filter((x) => decodeURIComponent(x.replace(/\+/g, ' ')).includes('cf[10100] in'))).toHaveLength(2);
    expect(r.epics.find((e) => e.key === 'ABC-3')?.progress).toEqual({ total: 1, done: 1, prog: 0, todo: 0 });
    expect(r.epics.find((e) => e.key === 'ABC-12')?.progress).toEqual({ total: 1, done: 0, prog: 1, todo: 0 });
    expect(r.epics.find((e) => e.key === 'ABC-5')?.progress).toEqual({ total: 0, done: 0, prog: 0, todo: 0 });
  });
  describe('фолбэк русской локали не срабатывает лишний раз и не подменяет ошибку', () => {
    const run = async (kind: 'dc' | 'cloud', handler: (url: URL) => Response) => {
      const urls: string[] = [];
      const fetchImpl = (async (u: string) => { urls.push(u); return handler(new URL(u)); }) as unknown as typeof fetch;
      const c = createJiraClient({ id: 'i', kind, baseUrl: 'https://h.example', email: 'a@b.c' }, 'tok', { fetchImpl });
      const err = await loadEpics(c, kind === 'dc' ? dc : cloud, 'ABC').then(() => undefined, (e: unknown) => e as Error);
      return { urls, err };
    };
    const bad = (msg: string, status = 400) => new Response(JSON.stringify({ errorMessages: [msg] }), { status });
    it('DC: типа Epic/Эпик нет — исходная ошибка', async () => {
      const { err } = await run('dc', (u) => (u.pathname.endsWith('/issuetype') ? new Response('[{"id":"2","name":"Task"}]', { status: 200 }) : bad('ORIGINAL')));
      expect(err?.message).toContain('ORIGINAL');
    });
    it('DC: повтор по id тоже 400 — исходная ошибка; справочник типов упал — исходная ошибка', async () => {
      const a = await run('dc', (u) => {
        if (u.pathname.endsWith('/issuetype')) return new Response('[{"id":"7","name":"Epic"}]', { status: 200 });
        return (u.searchParams.get('jql') ?? '').includes('issuetype = Epic') ? bad('ORIGINAL') : bad('RETRY');
      });
      expect(a.err?.message).toContain('ORIGINAL');
      const b = await run('dc', (u) => (u.pathname.endsWith('/issuetype') ? bad('TYPES', 500) : bad('ORIGINAL')));
      expect(b.err?.message).toContain('ORIGINAL');
    });
    it('DC: не 400 — без повтора; Cloud: 400 — без повтора', async () => {
      const a = await run('dc', () => bad('NOPE', 403));
      expect(a.urls.some((x) => x.includes('/issuetype'))).toBe(false);
      const b = await run('cloud', (u) => (u.pathname.includes('/project/') ? new Response('{"issueTypes":[]}', { status: 200 }) : u.pathname.endsWith('/issuetype') ? new Response('[]', { status: 200 }) : bad('CLOUD')));
      expect(b.err?.message).toContain('CLOUD');
      expect(b.urls.filter((x) => x.includes('/search')).length).toBe(1);
    });
  });
  it('«Загрузить ещё» с готовым JQL: типы заново не выясняются', async () => {
    const { c, urls } = mk('cloud', () => ({ issues: [item('ABC-7', 'new')], isLast: true }));
    const r = await loadEpics(c, cloud, 'ABC', { nextPageToken: 't1', maxResults: 50 }, 'project = ABC AND issuetype in (10001) AND resolution = Unresolved ORDER BY created DESC');
    expect(r.epics.map((e) => e.key)).toEqual(['ABC-7']);
    expect(urls.some((x) => x.includes('/project/') || x.endsWith('/issuetype'))).toBe(false);
    expect(urls[0]).toContain('nextPageToken=t1');
  });
  it('epicNames: недоступный эпик не прячет названия остальных', async () => {
    const { c } = mk('dc', (u) => {
      const jql = u.searchParams.get('jql') ?? '';
      if (jql.includes('ABC-404')) return undefined;
      const ks = /key in \(([^)]*)\)/.exec(jql)?.[1].split(', ') ?? [];
      return { total: ks.length, issues: ks.map((k) => item(k, 'new')) };
    });
    const names = await epicNames(c, ['ABC-1', 'ABC-404', 'ABC-2', 'ABC-3']);
    expect([...names.keys()].sort()).toEqual(['ABC-1', 'ABC-2', 'ABC-3']);
  });
  it('релиз: проект не в кэше — `GET /project/{id}`; строка таблицы без avatarUrl', async () => {
    const { c } = mk('dc', (u) => {
      if (u.pathname.endsWith('/version/5')) return { id: '5', name: '1.0', released: true, projectId: '77' };
      if (u.pathname === '/rest/api/2/project/77') return { id: '77', key: 'ABC' };
      return { total: 0, issues: [] };
    });
    const p = await loadReleasePage(c, { id: 'i', name: 'Sample', ...dc }, '5', () => undefined, '2026-10-04');
    expect(p.project).toBe('ABC');
    const row = listRow({ instanceId: 'i', key: 'ABC-1', summary: 's', type: 'Task', status: 'Open', statusCategory: 'new', updated: '', assignee: { id: 'u', name: 'U', avatarUrl: 'https://h.example/a' } }, undefined);
    expect(row.assignee).toEqual({ id: 'u', name: 'U' });
  });
});

describe('ошибка раздела проекта', () => {
  it('404 и 400 с ключом проекта — «проект не найден» (DC отвечает 400 на JQL с несуществующим проектом)', () => {
    const notFound = { text: 'Project ZZZ not found or no access', project: true };
    expect(projectErrorText(new JiraError(404, 'x', 'https://h.example/rest'), 'ZZZ')).toEqual(notFound);
    const msg = "Неверный запрос (The value 'ZZZ' does not exist for the field 'project'.)";
    expect(projectErrorText(new JiraError(400, msg, 'https://h.example/rest'), 'ZZZ')).toEqual(notFound);
  });
  it('400 без ключа проекта (нет типа «Эпик», неверное поле, ключ эпика ZZZ-1) — текст Jira', () => {
    for (const msg of [
      "Неверный запрос (The value 'Epic' does not exist for the field 'issuetype'.)",
      "Неверный запрос (Field 'cf[10100]' does not exist)",
      "Неверный запрос (Issue 'ZZZ-1' does not exist)",
    ]) {
      expect(projectErrorText(new JiraError(400, msg, 'https://h.example/rest'), 'ZZZ')).toEqual({ text: msg, project: false });
    }
  });
  it('401, 403, сеть — текст ошибки Jira, не про проект', () => {
    for (const status of [401, 403, 500, 0]) {
      const r = projectErrorText(new JiraError(status, 'сообщение', 'https://h.example/rest'), 'ZZZ');
      expect(r).toEqual({ text: 'сообщение', project: false });
    }
    expect(projectErrorText('boom', 'ZZZ')).toEqual({ text: 'boom', project: false });
  });
});
