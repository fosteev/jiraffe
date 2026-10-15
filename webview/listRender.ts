// Вкладки эпика и релиза — чистые функции «данные → HTML-строка» (prototype: vEpic, vRel, progressBlock, issueTable, segBar).
// Inline-стилей нет (CSP): ширины сегментов и цвета аватаров ставит list.ts через CSSOM по data-w / data-bg.
import type { Progress } from '../src/jira/types';
import { t } from '../src/l10n';
import { percent, priorityRank } from '../src/jira/epics';
import type { StatusCategory } from '../src/jira/types';
import type { EpicPage, FilterCat, FilterGroup, ListPage, ListRow, ReleaseFilter, ReleasePage } from '../src/panels/protocol';
import { applyFilter, emptyFilter, groupRows, type RowGroup } from './releaseFilter';
import { effectiveGroup, emptyLabel, filterPanel, type FilterUi } from './releaseFilterPanel';
import { esc, fmtDue, IC, person, priorityIcon, STATUS_LABEL, typeIcon } from './render';

const dash = '<span class="mut">—</span>';

/** Сегментная полоса прогресса: готово / в работе / не начато (остаток — фон дорожки). */
export function segBar(p: Progress): string {
  const w = (n: number): string => (p.total ? ((n / p.total) * 100).toFixed(1) : '0');
  return `<div class="bar seg" role="img" aria-label="${esc(t('Done {0} of {1}', p.done, p.total))}"><i class="b-done" data-w="${w(p.done)}"></i><i class="b-prog" data-w="${w(p.prog)}"></i></div>`;
}

/**
 * Блок прогресса. С `filter` (вкладка релиза) плитки и легенда — кнопки-переключатели статусной категории
 * (`data-act="f-cat"`, `aria-pressed`); при активном выборе у невыбранных класс `dim`. Без `filter` (эпик) — просто текст.
 * Цифры всегда по всему релизу, фильтр на них не влияет.
 */
export function progressBlock(p: Progress, filter?: ReleaseFilter): string {
  const tiles: [FilterCat, string, string][] = [
    ['done', `<b>${esc(t('{0} of {1}', p.done, p.total))}</b><span>${esc(t('done · {0}%', percent(p)))}</span>`, ''],
    ['indeterminate', `<b>${p.prog}</b><span>${t('in progress')}</span>`, ''],
    ['new', `<b>${p.todo}</b><span>${t('not started')}</span>`, ''],
  ];
  const legend: [FilterCat, string, string][] = [
    ['done', 'b-done', esc(t('Done {0}', p.done))],
    ['indeterminate', 'b-prog', esc(t('In Progress {0}', p.prog))],
    ['new', 'b-todo', esc(t('To Do {0}', p.todo))],
  ];
  if (!filter) {
    return `<div class="sum">${tiles.map(([, inner]) => `<div>${inner}</div>`).join('')}</div>`
      + `${segBar(p)}<div class="legend">${legend.map(([, c, label]) => `<span><i class="${c}"></i>${label}</span>`).join('')}</div>`;
  }
  const btn = (c: FilterCat, inner: string): string => {
    const on = filter.cats.includes(c);
    const cls = on ? ' class="on"' : filter.cats.length ? ' class="dim"' : '';
    return `<button${cls} data-act="f-cat" data-v="${c}" aria-pressed="${on}" title="${esc(t('Filter by status: {0}', STATUS_LABEL[c]))}">${inner}</button>`;
  };
  return `<div class="sum">${tiles.map(([c, inner]) => btn(c, inner)).join('')}</div>`
    + `${segBar(p)}<div class="legend">${legend.map(([c, i, label]) => btn(c, `<i class="${i}"></i>${label}`)).join('')}</div>`;
}

export type ListCol = 'key' | 'summary' | 'status' | 'priority' | 'assignee' | 'extra';
export const LIST_COLS: ListCol[] = ['key', 'summary', 'status', 'priority', 'assignee', 'extra'];
/** Сортировка таблицы по колонке; нет — порядок хоста (в работе → не начато → готово). */
export interface ListSort { col: ListCol; desc: boolean }

const CAT_RANK: Record<StatusCategory, number> = { new: 0, indeterminate: 1, done: 2 };
const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** Пустые значения — всегда в конце, в любом направлении. */
const EMPTY = Symbol('empty');

