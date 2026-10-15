// Webview вкладок эпика и релиза: слушает хост, рисует listRender.ts, шлёт действия обратно (всё валидируется в хосте).
import './l10nInit';
import { t } from '../src/l10n';
import type { FilterCat, FilterGroup, HostToList, ListPage, ListToHost, ReleaseFilter, ReleasePage } from '../src/panels/protocol';
import { esc } from './render';
import { LIST_COLS, renderListPage, type ListCol, type ListSort } from './listRender';
import {
  FACETS, FILTER_CATS, FILTER_GROUPS, clearFacet, clearQuery, facetValues, resetFilter, sanitizeFilter, selectAll, setGroup, setQuery, toggleCat, toggleMine, toggleValue,
  type FacetId,
} from './releaseFilter';

declare function acquireVsCodeApi(): { postMessage(m: ListToHost): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const app = document.getElementById('app') as HTMLElement;

let current: ListPage | undefined;
/** Сортировка колонки — своя у вкладки; в state webview, чтобы пережить выгрузку скрытой вкладки. */
const saved = vscode.getState() as { sort?: Partial<ListSort>; filter?: unknown } | undefined;
let sort: ListSort | undefined = (() => {
  const s = saved?.sort;
  return s && LIST_COLS.includes(s.col as ListCol) && typeof s.desc === 'boolean' ? { col: s.col as ListCol, desc: s.desc } : undefined;
})();
/** Фильтр релиза (включая группировку) — тоже в state webview: переживает скрытие вкладки и `refresh`, теряется при закрытии вкладки. */
let filter: ReleaseFilter = sanitizeFilter(saved?.filter);
/** Раскрытый фасет — состояние только интерфейса, в state не кладём. */
let openFacet: FacetId | undefined;
/** Идёт IME-композиция в поле поиска: перерисовку от новой `page` откладываем — compositionend всё равно перерисует. */
let composing = false;
const saveState = (): void => vscode.setState({ sort, filter });
const idOf = (p: ListPage): string => (p.type === 'epic' ? p.key : p.id);

/** Цвет аватара и ширина сегментов — через CSSOM: inline style="…" запрещён CSP (style-src без unsafe-inline). */
function paint(): void {
  for (const el of app.querySelectorAll<HTMLElement>('[data-bg]')) {
    const id = el.dataset.bg ?? '';
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    el.style.background = id === '?' ? 'var(--vscode-disabledForeground)' : `hsl(${h % 360} 42% 38%)`;
  }
  for (const el of app.querySelectorAll<HTMLElement>('[data-w]')) el.style.width = `${el.dataset.w}%`;
}

function note(html: string, cls = ''): void {
  current = undefined;
  app.className = `note ${cls}`.trim();
  app.innerHTML = html;
}

window.addEventListener('message', (ev: MessageEvent<HostToList>) => {
  const m = ev.data;
  if (m?.type === 'loading') {
    if (!current || current.type !== m.kind || current.instanceId !== m.instanceId || idOf(current) !== m.id) note(t('Loading…'));
  } else if (m?.type === 'error') {
    const target = `data-instance="${esc(m.instanceId)}" data-kind="${m.kind}" data-id="${esc(m.id)}"`;
    note(`${esc(m.message)}<br><button class="btn" data-act="refresh" ${target}>${t('Retry')}</button>`, 'err');
  } else if (m?.type === 'page') {
    current = m.data;
    // Во время IME-композиции в поиске перерисовка пересоздала бы поле и потеряла набираемое — дорисуем на compositionend.
    if (!composing) render();
  }
});

/**
 * Ключ фокусируемого элемента: пока страница перерисовывается целиком (innerHTML), он позволяет вернуть фокус туда же.
 * Зона нужна, чтобы отличить плитку от одноимённой кнопки легенды.
 */
const ZONES = ['sum', 'legend', 'rf-chips', 'rf-pop', 'rf-bar', 'rf-empty'];
const quickKey = (el: HTMLElement): string => (el.id ? `#${el.id}` : el.dataset.act ? [el.dataset.act, el.dataset.facet, el.dataset.v, el.dataset.col, el.dataset.key, el.dataset.mode].join('|') : '');
const zoneOf = (el: HTMLElement): string => ZONES.find((z) => el.closest(`.${z}`)) ?? '';

function render(): void {
  if (!current) return;
  const a = document.activeElement;
  const keep = a instanceof HTMLElement && app.contains(a) && quickKey(a) ? { key: quickKey(a), zone: zoneOf(a), sel: a instanceof HTMLInputElement ? [a.selectionStart, a.selectionEnd] as const : undefined } : undefined;
  const popTop = app.querySelector('.rf-pop')?.scrollTop ?? 0;
  app.className = '';
  app.innerHTML = renderListPage(current, sort, filter, { open: openFacet });
  paint();
  const pop = app.querySelector('.rf-pop');
  if (pop) pop.scrollTop = popTop;
  if (!keep) return;
  for (const el of app.querySelectorAll<HTMLElement>('[data-act],input[id],select[id]')) {
    if (quickKey(el) !== keep.key || zoneOf(el) !== keep.zone) continue;
    el.focus({ preventScroll: true });
    if (keep.sel && el instanceof HTMLInputElement && keep.sel[0] !== null && keep.sel[1] !== null) el.setSelectionRange(keep.sel[0], keep.sel[1]);
    return;
  }
  // Элемент исчез (снятый чип, «Сбросить»): фокус не должен уходить в body — берём соседний чип или поиск.
  if (keep.zone === 'rf-chips' || keep.zone === 'rf-empty') (app.querySelector<HTMLElement>('.rf-chips .chip') ?? app.querySelector<HTMLElement>('#rf-q'))?.focus({ preventScroll: true });
  // «Очистить» в списке фасета пропадает после нажатия — фокус остаётся в списке, на «Выбрать все».
  else if (keep.zone === 'rf-pop') app.querySelector<HTMLElement>('.rf-pop [data-act="f-all"]')?.focus({ preventScroll: true });
}

/**
 * Закрыть раскрытый фасет без перерисовки страницы: убрать список и снять `aria-expanded`. Полный render() здесь
 * пересоздал бы элемент под курсором — например, открывающийся <select> «Группировать» схлопывался бы с первого клика.
 * Возвращает кнопку фасета (для возврата фокуса по Escape).
 */
function closeFacet(): HTMLElement | undefined {
  const id = openFacet;
  openFacet = undefined;
  app.querySelector('.rf-pop')?.remove();
  const btn = app.querySelector<HTMLElement>(`[data-act="f-dd"][data-facet="${id}"]`) ?? undefined;
  btn?.setAttribute('aria-expanded', 'false');
  return btn;
}

/** Новый фильтр → в state и на экран. */
function update(next: ReleaseFilter): void {
  filter = next;
  saveState();
  render();
}

/** Клик по заголовку: по возрастанию → по убыванию → исходный порядок. Приоритет — сразу срочные сверху. */
function toggleSort(col: ListCol): void {
  const startDesc = col === 'priority';
  if (sort?.col !== col) sort = { col, desc: startDesc };
  else if (sort.desc === startDesc) sort = { col, desc: !startDesc };
  else sort = undefined;
  saveState();
  render();
  app.querySelector<HTMLElement>(`[data-act="sort"][data-col="${col}"]`)?.focus();
}

const isFacet = (v: string | undefined): v is FacetId => FACETS.includes(v as FacetId);
const isCat = (v: string | undefined): v is FilterCat => FILTER_CATS.includes(v as FilterCat);
const isGroup = (v: string | undefined): v is FilterGroup => FILTER_GROUPS.includes(v as FilterGroup);
const release = (): ReleasePage | undefined => (current?.type === 'release' ? current : undefined);

/** Действия фильтра релиза (`data-act="f-*"`). */
function filterAct(d: DOMStringMap): void {
  const p = release();
  if (!p) return;
  switch (d.act) {
    case 'f-cat':
      if (isCat(d.v)) update(toggleCat(filter, d.v));
      break;
    case 'f-dd':
      if (isFacet(d.facet)) {
        openFacet = openFacet === d.facet ? undefined : d.facet;
        render();
      }
      break;
    case 'f-val':
      if (isFacet(d.facet) && d.v !== undefined) update(toggleValue(filter, d.facet, d.v));
      break;
    case 'f-all':
      if (isFacet(d.facet)) update(selectAll(filter, d.facet, facetValues(p.rows, filter, p.meId, d.facet).map((v) => v.value)));
      break;
    case 'f-clr':
      if (isFacet(d.facet)) update(clearFacet(filter, d.facet));
      break;
    case 'f-mine':
      update(toggleMine(filter));
      break;
    case 'f-qx':
      update(clearQuery(filter));
      break;
    case 'f-reset':
      openFacet = undefined;
      update(resetFilter(filter));
      break;
    case 'f-jql':
      if (d.mode === 'copy' || d.mode === 'save') vscode.postMessage({ type: 'filterJql', instanceId: p.instanceId, kind: 'release', id: p.id, action: d.mode, filter });
      break;
  }
}

function act(el: HTMLElement): void {
  const d = el.dataset;
  if (d.act?.startsWith('f-')) return filterAct(d);
  switch (d.act) {
    case 'open':
      if (current && d.key) vscode.postMessage({ type: 'openIssue', instanceId: current.instanceId, key: d.key });
      break;
    case 'browser':
      if (current) vscode.postMessage({ type: 'openInBrowser', instanceId: current.instanceId, kind: current.type, id: idOf(current) });
      break;
    case 'sort':
      if (current && LIST_COLS.includes(d.col as ListCol)) toggleSort(d.col as ListCol);
      break;
    case 'refresh':
      if (current) vscode.postMessage({ type: 'refresh', instanceId: current.instanceId, kind: current.type, id: idOf(current) });
      else if (d.instance && d.id && (d.kind === 'epic' || d.kind === 'release')) vscode.postMessage({ type: 'refresh', instanceId: d.instance, kind: d.kind, id: d.id });
      break;
  }
}

app.addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement;
  // Ссылок на внешние адреса здесь нет, но поведение то же, что в карточке: у VS Code в iframe свой обработчик `a[href]`.
  const link = t.closest<HTMLAnchorElement>('a[href]');
  if (link && app.contains(link)) {
    ev.preventDefault();
    ev.stopPropagation();
    return;
  }
  const el = t.closest<HTMLElement>('[data-act]');
  if (el && !el.hasAttribute('disabled')) act(el);
});

