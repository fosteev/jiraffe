// Модель фильтра вкладки релиза: чистые функции без vscode и DOM (тестируются в vitest, ходят и в webview, и в хост).
// Фильтр иммутабелен: каждая операция возвращает новый объект — его можно класть в `setState` как есть.
import { priorityRank, progressOf } from '../src/jira/epics';
import type { Progress } from '../src/jira/types';
import type { FilterCat, FilterGroup, ListRow, ReleaseFilter } from '../src/panels/protocol';

/** Фасеты-списки. Категория статуса (`cats`) — отдельно: это плитки прогресса; `status` — конкретные статусы списком. */
export type FacetId = 'status' | 'assignee' | 'type' | 'priority' | 'epic';
export const FACETS: readonly FacetId[] = ['status', 'assignee', 'type', 'priority', 'epic'];
export type SkipId = FacetId | 'cats';

export const FILTER_CATS: readonly FilterCat[] = ['new', 'indeterminate', 'done'];
export const FILTER_GROUPS: readonly FilterGroup[] = ['none', 'assignee', 'epic', 'status'];

/** Предел на мусор из `getState`: столько значений в одном фасете и такой длины читаем. */
const MAX_VALUES = 200;
const MAX_LEN = 300;
/** Сколько элементов массива вообще просматриваем (дальше не читаем, даже если годных меньше `MAX_VALUES`). */
const MAX_SCAN = 1000;

export const emptyFilter = (): ReleaseFilter => ({ q: '', cats: [], status: [], assignee: [], type: [], priority: [], epic: [], mine: false, group: 'none' });

/** Что-то сужает выборку. Группировка — не фильтр, на «активность» не влияет. */
export const isActive = (f: ReleaseFilter): boolean =>
  !!f.q.trim() || f.mine || f.cats.length > 0 || FACETS.some((id) => f[id].length > 0);

/** Значение фасета у строки; пустая строка — «пусто» (не назначена / без эпика / без приоритета). */
export function rowValue(row: ListRow, facet: FacetId): string {
  switch (facet) {
    case 'status': return row.status;
    case 'assignee': return row.assignee?.id ?? '';
    case 'type': return row.type;
    case 'priority': return row.priority ?? '';
    case 'epic': return row.epicKey ?? '';
  }
}

/**
 * Строки под фильтром. `skip` выключает один фасет (для счётчиков: сколько строк дал бы каждый вариант этого фасета).
 * `mine` без `meId` не действует: неизвестно, кто «я», пустая выдача была бы хуже, чем игнор.
 */
export function applyFilter(rows: readonly ListRow[], f: ReleaseFilter, meId?: string, skip?: SkipId): ListRow[] {
  const q = f.q.trim().toLowerCase();
  const mine = f.mine && !!meId;
  return rows.filter((r) => {
    if (q && !r.key.toLowerCase().includes(q) && !r.summary.toLowerCase().includes(q)) return false;
    if (skip !== 'cats' && f.cats.length && !f.cats.includes(r.statusCategory)) return false;
    for (const id of FACETS) if (id !== skip && f[id].length && !f[id].includes(rowValue(r, id))) return false;
    if (mine && r.assignee?.id !== meId) return false;
    return true;
  });
}

export interface FacetValue {
  value: string;
  /** Подпись для показа: имя исполнителя, название эпика; для `''` и остальных фасетов — само значение (пусто — подпись за UI). */
  label: string;
  /** Сколько строк дал бы вариант при остальных активных фильтрах (свой фасет не учитывается). */
  count: number;
  on: boolean;
  /** Только у фасета статуса: категория (цвет плашки и порядок). */
  cat?: FilterCat;
}

/**
 * Варианты фасета: все значения из `rows` (не только отфильтрованных) + выбранные, которых в `rows` нет (счётчик 0).
 * Порядок: статус — по категории (new, indeterminate, done), приоритет — по `priorityRank`, затем (и у остальных) счётчик по убыванию,
 * затем подпись; пустое значение всегда последним.
 */