function sortValue(r: ListRow, col: ListCol): string | number | typeof EMPTY {
  switch (col) {
    case 'key': return r.key; // numeric-коллатор: ABC-9 < ABC-10
    case 'summary': return r.summary;
    case 'status': return `${CAT_RANK[r.statusCategory]} ${r.status}`;
    case 'priority': return r.priority ? -priorityRank(r.priority) : EMPTY; // по убыванию — срочные сверху
    case 'assignee': return r.assignee?.name || EMPTY;
    case 'extra': return r.extra || EMPTY;
  }
}

/** Стабильная сортировка строк; при равенстве — исходный порядок. */
export function sortRows(rows: readonly ListRow[], sort: ListSort | undefined): readonly ListRow[] {
  if (!sort) return rows;
  const dir = sort.desc ? -1 : 1;
  return rows.map((r, i) => ({ r, i, v: sortValue(r, sort.col) })).sort((a, b) => {
    if (a.v === EMPTY || b.v === EMPTY) return a.v === b.v ? a.i - b.i : a.v === EMPTY ? 1 : -1;
    const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : coll.compare(String(a.v), String(b.v));
    return c ? c * dir : a.i - b.i;
  }).map((x) => x.r);
}

const sortTh = (col: ListCol, title: string, sort: ListSort | undefined): string => {
  const on = sort?.col === col;
  const aria = on ? ` aria-sort="${sort.desc ? 'descending' : 'ascending'}"` : '';
  return `<th${aria}><button class="th-sort${on ? ' on' : ''}" data-act="sort" data-col="${col}" title="${esc(t('Sort by this column'))}">${title}<span class="arr">${on ? (sort.desc ? '↓' : '↑') : ''}</span></button></th>`;
};

export interface TableOpts {
  /** Группировка строк (`none`/без — плоская таблица) и `meId` для порядка групп. */
  group?: FilterGroup;
  meId?: string;
  /** Скрыть последнюю колонку (Эпик при группировке по эпику). */
  hideExtra?: boolean;
}

const groupLabel = (g: RowGroup, by: FilterGroup): string => {
  if (by === 'assignee') return g.key ? person(g.rows[0].assignee) : `<span class="mut">${esc(emptyLabel('group-assignee'))}</span>`;
  if (by === 'epic') return g.key ? `<span class="who-c">${typeIcon('Epic')}${esc(g.label)}</span>` : `<span class="mut">${esc(emptyLabel('group-epic'))}</span>`;
  return `<span class="pill s-${g.key}">${esc(STATUS_LABEL[g.key as FilterCat])}</span>`;
};

