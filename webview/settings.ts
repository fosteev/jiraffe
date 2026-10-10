// Webview вкладки «Настройки Jiraffe»: рисует SettingsState от хоста и шлёт намерения (set/reset/pickDir/openJson).
// Источник правды — хост: после каждой правки он присылает новое состояние. Поиск — только здесь.
import './l10nInit';
import { t } from '../src/l10n';
import type { HostToSettings, SettingsToHost } from '../src/panels/protocol';
import type { Control, Level, SectionId, SettingRow, SettingsState, SortControl } from '../src/panels/settingsModel';
import { esc } from './render';

declare function acquireVsCodeApi(): { postMessage(m: SettingsToHost): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const app = document.getElementById('app') as HTMLElement;

let state: SettingsState | undefined;
let query = ((vscode.getState() as { q?: unknown } | undefined)?.q as string | undefined) ?? '';
if (typeof query !== 'string') query = '';
let activeSec: SectionId = 'list';
/** Поля, где введено, но ещё не отправлено (`change` не было): перерисовка по чужому событию не должна стирать ввод. */
const dirty = new Set<string>();

const send = (m: SettingsToHost): void => vscode.postMessage(m);

const levelText = (l: Level): string =>
  l === 'workspaceFolder' ? t('folder') : l === 'workspace' ? t('workspace') : l === 'user' ? t('user') : l === 'state' ? t('state') : t('auto');
const levelTitle = (l: Level): string =>
  l === 'workspaceFolder' ? t('Stored in the workspace folder settings')
  : l === 'workspace' ? t('Stored in this workspace\'s .vscode/settings.json')
  : l === 'user' ? t('Stored in your user settings.json')
  : l === 'state' ? t('Stored in the extension state, not in settings.json')
  : t('Determined automatically, nothing to change');

function sortControl(row: SettingRow, c: SortControl): string {
  const opts = c.fields.map((f) => `<option value="${esc(f.value)}"${f.value === c.field ? ' selected' : ''}>${esc(f.label)}</option>`).join('');
  const dirs = [[true, t('Descending')], [false, t('Ascending')]] as const;
  const dirOpts = dirs.map(([d, l]) => `<option value="${d ? 'desc' : 'asc'}"${d === c.desc ? ' selected' : ''}>${esc(l)}</option>`).join('');
  return `<select data-sort="field" data-f="${row.id}:field" aria-label="${esc(row.title)}">${opts}</select>`
    + `<select data-sort="dir" data-f="${row.id}:dir" aria-label="${esc(t('Direction'))}"${c.field ? '' : ' disabled'}>${dirOpts}</select>`;
}

function control(row: SettingRow, c: Control): string {
  switch (c.kind) {
    case 'number':
      return `<input class="n" type="number" min="${c.min}" max="${c.max}" step="${c.step}" value="${esc(String(c.value))}" data-num data-f="${row.id}" aria-label="${esc(row.title)}"><span class="mut sm">${esc(c.unit)}</span>`;
    case 'text':
      return `<input class="t" type="text" value="${esc(String(c.value))}" placeholder="${esc(c.placeholder)}" data-txt data-f="${row.id}" aria-label="${esc(row.title)}" spellcheck="false">`
        + (c.pick ? `<button class="btn sm" data-pick>${esc(t('Choose…'))}</button>` : `<span class="mut sm">${esc(t('Open a folder to choose one'))}</span>`);
    case 'switch':
      return `<button class="sw${c.value ? ' on' : ''}" role="switch" aria-checked="${c.value}" aria-label="${esc(row.title)}" data-sw data-f="${row.id}"></button><span class="sm">${esc(c.value ? t('On') : t('Off'))}</span>`;
    case 'sort':
      return sortControl(row, c);
  }
}

function renderRow(row: SettingRow): string {
  const hay = `${row.cat} ${row.title} ${row.desc} ${row.key ?? ''}`.toLowerCase();
  const reset = row.modified ? `<button class="lnk rst" data-reset>${esc(t('Reset to {0}', row.resetTo))}</button>` : '';
  return `<div class="set${row.modified ? ' mod' : ''}" data-id="${row.id}" data-q="${esc(hay)}">`
    + `<div class="set-t"><span><span class="cat">${esc(row.cat)}: </span>${esc(row.title)}</span>`
    + `<span class="where" title="${esc(levelTitle(row.level))}">${esc(levelText(row.level))}</span>`
    + (row.key ? `<code class="sm mut key">${esc(row.key)}</code>` : '') + '</div>'
    + `<div class="set-d">${esc(row.desc)}</div>`
    + `<div class="set-c">${control(row, row.control)}${reset}</div></div>`;
}

function renderState(s: SettingsState): string {
  const nav = s.sections.map((x) => `<button class="${x.id === activeSec ? 'on' : ''}" data-sec="${x.id}">${esc(x.title)}</button>`).join('');
  const secs = s.sections.map((x) => {
    const body = x.soon ? `<div class="st-soon">${esc(t('Coming soon'))}</div>` : s.rows.filter((r) => r.section === x.id).map(renderRow).join('');
    return `<section class="st-sec" id="st-${x.id}" data-soon="${x.soon}"><h2>${esc(x.title)}</h2>${body}</section>`;
  }).join('');
  return `<div class="st"><nav class="st-nav" aria-label="${esc(t('Settings sections'))}">${nav}</nav>`
    + `<div class="st-main"><div class="st-top"><input class="sinp" id="st-q" type="search" placeholder="${esc(t('Find a setting: attachments, workday…'))}" value="${esc(query)}" autocomplete="off" aria-label="${esc(t('Find a setting'))}"><span class="sp"></span><button class="lnk" data-json>${esc(t('settings.json'))}</button></div>`
    + `<div class="mut sm">${esc(t('Changes apply immediately, there is no Save button. A blue bar on the left means the value differs from the default.'))}</div>`
    + `<div id="st-body">${secs}</div><div class="st-empty" id="st-none" hidden>${esc(t('Nothing found. Try "folder" or "hours".'))}</div></div></div>`;
}

/** Поиск: прячет строки без совпадения и разделы без строк. Разделы-заглушки при поиске скрываются. */
function applyFilter(): void {
  const q = query.trim().toLowerCase();
  let any = false;
  for (const sec of app.querySelectorAll<HTMLElement>('.st-sec')) {
    let n = 0;
    for (const r of sec.querySelectorAll<HTMLElement>('.set')) {
      const m = !q || (r.dataset.q ?? '').includes(q);
      r.hidden = !m;
      if (m) n++;
    }
    if (sec.dataset.soon === 'true') n = q ? 0 : 1;
    sec.hidden = n === 0;
    if (n) any = true;
  }
  const none = document.getElementById('st-none');
  if (none) none.hidden = any;
}

function draw(): void {
  if (!state) return;
  const scroller = document.scrollingElement;
  const y = scroller?.scrollTop ?? 0;
  const a = document.activeElement as HTMLInputElement | null;
  const focusId = a?.dataset?.f ?? (a?.id === 'st-q' ? 'q' : undefined);
  const sel = a && 'selectionStart' in a ? a.selectionStart : null;
  const typed = focusId && dirty.has(focusId) ? a?.value : undefined;
  app.className = '';
  app.innerHTML = renderState(state);
  applyFilter();
  if (scroller) scroller.scrollTop = y;
  if (focusId) {
    const el = (focusId === 'q' ? document.getElementById('st-q') : app.querySelector(`[data-f="${focusId}"]`)) as HTMLInputElement | null;
    el?.focus();
    if (el && typed !== undefined) el.value = typed;
    if (el && sel !== null && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(sel, sel); } catch { /* number/select */ } }
  }
}

