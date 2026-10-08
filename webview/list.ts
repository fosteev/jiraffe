// Webview вкладок эпика и релиза: слушает хост, рисует listRender.ts, шлёт действия обратно (всё валидируется в хосте).
import './l10nInit';
import { t } from '../src/l10n';
import type { HostToList, ListPage, ListToHost } from '../src/panels/protocol';
import { esc } from './render';
import { LIST_COLS, renderListPage, type ListCol, type ListSort } from './listRender';

declare function acquireVsCodeApi(): { postMessage(m: ListToHost): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const app = document.getElementById('app') as HTMLElement;

let current: ListPage | undefined;
/** Сортировка колонки — своя у вкладки; в state webview, чтобы пережить выгрузку скрытой вкладки. */
let sort: ListSort | undefined = (() => {
  const s = (vscode.getState() as { sort?: Partial<ListSort> } | undefined)?.sort;
  return s && LIST_COLS.includes(s.col as ListCol) && typeof s.desc === 'boolean' ? { col: s.col as ListCol, desc: s.desc } : undefined;
})();
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
    render();
  }
});

function render(): void {
  if (!current) return;
  app.className = '';
  app.innerHTML = renderListPage(current, sort);
  paint();
}

/** Клик по заголовку: по возрастанию → по убыванию → исходный порядок. Приоритет — сразу срочные сверху. */
function toggleSort(col: ListCol): void {
  const startDesc = col === 'priority';
  if (sort?.col !== col) sort = { col, desc: startDesc };
  else if (sort.desc === startDesc) sort = { col, desc: !startDesc };
  else sort = undefined;
  vscode.setState({ sort });
  render();
  app.querySelector<HTMLElement>(`[data-act="sort"][data-col="${col}"]`)?.focus();
}

function act(el: HTMLElement): void {
  const d = el.dataset;
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
app.addEventListener('keydown', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('tr[data-act]');
  if (el && (ev.key === 'Enter' || ev.key === ' ')) {
    ev.preventDefault();
    act(el);
  }
});

vscode.postMessage({ type: 'ready' });
