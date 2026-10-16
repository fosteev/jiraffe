// Панель фильтров вкладки релиза (prototype: relBody → .rf-bar, .rf-chips, rfPop): чистые функции «данные → HTML-строка».
// Состояние фильтра хранит list.ts; здесь только разметка. Inline-стилей нет (CSP).
import { t, tn } from '../src/l10n';
import type { UserRef } from '../src/jira/types';
import type { FilterGroup, ListRow, ReleaseFilter } from '../src/panels/protocol';
import { FACETS, FILTER_GROUPS, applyFilter, facetValues, isActive, type FacetId, type FacetValue } from './releaseFilter';
import { IC, esc, person, priorityIcon, STATUS_LABEL, typeIcon } from './render';

/** Состояние интерфейса, которое не хранится в `setState`: какой фасет раскрыт. */
export interface FilterUi { open?: FacetId }

/** Эпики в релизе есть (хоть у одной строки): иначе фасет «Эпик» и группировка по эпику — из одного «Без эпика». */
export const hasEpics = (rows: readonly ListRow[]): boolean => rows.some((r) => !!r.epicKey);

/** Фасеты, которые показываем: «Эпик» скрыт, если эпиков нет и в фильтре от него ничего не осталось. */
export const visibleFacets = (rows: readonly ListRow[], f: ReleaseFilter): FacetId[] =>
  FACETS.filter((id) => id !== 'epic' || hasEpics(rows) || f.epic.length > 0);

/** Группировка по эпику без единого эпика не имеет смысла: показываем как «Нет», сам выбор в фильтре не трогаем. */
export const effectiveGroup = (rows: readonly ListRow[], f: ReleaseFilter): FilterGroup =>
  f.group === 'epic' && !hasEpics(rows) ? 'none' : f.group;

const facetTitle = (id: FacetId): string => ({ status: t('Status'), assignee: t('Assignee'), type: t('Type'), priority: t('Priority'), epic: t('Epic') })[id];
const groupTitle = (g: FilterGroup): string => ({ none: t('None'), assignee: t('Assignee'), epic: t('Epic'), status: t('Status') })[g];

/** Подпись пустого значения фасета. */
export const emptyLabel = (id: FacetId | 'group-assignee' | 'group-epic'): string =>
  id === 'assignee' || id === 'group-assignee' ? t('Unassigned') : id === 'epic' || id === 'group-epic' ? t('No epic') : id === 'priority' ? t('No priority') : '—';

const valueText = (id: FacetId, v: FacetValue): string => (v.value === '' ? emptyLabel(id) : v.label || '—');

function valueHtml(id: FacetId, v: FacetValue, users: ReadonlyMap<string, UserRef>): string {
  if (v.value === '') return `<span class="mut">${esc(emptyLabel(id))}</span>`;
  switch (id) {
    case 'status': return `<span class="pill s-${v.cat ?? 'new'}">${esc(v.label)}</span>`;
    case 'assignee': { const u = users.get(v.value); return u ? person(u) : esc(v.label); }
    case 'type': return `${typeIcon(v.label)}${esc(v.label)}`;
    case 'priority': return `${priorityIcon(v.label)}${esc(v.label)}`;
    case 'epic': return `${typeIcon('Epic')}${esc(v.label)}`;
  }
}

function pop(id: FacetId, vals: readonly FacetValue[], f: ReleaseFilter, users: ReadonlyMap<string, UserRef>): string {
  const items = vals.map((v) =>
    `<div class="qp-i${v.count || v.on ? '' : ' zero'}" data-act="f-val" data-facet="${id}" data-v="${esc(v.value)}" role="checkbox" aria-checked="${v.on}" tabindex="0">`
    + `<span class="cb${v.on ? ' on' : ''}">${IC.check}</span>${valueHtml(id, v, users)}<span class="desc">${v.count}</span></div>`).join('');
  return `<div class="rf-pop" role="group" aria-label="${esc(facetTitle(id))}">${items}`
    + `<div class="rf-pf"><button class="lnk" data-act="f-all" data-facet="${id}">${t('Select all')}</button>${f[id].length ? `<button class="lnk" data-act="f-clr" data-facet="${id}">${t('Clear')}</button>` : ''}</div></div>`;
}