// Клик вне раскрытого фасета закрывает его. На document и в фазе захвата: ловит и клик ниже короткой страницы (в body),
// и срабатывает до действия, пока цель ещё в DOM (действие перерисовывает страницу и отрывает цель от документа).
document.addEventListener('click', (ev) => {
  if (openFacet && !(ev.target instanceof Element && ev.target.closest('.rf-dd'))) closeFacet();
}, true);

/** Фокус на строку фасета со смещением; `from` — текущий элемент (кнопка фасета или строка). */
function moveInPop(from: HTMLElement, delta: 1 | -1): void {
  const items = [...app.querySelectorAll<HTMLElement>('.rf-pop .qp-i')];
  if (!items.length) return;
  const i = items.indexOf(from);
  (i < 0 ? items[delta > 0 ? 0 : items.length - 1] : items[Math.min(items.length - 1, Math.max(0, i + delta))]).focus();
}

app.addEventListener('keydown', (ev) => {
  const target = ev.target as HTMLElement;
  const el = target.closest<HTMLElement>('tr[data-act], .qp-i[data-act]');
  if (el && target === el && (ev.key === 'Enter' || ev.key === ' ')) {
    ev.preventDefault();
    act(el);
    return;
  }
  if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && (target.closest('.qp-i') || (target.dataset.act === 'f-dd' && openFacet === target.dataset.facet))) {
    ev.preventDefault();
    moveInPop(target, ev.key === 'ArrowDown' ? 1 : -1);
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || !openFacet) return;
  closeFacet()?.focus();
});

/** Поиск: фильтр обновляется на каждый ввод; во время IME-композиции ждём её конца. */
function onQuery(input: HTMLInputElement): void {
  update(setQuery(filter, input.value));
}
app.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el instanceof HTMLInputElement && el.id === 'rf-q' && !(ev as InputEvent).isComposing) onQuery(el);
});
app.addEventListener('compositionstart', (ev) => {
  if (ev.target instanceof HTMLInputElement && ev.target.id === 'rf-q') composing = true;
});
app.addEventListener('compositionend', (ev) => {
  const el = ev.target;
  if (!(el instanceof HTMLInputElement) || el.id !== 'rf-q') return;
  composing = false;
  onQuery(el);
});
app.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el instanceof HTMLSelectElement && el.id === 'rf-grp' && isGroup(el.value)) update(setGroup(filter, el.value));
});

vscode.postMessage({ type: 'ready' });
