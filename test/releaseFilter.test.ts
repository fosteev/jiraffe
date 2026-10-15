import { describe, expect, it } from 'vitest';
import { epicFieldJql } from '../src/jira/epics';
import { releaseFilterJql } from '../src/jira/releaseFilterJql';
import { CATEGORY_IDS } from '../src/jql';
import type { ListRow, ReleaseFilter } from '../src/panels/protocol';
import {
  applyFilter, clearFacet, clearQuery, emptyFilter, facetValues, groupRows, isActive, resetFilter, sanitizeFilter, selectAll, setGroup, setQuery,
  toggleCat, toggleMine, toggleValue,
} from '../webview/releaseFilter';

const ME = 'ivan';
const row = (key: string, o: Partial<ListRow> = {}): ListRow => ({
  key, summary: `Summary ${key}`, type: 'Task', status: 'Open', statusCategory: 'new', priority: 'Medium', ...o,
});
const rows: ListRow[] = [
  row('ABC-1', { statusCategory: 'done', type: 'Bug', priority: 'High', assignee: { id: 'ivan', name: 'Ivan' }, epicKey: 'ABC-90', extra: 'Payments' }),
  row('ABC-2', { statusCategory: 'indeterminate', type: 'Task', priority: 'Highest', assignee: { id: 'anna', name: 'Anna' }, epicKey: 'ABC-90', extra: 'Payments' }),
  row('ABC-3', { statusCategory: 'new', type: 'Bug', priority: 'Low', assignee: { id: 'ivan', name: 'Ivan' }, epicKey: 'ABC-91', extra: 'Search' }),
  row('ABC-10', { statusCategory: 'new', type: 'Story', summary: 'Fix [UI] glitch', assignee: undefined }),
  row('ABC-11', { statusCategory: 'done', type: 'Task', priority: undefined, assignee: { id: 'anna', name: 'Anna' } }),
];
const keys = (l: ListRow[]): string[] => l.map((r) => r.key);
const F = (o: Partial<ReleaseFilter> = {}): ReleaseFilter => ({ ...emptyFilter(), ...o });

describe('applyFilter', () => {
  it('пустой фильтр отдаёт все строки, isActive = false (группировка не в счёт)', () => {
    expect(applyFilter(rows, emptyFilter(), ME)).toHaveLength(5);
    expect(isActive(emptyFilter())).toBe(false);
    expect(isActive(F({ group: 'epic' }))).toBe(false);
  });
  it('поиск: подстрока ключа или названия без регистра, пробелы по краям не в счёт', () => {
    expect(keys(applyFilter(rows, F({ q: '  abc-1 ' }), ME))).toEqual(['ABC-1', 'ABC-10', 'ABC-11']);
    expect(keys(applyFilter(rows, F({ q: 'FIX [ui]' }), ME))).toEqual(['ABC-10']);
    expect(applyFilter(rows, F({ q: '   ' }), ME)).toHaveLength(5);
    expect(isActive(F({ q: '  ' }))).toBe(false);
    expect(isActive(F({ q: 'x' }))).toBe(true);
  });
  it('категория статуса', () => {
    expect(keys(applyFilter(rows, F({ cats: ['done'] }), ME))).toEqual(['ABC-1', 'ABC-11']);
    expect(keys(applyFilter(rows, F({ cats: ['done', 'indeterminate'] }), ME))).toEqual(['ABC-1', 'ABC-2', 'ABC-11']);
  });
  it('исполнитель, в том числе «не назначена»', () => {
    expect(keys(applyFilter(rows, F({ assignee: ['anna'] }), ME))).toEqual(['ABC-2', 'ABC-11']);
    expect(keys(applyFilter(rows, F({ assignee: [''] }), ME))).toEqual(['ABC-10']);
    expect(keys(applyFilter(rows, F({ assignee: ['ivan', ''] }), ME))).toEqual(['ABC-1', 'ABC-3', 'ABC-10']);
  });
  it('тип, приоритет (с «без приоритета»), эпик (с «без эпика»)', () => {
    expect(keys(applyFilter(rows, F({ type: ['Bug', 'Story'] }), ME))).toEqual(['ABC-1', 'ABC-3', 'ABC-10']);
    expect(keys(applyFilter(rows, F({ priority: ['High', 'Highest'] }), ME))).toEqual(['ABC-1', 'ABC-2']);
    expect(keys(applyFilter(rows, F({ priority: [''] }), ME))).toEqual(['ABC-11']);
    expect(keys(applyFilter(rows, F({ epic: ['ABC-91'] }), ME))).toEqual(['ABC-3']);
    expect(keys(applyFilter(rows, F({ epic: [''] }), ME))).toEqual(['ABC-10', 'ABC-11']);
    expect(keys(applyFilter(rows, F({ epic: ['ABC-91', ''] }), ME))).toEqual(['ABC-3', 'ABC-10', 'ABC-11']);
  });
  it('«только мои» по meId; без meId фильтр выключен', () => {
    expect(keys(applyFilter(rows, F({ mine: true }), ME))).toEqual(['ABC-1', 'ABC-3']);
    expect(applyFilter(rows, F({ mine: true }), undefined)).toHaveLength(5);
    expect(applyFilter(rows, F({ mine: true }), '')).toHaveLength(5);
    expect(isActive(F({ mine: true }))).toBe(true);
  });
  it('фасеты пересекаются (И между фасетами, ИЛИ внутри)', () => {
    expect(keys(applyFilter(rows, F({ type: ['Bug'], assignee: ['ivan'], cats: ['new'] }), ME))).toEqual(['ABC-3']);
    expect(keys(applyFilter(rows, F({ type: ['Bug'], epic: ['ABC-90'], mine: true, q: 'abc-1' }), ME))).toEqual(['ABC-1']);
    expect(applyFilter(rows, F({ type: ['Story'], cats: ['done'] }), ME)).toEqual([]);
  });
  it('skip исключает один фасет', () => {
    const f = F({ type: ['Bug'], cats: ['done'] });
    expect(keys(applyFilter(rows, f, ME, 'type'))).toEqual(['ABC-1', 'ABC-11']);
    expect(keys(applyFilter(rows, f, ME, 'cats'))).toEqual(['ABC-1', 'ABC-3']);
  });
});