export function facetValues(rows: readonly ListRow[], f: ReleaseFilter, meId: string | undefined, facet: FacetId): FacetValue[] {
  const labels = new Map<string, string>();
  const cats = new Map<string, FilterCat>();
  for (const r of rows) {
    const v = rowValue(r, facet);
    if (labels.has(v)) continue;
    if (facet === 'status') cats.set(v, r.statusCategory);
    labels.set(v, facet === 'assignee' ? (r.assignee?.name ?? v) : facet === 'epic' ? (r.extra ?? v) : v);
  }
  for (const v of f[facet]) if (!labels.has(v)) labels.set(v, v);
  const counts = new Map<string, number>();
  for (const r of applyFilter(rows, f, meId, facet)) {
    const v = rowValue(r, facet);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const out: FacetValue[] = [...labels].map(([value, label]) => ({ value, label, count: counts.get(value) ?? 0, on: f[facet].includes(value), ...(cats.has(value) ? { cat: cats.get(value) } : {}) }));
  const byName = (a: FacetValue, b: FacetValue): number => a.label.localeCompare(b.label) || a.value.localeCompare(b.value);
  return out.sort((a, b) => {
    if (!a.value !== !b.value) return a.value ? -1 : 1; // '' — в конец
    if (facet === 'priority') return priorityRank(a.value) - priorityRank(b.value) || byName(a, b);
    // Статус без строк (остался только в фильтре) — после известных.
    if (facet === 'status') return (a.cat ? CAT_RANK[a.cat] : 3) - (b.cat ? CAT_RANK[b.cat] : 3) || b.count - a.count || byName(a, b);
    return b.count - a.count || byName(a, b);
  });
}

export interface RowGroup {
  /** Значение группировки: id исполнителя, ключ эпика, категория статуса; `''` — без исполнителя / без эпика. */
  key: string;
  label: string;
  rows: ListRow[];
  progress: Progress;
}

const CAT_RANK: Record<FilterCat, number> = { new: 0, indeterminate: 1, done: 2 };
const natural = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/**
 * Группы строк. `none` — одна группа со всеми строками (пусто — ни одной). Порядок групп: исполнитель — сначала `meId`, затем по имени,
 * пустой последним; эпик — по ключу, пустой последним; статус — new, indeterminate, done (только непустые). Порядок строк внутри
 * группы — как во входе.
 */
export function groupRows(rows: readonly ListRow[], by: FilterGroup, meId?: string): RowGroup[] {
  const mk = (key: string, label: string, list: ListRow[]): RowGroup => ({ key, label, rows: list, progress: progressOf(list.map((r) => r.statusCategory)) });
  if (by === 'none') return rows.length ? [mk('', '', [...rows])] : [];
  const keyOf = (r: ListRow): string => (by === 'assignee' ? rowValue(r, 'assignee') : by === 'epic' ? rowValue(r, 'epic') : r.statusCategory);
  const map = new Map<string, ListRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const l = map.get(k);
    if (l) l.push(r);
    else map.set(k, [r]);
  }
  const labelOf = (k: string, list: ListRow[]): string =>
    by === 'assignee' ? (list[0].assignee?.name ?? k) : by === 'epic' ? (list[0].extra ?? k) : k;
  const groups = [...map].map(([k, list]) => mk(k, labelOf(k, list), list));
  return groups.sort((a, b) => {
    if (by === 'status') return CAT_RANK[a.key as FilterCat] - CAT_RANK[b.key as FilterCat];
    if (!a.key !== !b.key) return a.key ? -1 : 1;
    if (by === 'assignee') {
      const am = !!meId && a.key === meId;
      const bm = !!meId && b.key === meId;
      if (am !== bm) return am ? -1 : 1;
      return a.label.localeCompare(b.label) || a.key.localeCompare(b.key);
    }
    return natural(a.key, b.key);
  });
}

// ----- изменения фильтра -----

const flip = (list: readonly string[], v: string): string[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

export const setQuery = (f: ReleaseFilter, q: string): ReleaseFilter => ({ ...f, q });
export const setGroup = (f: ReleaseFilter, group: FilterGroup): ReleaseFilter => ({ ...f, group });
export const toggleMine = (f: ReleaseFilter): ReleaseFilter => ({ ...f, mine: !f.mine });

/** Категория вкл/выкл; порядок в `cats` всегда канонический (new, indeterminate, done). */
export function toggleCat(f: ReleaseFilter, c: FilterCat): ReleaseFilter {
  const on = flip(f.cats, c);
  return { ...f, cats: FILTER_CATS.filter((x) => on.includes(x)) };
}

export const toggleValue = (f: ReleaseFilter, facet: FacetId, value: string): ReleaseFilter => ({ ...f, [facet]: flip(f[facet], value) });
/** «Выбрать все»: все переданные значения фасета (обычно `facetValues(...).map(v => v.value)`). */
export const selectAll = (f: ReleaseFilter, facet: FacetId, values: readonly string[]): ReleaseFilter => ({ ...f, [facet]: [...new Set(values)] });
export const clearFacet = (f: ReleaseFilter, facet: FacetId | 'cats'): ReleaseFilter => ({ ...f, [facet]: [] });
export const clearQuery = (f: ReleaseFilter): ReleaseFilter => ({ ...f, q: '' });
/** «Сбросить»: всё, кроме группировки (она не фильтр — как в прототипе). */
export const resetFilter = (f: ReleaseFilter): ReleaseFilter => ({ ...emptyFilter(), group: f.group });

// ----- чтение недоверенного -----

function strings(v: unknown, allowEmpty: boolean): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (let i = 0; i < Math.min(v.length, MAX_SCAN); i++) {
    const x: unknown = v[i];
    // '' — «пустое значение» (где разрешено); строка из одних пробелов — мусор.
    if (typeof x !== 'string' || x.length > MAX_LEN || (x ? !x.trim() : !allowEmpty) || out.includes(x)) continue;
    out.push(x);
    if (out.length >= MAX_VALUES) break;
  }
  return out;
}

/** Из `getState` или сообщения webview: лишнее выбрасывается, неверное — значение по умолчанию. Никогда не бросает. */
export function sanitizeFilter(x: unknown): ReleaseFilter {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return emptyFilter();
  const o = x as Record<string, unknown>;
  const cats = strings(o.cats, false);
  return {
    q: typeof o.q === 'string' ? o.q.slice(0, MAX_LEN) : '',
    cats: FILTER_CATS.filter((c) => cats.includes(c)),
    // У задачи статус есть всегда: пустое значение — мусор.
    status: strings(o.status, false),
    assignee: strings(o.assignee, true),
    // У задачи тип есть всегда: пустое значение для типа — мусор.
    type: strings(o.type, false),
    priority: strings(o.priority, true),
    epic: strings(o.epic, true),
    mine: o.mine === true,
    group: FILTER_GROUPS.find((g) => g === o.group) ?? 'none',
  };
}
