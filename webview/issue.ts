// Webview карточки задачи: слушает сообщения хоста, рисует render.ts, шлёт действия обратно.
import { ISSUE_TABS, type HostToView, type IssueTab, type ViewToHost } from '../src/panels/protocol';
import { esc, renderCard } from './render';

declare function acquireVsCodeApi(): { postMessage(m: ViewToHost): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const app = document.getElementById('app') as HTMLElement;

interface State { instanceId: string; key: string; tab: IssueTab }
let current: Extract<HostToView, { type: 'issue' }>['data'] | undefined;
let tab: IssueTab = 'desc';

const isTab = (v: unknown): v is IssueTab => ISSUE_TABS.includes(v as IssueTab);
function savedState(): State | undefined {
  const s = vscode.getState() as Partial<State> | undefined;
  return s && typeof s.instanceId === 'string' && typeof s.key === 'string' && isTab(s.tab) ? { instanceId: s.instanceId, key: s.key, tab: s.tab } : undefined;
}

/** Цвет аватара и ширина полосок — через CSSOM: inline style="…" запрещён CSP (style-src без unsafe-inline). */
function paint(): void {
  for (const el of app.querySelectorAll<HTMLElement>('[data-bg]')) {
    const id = el.dataset.bg ?? '';
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    el.style.background = id === '?' ? 'var(--vscode-disabledForeground)' : `hsl(${h % 360} 42% 38%)`;
  }
  for (const el of app.querySelectorAll<HTMLElement>('[data-w]')) el.style.width = `${el.dataset.w}%`;
}

function draw(): void {
  if (!current) return;
  app.className = '';
  app.innerHTML = renderCard(current, tab);
  paint();
}

function note(html: string, cls = ''): void {
  current = undefined;
  app.className = `note ${cls}`.trim();
  app.innerHTML = html;
}

window.addEventListener('message', (ev: MessageEvent<HostToView>) => {
  const m = ev.data;
  if (m.type === 'loading') {
    // Та же задача (обновление) — оставляем старые данные до ответа; другая (в т.ч. тот же ключ на другом инстансе) — экран загрузки.
    if (!current || current.issue.key !== m.key || current.instanceId !== m.instanceId) note(`Загрузка ${esc(m.key)}…`);
  } else if (m.type === 'error') {
    note(`${esc(m.message)}<br><button class="btn" data-act="retry" data-key="${esc(m.key)}">Повторить</button>`, 'err');
  } else if (m.type === 'issue') {
    const s = savedState();
    // Та же задача (повторное открытие, возврат на вкладку) — остаёмся на выбранной вкладке; другая — вкладка из хоста.
    tab = s && s.key === m.data.issue.key && s.instanceId === m.data.instanceId ? s.tab : m.data.tab;
    current = m.data;
    vscode.setState({ instanceId: m.data.instanceId, key: m.data.issue.key, tab } satisfies State);
    draw();
  }
});

app.addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement;
  const link = t.closest<HTMLAnchorElement>('a[href]');
  if (link && app.contains(link)) {
    // stopPropagation обязателен: у VS Code в iframe свой обработчик кликов по ссылкам (defaultPrevented не смотрит) — иначе ссылка откроется дважды.
    ev.preventDefault();
    ev.stopPropagation();
    vscode.postMessage({ type: 'openExternal', url: link.href });
    return;
  }
  const el = t.closest<HTMLElement>('[data-act]');
  if (!el || el.hasAttribute('disabled')) return;
  switch (el.dataset.act) {
    case 'tab': {
      const next = el.dataset.tab;
      if (!isTab(next) || !current) return;
      tab = next;
      vscode.setState({ instanceId: current.instanceId, key: current.issue.key, tab } satisfies State);
      vscode.postMessage({ type: 'switchTab', key: current.issue.key, tab });
      draw();
      break;
    }
    case 'copyKey': if (current) vscode.postMessage({ type: 'copyKey', key: current.issue.key }); break;
    case 'openInBrowser': if (current) vscode.postMessage({ type: 'openInBrowser', key: current.issue.key }); break;
    case 'logWork': if (current) vscode.postMessage({ type: 'logWork', key: current.issue.key }); break;
    case 'pin': if (current) vscode.postMessage({ type: 'pin', key: current.issue.key }); break;
    case 'epic': if (el.dataset.key) vscode.postMessage({ type: 'openEpic', key: el.dataset.key }); break;
    case 'release': if (el.dataset.id) vscode.postMessage({ type: 'openRelease', id: el.dataset.id }); break;
    case 'retry': if (el.dataset.key) vscode.postMessage({ type: 'openIssue', key: el.dataset.key }); break;
  }
});

vscode.postMessage({ type: 'ready' });