function goTo(sec: SectionId): void {
  activeSec = sec;
  for (const b of app.querySelectorAll<HTMLElement>('.st-nav button')) b.classList.toggle('on', b.dataset.sec === sec);
  document.getElementById(`st-${sec}`)?.scrollIntoView({ block: 'start' });
}

app.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('button');
  if (!el) return;
  const row = el.closest<HTMLElement>('.set');
  const id = row?.dataset.id as SettingRow['id'] | undefined;
  if (el.dataset.sec) goTo(el.dataset.sec as SectionId);
  else if (el.dataset.json !== undefined) send({ type: 'openJson' });
  else if (el.dataset.pick !== undefined) send({ type: 'pickDir' });
  else if (el.dataset.reset !== undefined && id) send({ type: 'reset', id });
  else if (el.dataset.sw !== undefined && id) send({ type: 'set', id, value: el.getAttribute('aria-checked') !== 'true' });
});

app.addEventListener('change', (ev) => {
  const el = ev.target as HTMLInputElement | HTMLSelectElement;
  const id = el.closest<HTMLElement>('.set')?.dataset.id as SettingRow['id'] | undefined;
  if (!id) return;
  if (el.dataset.f) dirty.delete(el.dataset.f);
  if ('num' in el.dataset) send({ type: 'set', id, value: el.value.trim() === '' ? null : Number(el.value) });
  else if ('txt' in el.dataset) send({ type: 'set', id, value: el.value });
  else if (el.dataset.sort) {
    const field = (app.querySelector(`[data-f="${id}:field"]`) as HTMLSelectElement).value;
    const dir = (app.querySelector(`[data-f="${id}:dir"]`) as HTMLSelectElement).value;
    send({ type: 'set', id, value: { field, desc: dir !== 'asc' } });
  }
});

app.addEventListener('input', (ev) => {
  const el = ev.target as HTMLInputElement;
  if (('num' in el.dataset || 'txt' in el.dataset) && el.dataset.f) dirty.add(el.dataset.f);
  if (el.id !== 'st-q') return;
  query = el.value;
  vscode.setState({ q: query });
  applyFilter();
});

window.addEventListener('message', (ev: MessageEvent<HostToSettings>) => {
  const m = ev.data;
  if (m?.type === 'state') {
    state = m.state;
    draw();
  } else if (m?.type === 'scroll') {
    goTo(m.section);
  }
});

send({ type: 'ready' });