/** Таблица задач; строка открывает карточку (`data-act="open"`). `extraTitle` — заголовок последней колонки (Релиз / Эпик). */
export function issueTable(rows: readonly ListRow[], extraTitle: string, sort?: ListSort, opts: TableOpts = {}): string {
  const row = (r: ListRow): string => `<tr class="click" data-act="open" data-key="${esc(r.key)}" tabindex="0"><td>${typeIcon(r.type)}</td><td class="k nw">${esc(r.key)}</td><td>${esc(r.summary)}</td>`
    + `<td><span class="pill s-${r.statusCategory}" title="${esc(STATUS_LABEL[r.statusCategory])}">${esc(r.status || STATUS_LABEL[r.statusCategory])}</span></td>`
    + `<td>${r.priority ? `<span class="prio" title="${esc(r.priority)}">${priorityIcon(r.priority)}</span>` : dash}</td><td>${person(r.assignee)}</td>`
    + `${opts.hideExtra ? '' : `<td class="mut nw">${r.extra ? esc(r.extra) : '—'}</td>`}</tr>`;
  const sorted = sortRows(rows, sort);
  const by = opts.group ?? 'none';
  const span = opts.hideExtra ? 6 : 7;
  const body = by === 'none'
    ? sorted.map(row).join('')
    : groupRows(sorted, by, opts.meId).map((g) => `<tr class="rf-gh"><td colspan="${span}"><div class="gh">${groupLabel(g, by)}`
      + `<span class="desc">${esc(t('{0}/{1} done', g.progress.done, g.progress.total))}</span>${segBar(g.progress)}</div></td></tr>${g.rows.map(row).join('')}`).join('');
  return `<div class="tw-wrap"><table class="t"><thead><tr><th></th>${sortTh('key', t('Key'), sort)}${sortTh('summary', t('Issue'), sort)}${sortTh('status', t('Status'), sort)}${sortTh('priority', t('Priority'), sort)}${sortTh('assignee', t('Assignee'), sort)}${opts.hideExtra ? '' : sortTh('extra', esc(extraTitle), sort)}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const truncNote = (p: ListPage): string => (p.truncated ? `<p class="foot">${esc(t('Showing the first {0} issues — Jira has more; progress is computed from the shown ones.', p.rows.length))}</p>` : '');

const crumbs = (p: ListPage, section: string): string =>
  `<div class="crumbs">${IC.server} ${esc(p.instanceName)}${p.project ? `<span>›</span>${esc(p.project)}` : ''}<span>›</span>${section}</div>`;

export function renderEpicPage(p: EpicPage, sort?: ListSort): string {
  const table = p.rows.length ? issueTable(p.rows, t('Release'), sort) : `<p class="mut">${p.link ? t('This epic has no issues yet.') : t('The Epic Link field was not found on the instance — epic issues are unavailable. Refresh the instance capabilities or set the field in settings.')}</p>`;
  const foot = p.kind === 'cloud'
    ? t('Jira Cloud: epic issues are looked up by <code>parent</code>.')
    : t('Server/DC: epic issues are looked up by the Epic Link field{0}.', p.link ? ` (<code>${esc(p.link)}</code>)` : '');
  return `<div class="wide-pad">${crumbs(p, t('Epics'))}
  <h1 class="ico-h">${typeIcon('Epic')}${esc(p.summary)}</h1>
  <div class="hrow mb"><span class="k">${esc(p.key)}</span><span class="pill s-${p.statusCategory}" title="${esc(STATUS_LABEL[p.statusCategory])}">${esc(p.status || STATUS_LABEL[p.statusCategory])}</span><span class="sp"></span>
    <button class="btn" data-act="refresh">${t('Refresh')}</button><button class="btn" data-act="browser">${IC.ext} ${t('Open in Jira')}</button></div>
  ${p.rows.length ? progressBlock(p.progress) : ''}${table}${truncNote(p)}<p class="foot">${foot}</p></div>`;
}

export function renderReleasePage(p: ReleasePage, sort?: ListSort, filter: ReleaseFilter = emptyFilter(), ui: FilterUi = {}): string {
  const left = p.daysLeft !== undefined ? ` · <b>${p.daysLeft >= 0 ? t('{0} d left', p.daysLeft) : t('overdue by {0} d', -p.daysLeft)}</b>` : '';
  const dates = `${p.startDate ? esc(t('Start {0}', fmtDue(p.startDate))) : t('No start date')} · ${p.releaseDate ? esc(p.released ? t('Released {0}', fmtDue(p.releaseDate)) : t('Release {0}', fmtDue(p.releaseDate))) : t('no release date')}${left}`;
  const group = effectiveGroup(p.rows, filter);
  const list = applyFilter(p.rows, filter, p.meId);
  const table = list.length
    ? issueTable(list, t('Epic'), sort, { group, meId: p.meId, hideExtra: group === 'epic' })
    : `<div class="rf-empty">${t('No issues in {0} match the filters.', esc(p.name))} <button class="lnk" data-act="f-reset">${t('Reset filters')}</button></div>`;
  const body = p.rows.length
    ? `${progressBlock(p.progress, filter)}${filterPanel(p.rows, filter, p.meId, p.truncated, ui)}${table}${truncNote(p)}`
      + `<p class="foot">${t('Filters work on the issues already loaded in this tab, without extra requests, and are kept until the tab is closed.')}</p>`
    : `<p class="mut">${t('This version has no issues yet.')}</p>`;
  return `<div class="wide-pad">${crumbs(p, t('Releases'))}
  <h1 class="ico-h"><span class="tag-ic">${IC.tag}</span>${esc(p.name)}</h1>
  <div class="hrow mb">${p.released ? `<span class="pill s-done">${t('Released')}</span>` : `<span class="pill s-indeterminate">${t('Unreleased')}</span>`}
    <span class="sm">${dates}</span>${p.description ? `<span class="mut sm">${esc(p.description)}</span>` : ''}<span class="sp"></span>
    <button class="btn" data-act="refresh">${t('Refresh')}</button><button class="btn" data-act="browser">${IC.ext} ${t('Open in Jira')}</button></div>
  ${body}</div>`;
}

export const renderListPage = (p: ListPage, sort?: ListSort, filter?: ReleaseFilter, ui?: FilterUi): string =>
  (p.type === 'epic' ? renderEpicPage(p, sort) : renderReleasePage(p, sort, filter, ui));