describe('facetValues', () => {
  it('счётчик не учитывает свой фасет, но учитывает остальные', () => {
    const f = F({ type: ['Bug'], cats: ['done'] });
    const t = facetValues(rows, f, ME, 'type');
    // cats=done → ABC-1 (Bug), ABC-11 (Task); сам фасет type не учитывается
    expect(t.map((v) => [v.value, v.count, v.on])).toEqual([['Bug', 1, true], ['Task', 1, false], ['Story', 0, false]]);
  });
  it('исполнители: подпись — имя, по счётчику и имени, пустое значение последним', () => {
    const a = facetValues(rows, emptyFilter(), ME, 'assignee');
    expect(a.map((v) => [v.value, v.label, v.count])).toEqual([['anna', 'Anna', 2], ['ivan', 'Ivan', 2], ['', '', 1]]);
  });
  it('эпики: подпись — название, «без эпика» последним даже при большем счётчике', () => {
    const e = facetValues(rows, emptyFilter(), ME, 'epic');
    expect(e.map((v) => [v.value, v.label, v.count])).toEqual([['ABC-90', 'Payments', 2], ['ABC-91', 'Search', 1], ['', '', 2]]);
  });
  it('приоритеты — по priorityRank, пустой последним', () => {
    const p = facetValues(rows, emptyFilter(), ME, 'priority');
    expect(p.map((v) => v.value)).toEqual(['Highest', 'High', 'Medium', 'Low', '']);
  });
  it('выбранное значение, которого нет в строках, остаётся со счётчиком 0', () => {
    const t = facetValues(rows, F({ type: ['Epic'] }), ME, 'type');
    expect(t.find((v) => v.value === 'Epic')).toEqual({ value: 'Epic', label: 'Epic', count: 0, on: true });
  });
  it('«мои» и поиск сужают счётчики', () => {
    const t = facetValues(rows, F({ mine: true }), ME, 'type');
    expect(t.map((v) => [v.value, v.count])).toEqual([['Bug', 2], ['Story', 0], ['Task', 0]]);
    expect(facetValues(rows, F({ mine: true }), undefined, 'type').find((v) => v.value === 'Task')?.count).toBe(2);
  });
});

