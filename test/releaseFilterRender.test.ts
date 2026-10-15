import { describe, expect, it } from 'vitest';
import { progressOf } from '../src/jira/epics';
import type { ListRow, ReleaseFilter, ReleasePage } from '../src/panels/protocol';
import { renderEpicPage, renderReleasePage } from '../webview/listRender';
import { effectiveGroup, hasEpics, visibleFacets } from '../webview/releaseFilterPanel';
import { emptyFilter } from '../webview/releaseFilter';

const ann = { id: 'u1', name: 'Ann <b>' };
const bob = { id: 'u2', name: 'Bob' };
const row = (key: string, o: Partial<ListRow> = {}): ListRow => ({ key, summary: `Sum ${key}`, type: 'Bug', status: 'Open', statusCategory: 'new', ...o });
const rows: ListRow[] = [
  row('ABC-1', { assignee: ann, priority: 'High', epicKey: 'ABC-9', extra: 'Epic <9>', statusCategory: 'done', status: 'Done' }),
  row('ABC-2', { assignee: ann, priority: 'Low', epicKey: 'ABC-9', extra: 'Epic <9>', statusCategory: 'indeterminate', status: 'In Progress', type: 'Task' }),
  row('ABC-3', { assignee: bob, statusCategory: 'new' }),
  row('ABC-4', { statusCategory: 'new' }),
];
const page = (o: Partial<ReleasePage> = {}): ReleasePage => ({
  type: 'release', instanceId: 'i', instanceName: 'Inst', project: 'ABC', id: '5', name: 'R "1" <x>', released: false,
  progress: progressOf(rows.map((r) => r.statusCategory)), truncated: false, rows, meId: 'u2', ...o,
});
const f = (o: Partial<ReleaseFilter>): ReleaseFilter => ({ ...emptyFilter(), ...o });
const keys = (html: string): string[] => [...html.matchAll(/data-act="open" data-key="([^"]+)"/g)].map((m) => m[1]);

