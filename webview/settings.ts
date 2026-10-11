// Webview вкладки «Настройки Jiraffe»: рисует SettingsState от хоста и шлёт намерения (set/reset/pickDir/openJson).
// Источник правды — хост: после каждой правки он присылает новое состояние. Поиск — только здесь.
import './l10nInit';
import { t } from '../src/l10n';
import type { HostToSettings, InstanceAction, SettingsToHost } from '../src/panels/protocol';
import type { Control, EpicLink, InstanceCard, Level, SectionId, SettingRow, SettingsState, SortControl } from '../src/panels/settingsModel';
import { esc, fmtDateTime, IC } from './render';

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

// ----- Подключения -----

function epicText(e: EpicLink): string {
  switch (e.kind) {
    case 'field': return `<code>${esc(e.id)}</code><span class="mut sm">${esc(t('found automatically'))}</span>`;
    case 'parent': return `<code>parent</code><span class="mut sm">${esc(t('Cloud uses the parent field'))}</span>`;
    case 'none': return `<span class="mut">${esc(t('not found'))}</span>`;
    case 'unknown': return `<span class="mut">${esc(t('Not checked yet'))}</span>`;
  }
}

function statusBadge(c: InstanceCard): string {
  if (c.state === 'ok') return `<span class="ok">${IC.ok}${esc(t('connected'))}</span>`;
  if (c.state === 'error') return `<span class="bad">${IC.warn}${esc(t('no access'))}</span>`;
  return `<span class="mut sm">${esc(t('checking…'))}</span>`;
}

function instCard(c: InstanceCard, pickMode: boolean, canScope: boolean): string {
  const f = (a: string): string => `data-ia="${a}" data-f="${esc(c.id)}:${a}"`;
  const alertText = c.state === 'error' ? c.error : c.tokenError ? `${t('The new token was not saved; the old one is kept.')} ${c.tokenError}` : undefined;
  const alert = alertText
    ? `<div class="ic-alert">${IC.warn}<span>${esc(alertText)}</span><span class="sp"></span><button class="btn sm pri" data-ia="setToken" data-f="${esc(c.id)}:alertToken">${IC.key}${esc(c.state === 'error' ? t('Update token') : t('Try another token'))}</button></div>`
    : '';
  const journal = c.journal === 'tempo' ? `<span class="ok">${IC.ok}Tempo</span>`
    : c.journal === 'jira' ? `${esc(t('Jira work log'))} <span class="mut sm">— ${esc(t('Tempo not found'))}</span>`
    : `<span class="mut">${esc(t('Not checked yet'))}</span>`;
  const checked = c.checkedAt ? `${t('capabilities checked {0}', fmtDateTime(c.checkedAt))}` : t('capabilities not checked yet');
  const account = c.account ? esc(c.account) : c.state === 'checking' ? `<span class="mut">…</span>` : '<span class="mut">—</span>';
  return `<div class="ic${c.state === 'error' ? ' err' : ''}${pickMode && !c.inScope ? ' off' : ''}" data-inst="${esc(c.id)}">`
    + `<div class="ic-h">${IC.server}<span class="nm">${esc(c.name)}</span>`
    + `<button class="ib" ${f('rename')} title="${esc(t('Rename'))}" aria-label="${esc(t('Rename'))}">${IC.pencil}</button>`
    + `<span class="host">${esc(c.host)}</span><span class="tag">${c.kind === 'cloud' ? 'Cloud' : 'DC'}</span><span class="sp"></span>`
    + (pickMode ? `<label class="cbx"><input type="checkbox" data-scope-id="${esc(c.id)}" data-f="scope:${esc(c.id)}"${c.inScope ? ' checked' : ''}${canScope ? '' : ' disabled'}> ${esc(t('in this workspace'))}</label>` : '')
    + statusBadge(c) + '</div>' + alert
    + '<div class="ic-b">'
    + `<span class="l">${esc(t('Account'))}</span><span class="v">${account}</span>`
    + `<span class="l">${esc(t('Token'))}</span><span class="v"><span class="mut sm">${esc(c.tokenKind)} · ${esc(t('Stored in VS Code SecretStorage'))}</span></span>`
    + `<span class="l">${esc(t('Server'))}</span><span class="v">${c.serverVersion ? esc(c.serverVersion) : '<span class="mut">—</span>'}<span class="mut sm">· ${esc(checked)}</span></span>`
    + `<span class="l">${esc(t('Work log'))}</span><span class="v">${journal}</span>`
    + `<span class="l">${esc(t('Epic Link field'))}</span><span class="v">${epicText(c.epic)}</span>`
    + '</div>'
    + `<div class="ic-f"><button class="btn sm" ${f('check')}${c.state === 'checking' ? ' disabled' : ''}>${IC.ok}${esc(t('Check connection'))}</button>`
    + `<button class="btn sm" ${f('refreshCaps')}>${IC.refresh}${esc(t('Refresh capabilities'))}</button>`
    + (c.state === 'error' ? '' : `<button class="btn sm" ${f('setToken')}>${IC.key}${esc(t('Change token'))}</button>`)
    + `<span class="sp"></span><button class="btn sm dng" ${f('remove')}>${IC.trash}${esc(t('Disconnect'))}</button></div></div>`;
}