describe('groupRows', () => {
  it('none — одна группа; пусто — ни одной', () => {
    const g = groupRows(rows, 'none');
    expect(g).toHaveLength(1);
    expect(g[0].progress).toEqual({ total: 5, done: 2, prog: 1, todo: 2 });
    expect(groupRows([], 'none')).toEqual([]);
  });
  it('исполнитель: сначала я, затем по имени, без исполнителя последним; прогресс группы', () => {
    const g = groupRows(rows, 'assignee', 'anna');
    expect(g.map((x) => [x.key, x.label])).toEqual([['anna', 'Anna'], ['ivan', 'Ivan'], ['', '']]);
    expect(g[0].progress).toEqual({ total: 2, done: 1, prog: 1, todo: 0 });
    expect(keys(g[1].rows)).toEqual(['ABC-1', 'ABC-3']);
    expect(groupRows(rows, 'assignee', undefined).map((x) => x.key)).toEqual(['anna', 'ivan', '']);
  });
  it('эпик: по ключу (естественный порядок), без эпика последним', () => {
    const many = [row('A-1', { epicKey: 'ABC-10' }), row('A-2', { epicKey: 'ABC-9' }), row('A-3'), row('A-4', { epicKey: 'ABC-9' })];
    const g = groupRows(many, 'epic');
    expect(g.map((x) => x.key)).toEqual(['ABC-9', 'ABC-10', '']);
    expect(g[0].rows).toHaveLength(2);
  });
  it('статус: new, indeterminate, done, только непустые', () => {
    expect(groupRows(rows, 'status').map((x) => [x.key, x.rows.length])).toEqual([['new', 2], ['indeterminate', 1], ['done', 2]]);
    expect(groupRows([row('A-1', { statusCategory: 'done' }), row('A-2')], 'status').map((x) => x.key)).toEqual(['new', 'done']);
  });
});

describe('изменения фильтра', () => {
  it('toggle/clear/reset — иммутабельно', () => {
    const f0 = emptyFilter();
    const f1 = toggleCat(toggleCat(f0, 'done'), 'new');
    expect(f1.cats).toEqual(['new', 'done']); // канонический порядок
    expect(f0.cats).toEqual([]);
    expect(toggleCat(f1, 'new').cats).toEqual(['done']);
    const f2 = toggleValue(toggleValue(f1, 'type', 'Bug'), 'type', 'Task');
    expect(f2.type).toEqual(['Bug', 'Task']);
    expect(toggleValue(f2, 'type', 'Bug').type).toEqual(['Task']);
    expect(selectAll(f0, 'epic', ['', 'A-1', 'A-1']).epic).toEqual(['', 'A-1']);
    expect(clearFacet(f2, 'type').type).toEqual([]);
    expect(clearFacet(f2, 'cats').cats).toEqual([]);
    expect(toggleMine(f0).mine).toBe(true);
    expect(clearQuery(setQuery(f0, 'x')).q).toBe('');
    const all = setGroup(toggleMine(setQuery(f2, 'x')), 'epic');
    expect(resetFilter(all)).toEqual({ ...emptyFilter(), group: 'epic' });
  });
});

