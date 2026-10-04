// Webview карточки задачи: слушает сообщения хоста, рисует render.ts, шлёт действия обратно.
import { ISSUE_TABS, type HostToView, type IssueTab, type ViewToHost } from '../src/panels/protocol';
import { esc, renderCard, renderLightbox } from './render';

declare function acquireVsCodeApi(): { postMessage(m: ViewToHost): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const app = document.getElementById('app') as HTMLElement;

interface State { instanceId: string; key: string; tab: IssueTab }
let current: Extract<HostToView, { type: 'issue' }>['data'] | undefined;
let tab: IssueTab = 'desc';
/** Картинки текущей карточки: id протокола → data URI или ошибка. Сбрасываются с каждой новой карточкой. */
let images = new Map<string, { dataUri?: string; error?: string }>();
let pending = new Set<string>();

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

/** Плейсхолдер `[data-img]` → картинка (если уже есть) или запрос хосту (одним сообщением, хост отвечает по одной). */
function fill(): void {
  if (!current) return;
  const want: string[] = [];
  for (const el of app.querySelectorAll<HTMLElement>('[data-img]')) {
    const id = el.dataset.img ?? '';
    const r = images.get(id);
    if (r) apply(el, id, r);
    else if (!pending.has(id)) {
      pending.add(id);
      want.push(id);
    }
  }
  if (want.length) vscode.postMessage({ type: 'loadImages', instanceId: current.instanceId, key: current.issue.key, ids: want });
}

/** Картинка вставляется через DOM (не innerHTML) и только как `data:image/…` — другой src (URL Jira, javascript:) не пройдёт. */
function apply(el: HTMLElement, id: string, r: { dataUri?: string; error?: string }): void {
  if (r.dataUri && /^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]*$/.test(r.dataUri)) {
    const img = document.createElement('img');
    img.src = r.dataUri;
    img.alt = el.title || '';
    if (el.title) img.title = el.title;
    // Картинка описания/комментария открывается в лайтбоксе; превью вложения — по кнопке вокруг неё.
    if (id.startsWith('i') && !el.closest('.lb-box')) {
      img.className = 'zoom';
      img.dataset.zoom = id;
    }
    el.replaceWith(img);
  } else {
    el.removeAttribute('data-img');
    el.classList.add('err');
    el.textContent = `[картинка не загрузилась: ${r.error ?? 'неизвестная ошибка'}]`;
  }
}

function draw(): void {
  if (!current) return;
  app.className = '';
  app.innerHTML = renderCard(current, tab);
  paint();
  fill();
}

function openLightbox(html: string): void {
  closeLightbox();
  app.insertAdjacentHTML('beforeend', html);
  app.querySelector<HTMLElement>('.lb-box button')?.focus();
  fill();
}
function closeLightbox(): void {
  app.querySelector('.ov')?.remove();
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
    images = new Map();
    pending = new Set();
    vscode.setState({ instanceId: m.data.instanceId, key: m.data.issue.key, tab } satisfies State);
    draw();
  } else if (m.type === 'attachmentPreview') {
    if (!current || m.instanceId !== current.instanceId || m.key !== current.issue.key) return;
    pending.delete(m.id);
    const r = { dataUri: m.dataUri, error: m.error };
    images.set(m.id, r);
    for (const el of app.querySelectorAll<HTMLElement>('[data-img]')) if (el.dataset.img === m.id) apply(el, m.id, r);
  }
});

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && app.querySelector('.ov')) closeLightbox();
});

app.addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement;
  // Картинка описания — в лайтбокс, даже если Jira обернула её в ссылку на вложение.
  const zoom = t.closest<HTMLImageElement>('img[data-zoom]');
  if (zoom && app.contains(zoom)) {
    ev.preventDefault();
    ev.stopPropagation();
    openLightbox(renderLightbox(zoom.dataset.zoom ?? '', zoom.alt || 'картинка'));
    return;
  }
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
    case 'img': {
      const a = current?.attachments.find((x) => x.id === el.dataset.id);
      if (a) openLightbox(renderLightbox(`f${a.id}`, a.filename, a));
      break;
    }
    case 'dl': if (current && el.dataset.id) vscode.postMessage({ type: 'downloadAttachment', instanceId: current.instanceId, key: current.issue.key, id: el.dataset.id }); break;
    case 'openAtt': if (current && el.dataset.id) vscode.postMessage({ type: 'openAttachment', instanceId: current.instanceId, key: current.issue.key, id: el.dataset.id }); break;
    case 'dlAll': if (current) vscode.postMessage({ type: 'downloadAll', instanceId: current.instanceId, key: current.issue.key }); break;
    case 'ov-x': closeLightbox(); break;
    case 'ov-bg': if (t === el) closeLightbox(); break; // клик по фону, не по содержимому лайтбокса
  }
});

vscode.postMessage({ type: 'ready' });
