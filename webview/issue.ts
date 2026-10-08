// Webview карточки задачи: слушает сообщения хоста, рисует render.ts, шлёт действия обратно.
import './l10nInit';
import { parseDuration } from '../src/duration';
import { t } from '../src/l10n';
import { ISSUE_TABS, type HostToView, type IssueTab, type ViewToHost } from '../src/panels/protocol';
import { esc, renderCard, renderLightbox, renderLogDialog } from './render';

declare function acquireVsCodeApi(): { postMessage(m: ViewToHost): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const app = document.getElementById('app') as HTMLElement;

interface State { instanceId: string; key: string; tab: IssueTab }
let current: Extract<HostToView, { type: 'issue' }>['data'] | undefined;
let tab: IssueTab = 'desc';
/** Картинки текущей карточки: id протокола → data URI или ошибка. Сбрасываются с каждой новой карточкой. */
let images = new Map<string, { dataUri?: string; error?: string }>();
let pending = new Set<string>();
/** Диалог «Залогать время» живёт вне #app: перерисовка карточки (обновление данных) не теряет введённое. */
const dlgRoot = document.createElement('div');
dlgRoot.id = 'dlg';
document.body.appendChild(dlgRoot);
let dialog: { instanceId: string; key: string; busy: boolean } | undefined;

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
    el.textContent = t('[image failed to load: {0}]', r.error ?? t('unknown error'));
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

function closeDialog(force = false): void {
  if (!dialog || (dialog.busy && !force)) return;
  dialog = undefined;
  dlgRoot.innerHTML = '';
}

/** Карточка сменилась на другую задачу — диалог старой закрываем (ответ на отправку всё равно придёт уведомлением). */
function dropStaleDialog(instanceId: string, key: string): void {
  if (dialog && (dialog.instanceId !== instanceId || dialog.key !== key)) closeDialog(true);
}

const dlgEl = <T extends HTMLElement>(sel: string): T | null => dlgRoot.querySelector<T>(sel);

function showLogError(text: string, field?: string): void {
  const err = dlgEl<HTMLElement>('#lg-err');
  if (err) {
    err.textContent = text;
    err.hidden = false;
  }
  let target: HTMLElement | null = null;
  if (field === 'duration') target = dlgEl('#lg-dur');
  else if (field === 'date') target = dlgEl('#lg-date');
  else if (field === 'comment') target = dlgEl('#lg-c');
  else if (field === 'aiTokens') target = dlgEl('#lg-tok');
  else if (field?.startsWith('attr:')) target = [...dlgRoot.querySelectorAll<HTMLElement>('[data-attr]')].find((el) => el.dataset.attr === field.slice(5)) ?? null;
  target?.focus();
}

function setBusy(busy: boolean): void {
  if (!dialog) return;
  dialog.busy = busy;
  const btn = dlgEl<HTMLButtonElement>('[data-act="log-save"]');
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? t('Saving…') : t('Log');
  }
}

/** Значения формы уходят в хост как есть — проверяет хост (`validateDraft`); здесь — только быстрый отклик на длительность. */
function submitLog(): void {
  if (!dialog || dialog.busy) return;
  const val = (sel: string): string => dlgEl<HTMLInputElement | HTMLTextAreaElement>(sel)?.value ?? '';
  const duration = val('#lg-dur');
  if (!parseDuration(duration)) {
    showLogError(t('Could not parse the duration. Try, for example, 1h 30m or 90m.'), 'duration');
    return;
  }
  const attributes = Object.fromEntries([...dlgRoot.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-attr]')].map((el) => [
    el.dataset.attr ?? '',
    el instanceof HTMLInputElement && el.type === 'checkbox' ? (el.checked ? 'true' : '') : el.value,
  ]).filter(([k]) => k));
  const err = dlgEl<HTMLElement>('#lg-err');
  if (err) err.hidden = true;
  setBusy(true);
  vscode.postMessage({
    type: 'submitWorklog', instanceId: dialog.instanceId, key: dialog.key,
    draft: { duration, date: val('#lg-date'), comment: val('#lg-c'), aiTokens: val('#lg-tok'), attributes },
  });
}

function note(html: string, cls = ''): void {
  current = undefined;
  app.className = `note ${cls}`.trim();
  app.innerHTML = html;
}