describe('sanitizeFilter', () => {
  it('мусор → пустой фильтр', () => {
    for (const x of [undefined, null, 1, 'str', [], true]) expect(sanitizeFilter(x)).toEqual(emptyFilter());
    expect(sanitizeFilter({})).toEqual(emptyFilter());
  });
  it('лишнее выбрасывается, неверные типы → дефолт', () => {
    const f = sanitizeFilter({
      q: 5, cats: ['done', 'bogus', 'done', 'new', 7], assignee: ['a', 'a', '', 3, null], type: ['Bug', ''], priority: 'High', epic: [''], mine: 'yes',
      group: 'nope', extra: 1,
    });
    expect(f).toEqual({ q: '', cats: ['new', 'done'], assignee: ['a', ''], type: ['Bug'], priority: [], epic: [''], mine: false, group: 'none' });
  });
  it('корректный фильтр проходит как есть; длинные значения и огромные списки режутся', () => {
    const ok = F({ q: 'abc', cats: ['indeterminate'], assignee: ['ivan', ''], type: ['Bug'], priority: ['High'], epic: ['ABC-1'], mine: true, group: 'status' });
    expect(sanitizeFilter(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
    const big = sanitizeFilter({ q: 'x'.repeat(5000), type: Array.from({ length: 1000 }, (_, i) => `t${i}`).concat(['y'.repeat(1000)]) });
    expect(big.q).toHaveLength(300);
    expect(big.type).toHaveLength(200);
    // дальше MAX_SCAN элементов не читаем: годное в хвосте огромного мусорного массива не находится
    expect(sanitizeFilter({ epic: [...Array.from({ length: 5000 }, () => 1), 'ABC-1'] }).epic).toEqual([]);
  });
  it('значения из одних пробелов выбрасываются, __proto__ и чужие поля не протекают', () => {
    const f = sanitizeFilter(JSON.parse('{"__proto__": {"mine": true}, "assignee": [" ", "", "a"], "type": ["  "], "constructor": 1}'));
    expect(f).toEqual(F({ assignee: ['', 'a'] }));
    expect(Object.getPrototypeOf(f)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).mine).toBeUndefined();
  });
});

describe('releaseFilterJql', () => {
  const dc = { kind: 'dc' as const, epicLinkField: 'customfield_10100', caps: undefined };
  const cloud = { kind: 'cloud' as const, caps: { tempo: false, epicLinkField: null, checkedAt: '' } };
  const dcNoEpic = { kind: 'dc' as const, caps: { tempo: false, epicLinkField: null, checkedAt: '' } };
  const ORDER = ' ORDER BY status, priority';

  it('пустой фильтр: только релиз и порядок', () => {
    expect(releaseFilterJql(dc, '10610', emptyFilter())).toEqual({ jql: `fixVersion = 10610${ORDER}`, epicSkipped: false });
    expect(releaseFilterJql(dc, '1 OR 2', emptyFilter())).toEqual({ jql: '', epicSkipped: false });
  });
  it('категории — id из CATEGORY_IDS в каноническом порядке', () => {
    expect(CATEGORY_IDS.new).toEqual([1, 2]);
    expect(releaseFilterJql(dc, '5', F({ cats: ['done', 'new'] })).jql).toBe(`fixVersion = 5 AND statusCategory in (1, 2, 3)${ORDER}`);
    expect(releaseFilterJql(dc, '5', F({ cats: ['indeterminate'] })).jql).toBe(`fixVersion = 5 AND statusCategory in (4)${ORDER}`);
  });
  it('все условия в стабильном порядке — DC', () => {
    const f = F({
      q: 'login', cats: ['done'], assignee: ['ivan', ''], type: ['Bug'], priority: ['High', ''], epic: ['ABC-90', 'ABC-91'], mine: true, group: 'epic',
    });
    const want = 'fixVersion = 5 AND statusCategory in (3) AND (assignee in ("ivan") OR assignee is EMPTY) AND issuetype in ("Bug")'
      + ' AND (priority in ("High") OR priority is EMPTY) AND cf[10100] in (ABC-90, ABC-91) AND assignee = currentUser()'
      + ` AND summary ~ "login"${ORDER}`;
    expect(releaseFilterJql(dc, '5', f)).toEqual({ jql: want, epicSkipped: false });
    // порядок условий не зависит от порядка полей в объекте и значений в статусах
    const shuffled = { group: f.group, mine: f.mine, epic: f.epic, priority: f.priority, type: f.type, assignee: f.assignee, cats: f.cats, q: f.q };
    expect(releaseFilterJql(dc, '5', shuffled).jql).toBe(want);
    expect(releaseFilterJql(dc, '5', F({ cats: ['done', 'new'] })).jql).toBe(releaseFilterJql(dc, '5', F({ cats: ['new', 'done'] })).jql);
  });
  it('Cloud: эпик — parent; «без эпика» и сочетание', () => {
    expect(epicFieldJql(cloud)).toBe('parent');
    expect(releaseFilterJql(cloud, '5', F({ epic: ['ABC-90'] })).jql).toBe(`fixVersion = 5 AND parent in (ABC-90)${ORDER}`);
    expect(releaseFilterJql(cloud, '5', F({ epic: [''] })).jql).toBe(`fixVersion = 5 AND parent is EMPTY${ORDER}`);
    expect(releaseFilterJql(cloud, '5', F({ epic: ['', 'ABC-90'] })).jql).toBe(`fixVersion = 5 AND (parent in (ABC-90) OR parent is EMPTY)${ORDER}`);
    // исполнитель на Cloud — accountId в кавычках
    expect(releaseFilterJql(cloud, '5', F({ assignee: ['5b10a2844c20165700ede21g', ''] })).jql)
      .toBe(`fixVersion = 5 AND (assignee in ("5b10a2844c20165700ede21g") OR assignee is EMPTY)${ORDER}`);
  });
  it('DC без поля Epic Link: условие по эпику пропущено, epicSkipped', () => {
    expect(epicFieldJql(dcNoEpic)).toBeNull();
    expect(releaseFilterJql(dcNoEpic, '5', F({ epic: ['ABC-90'], type: ['Bug'] }))).toEqual({ jql: `fixVersion = 5 AND issuetype in ("Bug")${ORDER}`, epicSkipped: true });
    expect(releaseFilterJql(dcNoEpic, '5', F({ epic: [''] })).epicSkipped).toBe(true);
    expect(releaseFilterJql(dcNoEpic, '5', F({ type: ['Bug'] })).epicSkipped).toBe(false);
  });
  it('пустые значения: только пустое → `is EMPTY`', () => {
    expect(releaseFilterJql(dc, '5', F({ assignee: [''] })).jql).toBe(`fixVersion = 5 AND assignee is EMPTY${ORDER}`);
    expect(releaseFilterJql(dc, '5', F({ priority: [''] })).jql).toBe(`fixVersion = 5 AND priority is EMPTY${ORDER}`);
    expect(releaseFilterJql(dc, '5', F({ epic: [''] })).jql).toBe(`fixVersion = 5 AND cf[10100] is EMPTY${ORDER}`);
  });
  it('поиск: ключ → (key = Q OR summary ~ …), текст → summary ~ с экранированием', () => {
    const inRelease = (k: string): boolean => k === 'ABC-12';
    expect(releaseFilterJql(dc, '5', F({ q: ' abc-12 ' }), { keyExists: inRelease }).jql).toBe(`fixVersion = 5 AND (key = ABC-12 OR summary ~ "abc\\\\-12")${ORDER}`);
    // ключа нет среди задач (или проверки нет) — только текстом: DC отвечает 400 на `key =` несуществующей задачи
    expect(releaseFilterJql(dc, '5', F({ q: 'abc-13' }), { keyExists: inRelease }).jql).toBe(`fixVersion = 5 AND summary ~ "abc\\\\-13"${ORDER}`);
    expect(releaseFilterJql(dc, '5', F({ q: 'UTF-8' })).jql).toBe(`fixVersion = 5 AND summary ~ "UTF\\\\-8"${ORDER}`);
    expect(releaseFilterJql(dc, '5', F({ q: '   ' })).jql).toBe(`fixVersion = 5${ORDER}`);
    expect(releaseFilterJql(dc, '5', F({ q: 'a  b' })).jql).toBe(`fixVersion = 5 AND summary ~ "a b"${ORDER}`);
  });
  it('спецсимволы в значениях и поиске не ломают кавычки: " \\ [ ] ( ) *', () => {
    const f = F({ q: 'x" OR 1=1 \\ [a] (b) *', assignee: ['we"ird\\name'], type: ['Bug ")'], priority: ['P[1]*'] });
    const { jql } = releaseFilterJql(dc, '5', f);
    expect(jql).toContain('assignee in ("we\\"ird\\\\name")');
    expect(jql).toContain('issuetype in ("Bug \\")")');
    expect(jql).toContain('priority in ("P[1]*")');
    // поиск: Lucene-экранирование, затем экранирование кавычек JQL; сырых " вне кавычек нет
    expect(jql).toContain('summary ~ "x\\\\\\" or 1=1 \\\\\\\\ \\\\[a\\\\] \\\\(b\\\\) *"');
    const outside = jql.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(outside).not.toMatch(/[\\[\]]/);
    expect(outside.match(/"/g)?.length ?? 0).toBe(2 * 4);
  });
  it('мусорные ключи эпика отбрасываются, ключи без инъекции', () => {
    expect(releaseFilterJql(dc, '5', F({ epic: ['ABC-1) OR (1=1', 'ABC-2'] })).jql).toBe(`fixVersion = 5 AND cf[10100] in (ABC-2)${ORDER}`);
    // все ключи мусорные — условия по эпику нет, и это видно по epicSkipped
    expect(releaseFilterJql(dc, '5', F({ epic: ['bad key'] }))).toEqual({ jql: `fixVersion = 5${ORDER}`, epicSkipped: true });
  });
  it('значения из одних пробелов в JQL не попадают (иначе `in ("")` → 400)', () => {
    expect(releaseFilterJql(dc, '5', F({ assignee: [' '], priority: [' ', 'High'] })).jql).toBe(`fixVersion = 5 AND priority in ("High")${ORDER}`);
  });
  it('«только мои» попадает в JQL независимо от meId', () => {
    expect(releaseFilterJql(cloud, '5', F({ mine: true })).jql).toBe(`fixVersion = 5 AND assignee = currentUser()${ORDER}`);
  });
});