describe('разметка фильтров релиза', () => {
  it('без фильтра: панель, плитки-кнопки без dim, «N issues», нет «Сбросить», нет inline-стилей', () => {
    const html = renderReleasePage(page());
    expect(html).not.toMatch(/ style=/);
    expect(html).toContain('id="rf-q"');
    expect(html).toContain('4 issues');
    expect(html).not.toContain('data-act="f-reset"');
    expect(html).not.toContain('data-act="f-jql"');
    expect(html).toContain('Filters work on the issues already loaded');
    expect(html.match(/data-act="f-cat"/g)).toHaveLength(6); // 3 плитки + 3 легенды
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).not.toContain('class="dim"');
    expect(keys(html)).toEqual(['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4']);
  });

  it('статус: нажатая плитка и легенда, у остальных dim; цифры плиток по всему релизу', () => {
    const html = renderReleasePage(page(), undefined, f({ cats: ['done'] }));
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2); // плитка и легенда «готово»
    expect(html.match(/class="dim"/g)).toHaveLength(4);
    expect(html.match(/class="on"/g)).toHaveLength(2);
    expect(html).toContain('1 of 4'); // прогресс не зависит от фильтра
    expect(keys(html)).toEqual(['ABC-1']);
    expect(html).toContain('Showing <b>1</b> of 4');
    expect(html).toContain('data-act="f-reset"');
    expect(html).toContain('data-act="f-jql" data-mode="copy"');
    expect(html).toContain('data-act="f-jql" data-mode="save"');
    expect(html).toMatch(/<button class="chip" data-act="f-cat" data-v="done"/);
  });

  it('«из загруженных» только при обрезке и активном фильтре', () => {
    expect(renderReleasePage(page({ truncated: true }), undefined, f({ cats: ['new'] }))).toContain(', loaded only');
    expect(renderReleasePage(page({ truncated: true }))).not.toContain(', loaded only');
    expect(renderReleasePage(page(), undefined, f({ cats: ['new'] }))).not.toContain(', loaded only');
  });

  it('фасет: aria-expanded, список role=checkbox со счётчиками, экранирование, нулевые приглушены', () => {
    const closed = renderReleasePage(page());
    expect(closed).toContain('data-act="f-dd" data-facet="assignee" aria-expanded="false"');
    expect(closed).not.toContain('role="checkbox"');
    const html = renderReleasePage(page(), undefined, f({ assignee: ['u1'], type: ['Story'] }), { open: 'assignee' });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="checkbox" aria-checked="true"');
    expect(html).toContain('role="checkbox" aria-checked="false"');
    expect(html).toContain('Ann &lt;b&gt;');
    expect(html).not.toContain('Ann <b>');
    expect(html).toContain('data-act="f-all" data-facet="assignee"');
    expect(html).toContain('data-act="f-clr" data-facet="assignee"');
    // пустое значение — отдельная строка с data-v=""
    expect(html).toContain('data-act="f-val" data-facet="assignee" data-v=""');
    // раскрыт только один фасет
    expect(html.match(/class="rf-pop"/g)).toHaveLength(1);
  });

  it('кнопка фасета: одно значение — в подписи, несколько — счётчик', () => {
    const one = renderReleasePage(page(), undefined, f({ assignee: ['u2'] }));
    expect(one).toMatch(/data-facet="assignee" aria-expanded="false">Assignee: Bob/);
    const many = renderReleasePage(page(), undefined, f({ assignee: ['u1', 'u2'] }));
    expect(many).toMatch(/data-facet="assignee" aria-expanded="false">Assignee <span class="rf-n">2<\/span>/);
    const empty = renderReleasePage(page(), undefined, f({ assignee: [''] }));
    expect(empty).toMatch(/Assignee: Unassigned/);
  });

  it('поиск: значение и чип экранированы, фильтр по тексту', () => {
    const html = renderReleasePage(page(), undefined, f({ q: ' "><img src=x> ' }));
    expect(html).not.toMatch(/<img/);
    expect(html).toContain('&quot;&gt;&lt;img src=x&gt;');
    expect(html).toContain('data-act="f-qx"');
    expect(html).toContain('<div class="rf-empty">');
    const ok = renderReleasePage(page(), undefined, f({ q: 'abc-3' }));
    expect(keys(ok)).toEqual(['ABC-3']);
  });

  it('«Только мои»: кнопки нет без meId, но чип из состояния виден и снимается', () => {
    expect(renderReleasePage(page())).toContain('data-act="f-mine" aria-pressed="false"');
    const noMe = renderReleasePage(page({ meId: undefined }));
    expect(noMe).not.toContain('data-act="f-mine"');
    const chipOnly = renderReleasePage(page({ meId: undefined }), undefined, f({ mine: true }));
    expect(chipOnly).toMatch(/<button class="chip" data-act="f-mine"/);
    expect(chipOnly).not.toContain('aria-pressed="true"');
    expect(keys(chipOnly)).toHaveLength(4); // локально без meId не действует
    const on = renderReleasePage(page(), undefined, f({ mine: true }));
    expect(on).toContain('data-act="f-mine" aria-pressed="true"');
    expect(keys(on)).toEqual(['ABC-3']);
  });

  it('пустое состояние: подпись с названием релиза (экранирована) и сброс', () => {
    const html = renderReleasePage(page(), undefined, f({ q: 'нет такого' }));
    expect(html).toContain('No issues in R &quot;1&quot; &lt;x&gt; match the filters.');
    expect(html).toContain('data-act="f-reset">Reset filters');
    expect(keys(html)).toEqual([]);
    expect(html).toContain('Showing <b>0</b> of 4');
  });

  it('значение, которого нет в строках, остаётся чипом и в списке с нулём', () => {
    const html = renderReleasePage(page(), undefined, f({ priority: ['Urgent'] }), { open: 'priority' });
    expect(html).toMatch(/<button class="chip" data-act="f-val" data-facet="priority" data-v="Urgent"/);
    expect(html).toContain('class="qp-i" data-act="f-val" data-facet="priority" data-v="Urgent" role="checkbox" aria-checked="true"');
    expect(html).toContain('class="rf-empty"');
  });

  it('эпик: фасет и группировка скрыты, если ни у одной строки нет эпика', () => {
    const noEpics = rows.map((r) => ({ ...r, epicKey: undefined, extra: undefined }));
    expect(hasEpics(noEpics)).toBe(false);
    expect(visibleFacets(noEpics, emptyFilter())).toEqual(['assignee', 'type', 'priority']);
    expect(visibleFacets(noEpics, f({ epic: ['X-1'] }))).toContain('epic');
    const html = renderReleasePage(page({ rows: noEpics }));
    expect(html).not.toContain('data-facet="epic"');
    expect(html).not.toContain('<option value="epic"');
    expect(effectiveGroup(noEpics, f({ group: 'epic' }))).toBe('none');
    expect(renderReleasePage(page({ rows: noEpics }), undefined, f({ group: 'epic' }))).not.toContain('rf-gh');
    const withEpics = renderReleasePage(page());
    expect(withEpics).toContain('data-facet="epic"');
    expect(withEpics).toContain('<option value="epic">');
  });

  it('группировка по исполнителю: me первым, подпись, готово d/t, мини-полоса, пустая группа последней', () => {
    const html = renderReleasePage(page(), undefined, f({ group: 'assignee' }));
    const heads = [...html.matchAll(/<tr class="rf-gh">(.*?)<\/tr>/g)].map((m) => m[1]);
    expect(heads).toHaveLength(3);
    expect(heads[0]).toContain('Bob'); // meId = u2
    expect(heads[1]).toContain('Ann &lt;b&gt;');
    expect(heads[1]).toContain('1/2 done');
    expect(heads[1]).toContain('class="bar seg"');
    expect(heads[2]).toContain('Unassigned');
    expect(html).toContain('colspan="7"');
    expect(html).toContain('<option value="assignee" selected>');
    expect(html).not.toMatch(/ style=/);
  });

  it('группировка по эпику: колонка «Эпик» скрыта, подпись эпика экранирована, «Без эпика» последним', () => {
    const html = renderReleasePage(page(), undefined, f({ group: 'epic' }));
    expect(html).not.toContain('data-col="extra"');
    expect(html).toContain('colspan="6"');
    const heads = [...html.matchAll(/<tr class="rf-gh">(.*?)<\/tr>/g)].map((m) => m[1]);
    expect(heads[0]).toContain('Epic &lt;9&gt;');
    expect(heads[1]).toContain('No epic');
    expect(html).not.toContain('Epic <9>');
    // в строках задач ячейки эпика нет: 6 колонок вместо 7
    const first = /<tr class="click" data-act="open"[^>]*>(.*?)<\/tr>/.exec(html)![1];
    expect(first.match(/<td/g)).toHaveLength(6);
    expect(first).not.toContain('Epic &lt;9&gt;');
    // без группировки по эпику колонка есть
    expect(renderReleasePage(page())).toContain('data-col="extra"');
  });

  it('группировка по статусу и сортировка внутри групп', () => {
    const many = [row('A-1', { statusCategory: 'done' }), row('A-10'), row('A-9'), row('A-2', { statusCategory: 'done' })];
    const p = page({ rows: many, progress: progressOf(many.map((r) => r.statusCategory)) });
    const html = renderReleasePage(p, { col: 'key', desc: true }, f({ group: 'status' }));
    expect(keys(html)).toEqual(['A-10', 'A-9', 'A-2', 'A-1']); // сначала «не начато», затем «готово»; внутри — по сортировке
    expect(html).toContain('<span class="pill s-new">To Do</span>');
    expect(html).toContain('0/2 done');
    expect(html).toContain('2/2 done');
  });

  it('пустая версия — как раньше, без панели; эпик — без кнопок статуса', () => {
    const html = renderReleasePage(page({ rows: [], progress: progressOf([]) }));
    expect(html).toContain('This version has no issues yet');
    expect(html).not.toContain('rf-bar');
    const epic = renderEpicPage({ type: 'epic', instanceId: 'i', instanceName: 'I', project: 'ABC', key: 'ABC-9', summary: 'E', status: 'Open', statusCategory: 'new', link: 'x', kind: 'dc', rows, progress: progressOf(['new']), truncated: false });
    expect(epic).not.toContain('f-cat');
    expect(epic).not.toContain('rf-bar');
    expect(epic).toContain('class="sum"><div>');
  });

  it('кавычки и теги в типе, приоритете и эпике экранированы в списке фасета, data-v и чипах', () => {
    const bad = 'a"b<c';
    const rs = [row('ABC-7', { type: bad, priority: bad, epicKey: bad, extra: bad })];
    for (const facet of ['type', 'priority', 'epic'] as const) {
      const html = renderReleasePage(page({ rows: rs, progress: progressOf(['new']) }), undefined, f({ [facet]: [bad] }), { open: facet });
      expect(html).toContain('data-v="a&quot;b&lt;c"');
      expect(html).not.toContain('a"b<c');
      expect(html).not.toContain('b<c');
    }
  });
});