window.addEventListener('message', (ev: MessageEvent<HostToView>) => {
  const m = ev.data;
  if (m.type === 'loading' || m.type === 'error') dropStaleDialog(m.instanceId, m.key);
  if (m.type === 'loading') {
    // Та же задача (обновление) — оставляем старые данные до ответа; другая (в т.ч. тот же ключ на другом инстансе) — экран загрузки.
    if (!current || current.issue.key !== m.key || current.instanceId !== m.instanceId) note(esc(t('Loading {0}…', m.key)));
  } else if (m.type === 'error') {
    note(`${esc(m.message)}<br><button class="btn" data-act="retry" data-key="${esc(m.key)}">${t('Retry')}</button>`, 'err');
  } else if (m.type === 'issue') {
    dropStaleDialog(m.data.instanceId, m.data.issue.key);
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
  } else if (m.type === 'logForm') {
    if (!current || m.instanceId !== current.instanceId || m.key !== current.issue.key) return;
    if (dialog?.busy) return;
    // Диалог этой задачи уже открыт — не затираем введённое, только фокус.
    if (dialog && dialog.instanceId === m.instanceId && dialog.key === m.key) {
      dlgEl<HTMLInputElement>('#lg-dur')?.focus();
      return;
    }
    closeLightbox();
    dialog = { instanceId: m.instanceId, key: m.key, busy: false };
    dlgRoot.innerHTML = renderLogDialog(m.key, m.form);
    dlgEl<HTMLInputElement>('#lg-dur')?.focus();
  } else if (m.type === 'logResult') {
    if (!dialog || dialog.instanceId !== m.instanceId || dialog.key !== m.key) return;
    setBusy(false);
    if (!m.ok) {
      showLogError(m.error ?? t('Failed to log work'), m.field);
      return;
    }
    closeDialog(true);
    // Как в прототипе: после записи — вкладка «Журнал работ» (данные придут следом: хост перечитывает карточку).
    if (current && current.instanceId === m.instanceId && current.issue.key === m.key && tab !== 'wl') {
      tab = 'wl';
      vscode.setState({ instanceId: current.instanceId, key: current.issue.key, tab } satisfies State);
      vscode.postMessage({ type: 'switchTab', key: current.issue.key, tab });
      draw();
    }
  }
});

dlgRoot.addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement;
  const el = t.closest<HTMLElement>('[data-act]');
  if (!el) return;
  switch (el.dataset.act) {
    case 'dlg-x': closeDialog(); break;
    case 'dlg-bg': if (t === el) closeDialog(); break;
    case 'log-save': submitLog(); break;
  }
});
dlgRoot.addEventListener('submit', (ev) => {
  ev.preventDefault();
  submitLog();
});
dlgRoot.addEventListener('keydown', (ev) => {
  // Ctrl/Cmd+Enter — отправить и из комментария (Enter в однострочных полях отправляет форму сам).
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    submitLog();
  }
});

window.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (app.querySelector('.ov')) closeLightbox();
  else if (dialog) closeDialog();
});

app.addEventListener('click', (ev) => {
  const tg = ev.target as HTMLElement;
  // Картинка описания — в лайтбокс, даже если Jira обернула её в ссылку на вложение.
  const zoom = tg.closest<HTMLImageElement>('img[data-zoom]');
  if (zoom && app.contains(zoom)) {
    ev.preventDefault();
    ev.stopPropagation();
    openLightbox(renderLightbox(zoom.dataset.zoom ?? '', zoom.alt || t('image')));
    return;
  }
  const link = tg.closest<HTMLAnchorElement>('a[href]');
  if (link && app.contains(link)) {
    // stopPropagation обязателен: у VS Code в iframe свой обработчик кликов по ссылкам (defaultPrevented не смотрит) — иначе ссылка откроется дважды.
    ev.preventDefault();
    ev.stopPropagation();
    vscode.postMessage({ type: 'openExternal', url: link.href });
    return;
  }
  const el = tg.closest<HTMLElement>('[data-act]');
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
    case 'askAi': if (current) vscode.postMessage({ type: 'askAi', key: current.issue.key }); break;
    case 'copyKey': if (current) vscode.postMessage({ type: 'copyKey', key: current.issue.key }); break;
    case 'openInBrowser': if (current) vscode.postMessage({ type: 'openInBrowser', key: current.issue.key }); break;
    case 'logWork': if (current) vscode.postMessage({ type: 'logWork', key: current.issue.key }); break;
    case 'transition': if (current) vscode.postMessage({ type: 'transition', key: current.issue.key }); break;
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
    case 'ov-bg': if (tg === el) closeLightbox(); break; // клик по фону, не по содержимому лайтбокса
  }
});

vscode.postMessage({ type: 'ready' });