function renderConnections(s: SettingsState): string {
  const c = s.connections;
  const pick = c.mode === 'some';
  const dis = c.canScope ? '' : ' disabled';
  const title = t('Instances of this workspace');
  const desc = t('Which Jira instances to show and poll in this folder. Handy when one window has a work project and another a personal one.');
  const hay = `${t('Connections')} ${title} ${desc} jiraffe.instances`.toLowerCase();
  const ids = c.cards.filter((x) => x.inScope).map((x) => x.id).join(', ');
  const radios = `<div class="radios"><label><input type="radio" name="st-scope" value="all" data-scope-mode data-f="scope:all"${pick ? '' : ' checked'}${dis}> ${esc(t('All connected'))}</label>`
    + `<label><input type="radio" name="st-scope" value="some" data-scope-mode data-f="scope:some"${pick ? ' checked' : ''}${dis}> ${esc(t('Only the checked ones below'))}</label></div>`;
  const hint = !c.canScope ? `<div class="hint">${IC.info} ${esc(t('Open a folder or workspace: the set is stored in its settings.'))}</div>`
    : pick ? `<div class="hint">${IC.info} ${esc(t('Visible in this workspace:'))} <code>${esc(ids)}</code></div>` : '';
  const row = `<div class="set${pick ? ' mod' : ''}" data-q="${esc(hay)}"><div class="set-t"><span><span class="cat">${esc(t('Connections'))}: </span>${esc(title)}</span>`
    + `<span class="where" title="${esc(levelTitle('workspace'))}">${esc(levelText('workspace'))}</span><code class="sm mut key">jiraffe.instances</code></div>`
    + `<div class="set-d">${esc(desc)}</div><div class="set-c">${radios}</div>${hint}</div>`;
  const empty = c.cards.length ? '' : `<div class="st-soon">${esc(t('No instances yet. Connect Jira to get started.'))}</div>`;
  return row + c.cards.map((x) => instCard(x, pick, c.canScope)).join('') + empty;
}

function renderTimeTargets(s: SettingsState): string {
  const tt = s.timeTargets;
  const hay = `${tt.title} ${tt.desc} ${tt.rows.map((r) => `${r.name} ${r.label} ${r.note}`).join(' ')}`.toLowerCase();
  const body = tt.rows.length
    ? `<table class="t tt"><tbody>${tt.rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.label)}</td><td class="mut sm">${esc(r.note)}</td></tr>`).join('')}</tbody></table>`
    : `<span class="mut sm">${esc(t('No instances in this workspace.'))}</span>`;
  return `<div class="set" data-q="${esc(hay)}"><div class="set-t"><span><span class="cat">${esc(t('Time'))}: </span>${esc(tt.title)}</span>`
    + `<span class="where" title="${esc(levelTitle('auto'))}">${esc(levelText('auto'))}</span></div>`
    + `<div class="set-d">${esc(tt.desc)}</div><div class="set-c tt-wrap">${body}</div></div>`;
}

function renderState(s: SettingsState): string {
  const nav = s.sections.map((x) => `<button class="${x.id === activeSec ? 'on' : ''}" data-sec="${x.id}">${esc(x.title)}`
    + (x.badge ? `<span class="badge" title="${esc(t('There are connection problems'))}">${x.badge}</span>` : '') + '</button>').join('');
  const secs = s.sections.map((x) => {
    let body = x.soon ? `<div class="st-soon">${esc(t('Coming soon'))}</div>` : s.rows.filter((r) => r.section === x.id).map(renderRow).join('');
    if (x.id === 'conn') body = renderConnections(s);
    if (x.id === 'time') body += renderTimeTargets(s);
    const act = x.id === 'conn' ? `<span class="sp"></span><button class="btn sm pri" data-add data-f="add">${IC.plus}${esc(t('Connect Jira'))}</button>` : '';
    return `<section class="st-sec" id="st-${x.id}" data-soon="${x.soon}"><h2>${esc(x.title)}${act}</h2>${x.sub ? `<p class="sub">${esc(x.sub)}</p>` : ''}${body}</section>`;
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
    for (const c of sec.querySelectorAll<HTMLElement>('.ic')) {
      const m = !q || (c.textContent ?? '').toLowerCase().includes(q);
      c.hidden = !m;
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
    const el = (focusId === 'q' ? document.getElementById('st-q') : app.querySelector(`[data-f="${CSS.escape(focusId)}"]`)) as HTMLInputElement | null;
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
  if (el.dataset.ia) {
    const id = el.closest<HTMLElement>('.ic')?.dataset.inst;
    if (id) send({ type: 'instance', action: el.dataset.ia as InstanceAction, id });
    return;
  }
  if (el.dataset.add !== undefined) { send({ type: 'addInstance' }); return; }
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
  if ('scopeMode' in el.dataset) { send({ type: 'scopeMode', mode: el.value === 'some' ? 'some' : 'all' }); return; }
  if (el.dataset.scopeId) { send({ type: 'scopeToggle', id: el.dataset.scopeId, on: (el as HTMLInputElement).checked }); return; }
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