const chip = (attrs: string, title: string, value: string): string =>
  `<button class="chip" ${attrs} title="${esc(t('Remove'))}"><b>${esc(title)}</b>${value}${IC.x}</button>`;

/**
 * Панель под блоком прогресса: поиск, фасеты, «Только мои», группировка; ниже — чипы выбранного, «Сбросить», счётчик, «Копировать JQL»
 * и «Сохранить как фильтр…». `shown` — сколько строк прошло фильтр.
 */
export function filterPanel(rows: readonly ListRow[], f: ReleaseFilter, meId: string | undefined, truncated: boolean, ui: FilterUi): string {
  const users = new Map<string, UserRef>();
  for (const r of rows) if (r.assignee && !users.has(r.assignee.id)) users.set(r.assignee.id, r.assignee);
  const shown = applyFilter(rows, f, meId).length;
  const active = isActive(f);
  const ids = visibleFacets(rows, f);
  const vals = new Map<FacetId, FacetValue[]>(ids.map((id) => [id, facetValues(rows, f, meId, id)]));

  const dd = ids.map((id) => {
    const all = vals.get(id)!;
    const n = f[id].length;
    const one = n === 1 ? all.find((v) => v.on) : undefined;
    const open = ui.open === id;
    return `<div class="rf-dd"><button class="btn sm${n ? ' on' : ''}" data-act="f-dd" data-facet="${id}" aria-expanded="${open}">${esc(facetTitle(id))}`
      + `${one ? `: ${esc(valueText(id, one))}` : n > 1 ? ` <span class="rf-n">${n}</span>` : ''}<span class="rf-cv">${IC.chev}</span></button>${open ? pop(id, all, f, users) : ''}</div>`;
  }).join('');

  const eg = effectiveGroup(rows, f);
  const groups = FILTER_GROUPS.filter((g) => g !== 'epic' || hasEpics(rows)).map((g) => `<option value="${g}"${eg === g ? ' selected' : ''}>${esc(groupTitle(g))}</option>`).join('');
  const bar = `<div class="rf-bar">`
    + `<label class="inp">${IC.search}<input id="rf-q" type="text" placeholder="${esc(t('Filter by key or summary'))}" aria-label="${esc(t('Filter by key or summary'))}" value="${esc(f.q)}" maxlength="300" autocomplete="off" spellcheck="false"></label>`
    + `${dd}${meId ? `<button class="btn sm${f.mine ? ' on' : ''}" data-act="f-mine" aria-pressed="${f.mine}">${t('Only mine')}</button>` : ''}`
    + `<span class="sp"></span><label class="mut sm" for="rf-grp">${t('Group by')}</label><select id="rf-grp" class="rf-sel">${groups}</select></div>`;

  const chips: string[] = [];
  for (const c of f.cats) chips.push(chip(`data-act="f-cat" data-v="${c}"`, t('Status category'), esc(STATUS_LABEL[c])));
  for (const id of FACETS) {
    const all = vals.get(id);
    for (const v of f[id]) {
      const fv = all?.find((x) => x.value === v) ?? { value: v, label: v, count: 0, on: true };
      chips.push(chip(`data-act="f-val" data-facet="${id}" data-v="${esc(v)}"`, facetTitle(id), esc(valueText(id, fv))));
    }
  }
  // «Только мои» без meId кнопки нет, но чип остаётся (из сохранённого состояния) — иначе его нечем снять.
  if (f.mine) chips.push(chip('data-act="f-mine"', t('Only mine'), ''));
  if (f.q.trim()) chips.push(chip('data-act="f-qx"', t('Text'), `“${esc(f.q.trim())}”`));

  const count = active
    ? `${t('Showing {0} of {1}', `<b>${shown}</b>`, rows.length)}${truncated ? esc(t(', loaded only')) : ''}`
    : esc(tn(rows.length, '{0} issue|{0} issues'));
  const row = `<div class="rf-chips">${chips.join('')}${active ? `<button class="lnk" data-act="f-reset">${t('Reset')}</button>` : ''}<span class="sp"></span>`
    + `<span class="mut">${count}</span>`
    + `${active ? `<button class="lnk" data-act="f-jql" data-mode="copy">${t('Copy JQL')}</button><button class="lnk" data-act="f-jql" data-mode="save">${t('Save as filter…')}</button>` : ''}</div>`;
  return bar + row;
}
