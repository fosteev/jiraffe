// Разметка карточки задачи — чистые функции «данные → HTML-строка» (без DOM), тестируются в vitest.
// Inline-стили не используем (CSP): цвета и ширины проставляет issue.ts через CSSOM по data-атрибутам.
import { formatDuration } from '../src/duration';
import { locale, t, tn } from '../src/l10n';
import type { WorkAttribute } from '../src/jira/tempo';
import type { UserRef, Worklog } from '../src/jira/types';
import { ISSUE_TABS, type AttachmentView, type IssueCard, type IssueTab, type LogFormView } from '../src/panels/protocol';

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const tabLabel = (tab: IssueTab): string => ({ desc: t('Description'), att: t('Attachments'), com: t('Comments'), hist: t('History'), wl: t('Work Log') })[tab];
// Геттеры: подписи переводятся при обращении, а не при загрузке модуля (до setL10n).
export const STATUS_LABEL = {
  get new(): string { return t('To Do'); },
  get indeterminate(): string { return t('In Progress'); },
  get done(): string { return t('Done'); },
};

const st = 'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"';
export const IC = {
  server: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="4.5" rx="1" ${st}/><rect x="2.5" y="9" width="11" height="4.5" rx="1" ${st}/><circle cx="5" cy="4.75" r=".8" fill="currentColor"/><circle cx="5" cy="11.25" r=".8" fill="currentColor"/></svg>`,
  copy: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.2" ${st}/><path d="M3 10.5V3.8C3 3.3 3.3 3 3.8 3h6.7" ${st}/></svg>`,
  ext: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5l-6 6M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" ${st}/></svg>`,
  clock: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.8" ${st}/><path d="M8 4.6V8l2.4 1.5" ${st}/></svg>`,
  info: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" ${st}/><path d="M8 7.3v4M8 4.9v.1" ${st}/></svg>`,
  dl: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.6 7.2L8 10.6l3.4-3.4M3 13.5h10" ${st}/></svg>`,
  file: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.8h5l3.2 3.2v9.2H4zM9 1.8V5h3.2" ${st}/></svg>`,
  x: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" ${st}/></svg>`,
  tag: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.2V3.2c0-.4.3-.7.7-.7h5l5.3 5.3a.9.9 0 0 1 0 1.2l-4.2 4.2a.9.9 0 0 1-1.2 0z" ${st}/><circle cx="5.6" cy="5.6" r=".9" fill="currentColor"/></svg>`,
  pin: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5l4 4-2 .8-2 2 .3 3-1 1-2.6-2.6-3.6 3.6M6.2 5.8l1.2-1.2z" ${st}/></svg>`,
};

type TypeKind = 'bug' | 'story' | 'task' | 'epic' | 'subtask';
export function typeKind(name: string): TypeKind {
  const n = name.toLowerCase();
  if (/bug|ошиб|дефект|баг/.test(n)) return 'bug';
  if (/epic|эпик/.test(n)) return 'epic';
  if (/story|истор/.test(n)) return 'story';
  if (/sub|подзад/.test(n)) return 'subtask';
  return 'task';
}

export function typeIcon(name: string): string {
  const sq = (c: string, inner: string): string => `<svg class="ti" viewBox="0 0 16 16" aria-hidden="true"><rect class="${c}" width="16" height="16" rx="3"/>${inner}</svg>`;
  const k = typeKind(name);
  if (k === 'bug') return sq('r-red', '<circle cx="8" cy="8" r="3.2" fill="#fff"/>');
  if (k === 'story') return sq('r-green', '<path d="M5 3.5h6v9l-3-2.2-3 2.2z" fill="#fff"/>');
  if (k === 'epic') return sq('r-purple', '<path d="M9.2 2.5L4.6 9h3.1l-1 4.5L11.4 7H8.3z" fill="#fff"/>');
  return sq('r-blue', '<path d="M4.5 8.2l2.3 2.3 4.7-5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>');
}

export function priorityIcon(name: string | undefined): string {
  if (!name) return '';
  const n = name.toLowerCase();
  const pi = (c: string, d: string): string => `<svg class="pi" viewBox="0 0 16 16" aria-hidden="true"><path class="${c}" d="${d}"/></svg>`;
  if (/blocker|highest|наивысш|блокер|критич|critical/.test(n)) return pi('st-red', 'M3.5 8.5L8 5l4.5 3.5M3.5 12.5L8 9l4.5 3.5');
  if (/high|major|высок|серьёз|серьез|основн/.test(n)) return pi('st-red', 'M3.5 10.5L8 6l4.5 4.5');
  if (/lowest|low|minor|trivial|низк|незнач|минор/.test(n)) return pi('st-blue', 'M3.5 5.5L8 10l4.5-4.5');
  return pi('st-orange', 'M3.5 6h9M3.5 10h9');
}

const initials = (name: string): string => {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? '?') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
};

/** Аватар-инициалы; цвет по хэшу id ставится в issue.ts (`data-bg`). Картинки аватаров не грузим: CSP не пускает чужие хосты. */
export function avatar(u: UserRef | undefined, size: 18 | 22 | 28): string {
  if (!u) return `<span class="av s${size}" data-bg="?" title="—">?</span>`;
  return `<span class="av s${size}" data-bg="${esc(u.id)}" title="${esc(u.name)}">${esc(initials(u.name))}</span>`;
}
export const person = (u: UserRef | undefined): string => (u ? `<span class="who-c">${avatar(u, 18)}${esc(u.name)}</span>` : '<span class="mut">—</span>');

export function fmtDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(locale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
}
/** `due` приходит как `YYYY-MM-DD` — без сдвига часового пояса. */
export function fmtDue(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' }) : d;
}
const dur = (sec: number): string => (sec > 0 ? formatDuration(sec) : t('{0}m', 0));
const dash = '<span class="mut">—</span>';
const clip = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export function renderTabs(c: IssueCard, tab: IssueTab): string {
  const counts: Record<IssueTab, number | undefined> = { desc: undefined, att: c.attachments.length, com: c.issue.comments.length, hist: c.issue.history.length + 1, wl: c.worklogs.length };
  return `<div class="subtabs" role="tablist">${ISSUE_TABS.map((t) =>
    `<button class="${t === tab ? 'on' : ''}" role="tab" aria-selected="${t === tab}" data-act="tab" data-tab="${t}">${tabLabel(t)}${counts[t] != null ? `<span class="cnt">${counts[t]}</span>` : ''}</button>`,
  ).join('')}</div>`;
}

export function renderDescription(c: IssueCard): string {
  return `<div class="rich">${c.issue.descriptionHtml || `<p class="mut">${t('No description.')}</p>`}</div>`;
}

/** Размер файла по-человечески: `512 Б`, `12 КБ`, `1,4 МБ`. */
export function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return t('{0} B', bytes);
  if (bytes < 1024 * 1024) return t('{0} KB', Math.round(bytes / 1024));
  return t('{0} MB', (bytes / 1024 / 1024).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
}

const fileExt = (name: string): string => {
  const m = /\.([^.\s]{1,8})$/.exec(name);
  return m ? `.${m[1].toLowerCase()}` : '';
};
const attInfo = (a: AttachmentView): string => [fmtSize(a.size), a.author?.name, a.created ? fmtDate(a.created) : ''].filter(Boolean).join(' · ');

/**
 * Вкладка «Вложения» (prototype: sub=='att'). Превью картинок — `span.img-ph[data-img="tID"]`: issue.ts просит их у хоста
 * и вставляет `data:`-картинку. Кнопки шлют id вложения; что качать и куда сохранять — решает хост.
 */
export function renderAttachments(c: IssueCard): string {
  const list = c.attachments;
  if (!list.length) return `<p class="mut">${t('No attachments.')}</p>`;
  const cards = list.map((a) => {
    const thumb = a.image
      ? `<button class="th" data-act="img" data-id="${esc(a.id)}" aria-label="${esc(t('Open {0}', a.filename))}"><span class="img-ph" data-img="t${esc(a.id)}">${t('loading…')}</span></button>`
      : `<div class="th file">${IC.file}<span>${esc(fileExt(a.filename) || t('file'))}</span></div>`;
    return `<div class="att">${thumb}<div class="inf"><span class="nm" title="${esc(a.filename)}">${esc(a.filename)}</span><span class="mut">${esc(attInfo(a))}</span></div>`
      + `<div class="ab">${a.text ? `<button class="btn sm" data-act="openAtt" data-id="${esc(a.id)}">${t('Open in Editor')}</button>` : ''}`
      + `<button class="btn sm" data-act="dl" data-id="${esc(a.id)}" aria-label="${esc(t('Download {0}', a.filename))}" title="${t('Download')}">${IC.dl}</button></div></div>`;
  }).join('');
  return `<div class="toolbar"><span class="mut sm">${esc(tn(list.length, '{0} file · images are downloaded by the extension with authorization and shown here|{0} files · images are downloaded by the extension with authorization and shown here'))}</span><span class="sp"></span>`
    + `<button class="btn sm" data-act="dlAll">${IC.dl} ${t('Download All')}</button></div><div class="att-grid">${cards}</div>`;
}

/**
 * Лайтбокс: вложение (`fID`, с кнопкой «Скачать») или картинка описания (`iN`, уже скачанная). Картинку вставляет issue.ts
 * по `data-img`, пока её нет — «загрузка…».
 */
export function renderLightbox(imgId: string, name: string, att?: AttachmentView): string {
  return `<div class="ov" data-act="ov-bg"><div class="lb-box" role="dialog" aria-label="${esc(name)}"><span class="img-ph" data-img="${esc(imgId)}">${t('loading…')}</span>`
    + `<div class="hrow"><span class="nm">${esc(name)}</span>${att ? `<span class="mut sm">${esc(attInfo(att))}</span>` : ''}<span class="sp"></span>`
    + `${att ? `<button class="btn sm" data-act="dl" data-id="${esc(att.id)}">${IC.dl} ${t('Download')}</button>` : ''}<button class="btn sm" data-act="ov-x">${t('Close')}</button></div></div></div>`;
}

export function renderComments(c: IssueCard): string {
  const list = c.issue.comments.length
    ? c.issue.comments.map((m) => `<div class="cm">${avatar(m.author, 28)}<div><div class="who"><b>${esc(m.author?.name ?? '—')}</b><span class="mut sm">${esc(fmtDateTime(m.created))}</span></div><div class="tx rich">${m.bodyHtml}</div></div></div>`).join('')
    : `<p class="mut">${t('No comments.')}</p>`;
  return `${list}<div class="ro-note">${t('Comments are read-only in the MVP. Replying from VS Code is coming in the next version.')}</div>`;
}

export function renderHistory(c: IssueCard): string {
  const rows = c.issue.history.map((h) => `<div class="hi">${avatar(h.author, 28)}<div><div class="who"><b>${esc(h.author?.name ?? '—')}</b> <span class="mut sm">${esc(fmtDateTime(h.created))}</span></div>${h.items.map((i) =>
    `<div class="chg"><span class="f">${esc(i.field)}</span>${i.from !== null ? `<span class="val old">${esc(clip(i.from))}</span><span class="arr">→</span>` : ''}<span class="val">${i.to !== null ? esc(clip(i.to)) : `<span class="mut">${t('(empty)')}</span>`}</span></div>`).join('')}</div></div>`);
  // Создание задачи в changelog Jira не пишет — добавляем сами, как в прототипе.
  rows.push(`<div class="hi">${avatar(c.issue.reporter, 28)}<div><div class="who"><b>${esc(c.issue.reporter?.name ?? '—')}</b> <span class="mut sm">${esc(fmtDateTime(c.issue.created))}</span></div><div class="chg mut">${t('created the issue')}</div></div></div>`);
  return rows.join('');
}

/** Колонки атрибутов Tempo: описанные на инстансе + ключи, встреченные в ворклогах (если описания не загрузились). */
export function attrColumns(c: IssueCard): WorkAttribute[] {
  if (!c.tempo) return [];
  const cols = [...(c.workAttributes ?? [])];
  const known = new Set(cols.map((a) => a.key));
  for (const w of c.worklogs) {
    for (const k of Object.keys(w.attributes ?? {})) {
      if (!known.has(k)) {
        known.add(k);
        cols.push({ key: k, name: k, type: '', kind: 'text', required: false });
      }
    }
  }
  return cols;
}

const formatNumber = (n: number): string => n.toLocaleString(locale(), { maximumFractionDigits: 2 });

/** Значение атрибута для таблицы: список — название значения, флажок — «да», число — с разрядами. */
export function attrValue(a: WorkAttribute, v: string | undefined): string {
  if (v === undefined || v === '') return dash;
  if (a.kind === 'list') return esc(a.values?.find((x) => x.value === v)?.name ?? v);
  if (a.kind === 'checkbox') return v === 'true' ? t('yes') : t('no');
  if (a.kind === 'number' && Number.isFinite(Number(v))) return esc(formatNumber(Number(v)));
  return esc(v);
}

const attrSum = (a: WorkAttribute, logs: readonly Worklog[]): string => {
  if (a.kind !== 'number') return '';
  const vals = logs.map((l) => Number(l.attributes?.[a.key])).filter((n) => Number.isFinite(n));
  return vals.length ? esc(formatNumber(vals.reduce((s, n) => s + n, 0))) : '';
};

export function renderWorklog(c: IssueCard): string {
  const logs = [...c.worklogs].sort((a, b) => Date.parse(b.started) - Date.parse(a.started));
  const total = logs.reduce((s, l) => s + l.timeSpentSec, 0);
  const cols = attrColumns(c);
  const src = c.tempo
    ? `${IC.clock} Tempo Timesheets${cols.length ? ` · ${t('attributes {0}', cols.map((a) => t('"{0}"', esc(a.name))).join(', '))}` : ''}`
    : `${IC.info} ${t('No Tempo on {0} — using the standard Jira work log', esc(c.instanceName))}`;
  const num = (a: WorkAttribute): string => (a.kind === 'number' ? ' class="num"' : '');
  const table = logs.length
    ? `<div class="tw-wrap"><table class="t"><thead><tr><th>${t('Who')}</th><th>${t('Date')}</th><th class="num">${t('Time')}</th><th>${t('Comment')}</th>${cols.map((a) => `<th${num(a)}>${esc(a.name)}</th>`).join('')}</tr></thead><tbody>${logs.map((l) =>
      `<tr><td>${person(l.author)}</td><td class="left num">${esc(fmtDate(l.started))}</td><td class="num">${esc(dur(l.timeSpentSec))}</td><td>${esc(l.comment)}</td>${cols.map((a) => `<td${num(a)}>${attrValue(a, l.attributes?.[a.key])}</td>`).join('')}</tr>`).join('')}</tbody><tfoot><tr><td>${t('Total')}</td><td></td><td class="num">${esc(dur(total))}</td><td></td>${cols.map((a) => `<td${num(a)}>${attrSum(a, logs)}</td>`).join('')}</tr></tfoot></table></div>`
    : c.worklogError ? `<p class="mut">${esc(t('Failed to load the work log: {0}', c.worklogError))}</p>` : `<p class="mut">${t('No entries yet.')}</p>`;
  return `<div class="toolbar"><span class="src">${src}</span><span class="sp"></span><button class="btn sm pri" data-act="logWork">${IC.clock} ${t('Log Work')}</button></div>${table}`;
}

/** Поле атрибута Tempo в диалоге. AI Tokens рисуется отдельно (`#lg-tok`). */
function attrField(a: WorkAttribute): string {
  const id = `lg-a-${a.key.replace(/[^\w-]/g, '_')}`;
  const label = `${esc(a.name)}${a.required ? ' *' : ''}`;
  const data = `data-attr="${esc(a.key)}"`;
  if (a.kind === 'list') {
    return `<div class="fld"><label for="${esc(id)}">${label}</label><select id="${esc(id)}" ${data}>${a.required ? `<option value="" disabled selected>${t('— select —')}</option>` : '<option value="">—</option>'}${(a.values ?? []).map((v) => `<option value="${esc(v.value)}">${esc(v.name)}</option>`).join('')}</select></div>`;
  }
  if (a.kind === 'checkbox') {
    return `<div class="fld"><span class="lb">&nbsp;</span><label class="chk"><input type="checkbox" id="${esc(id)}" ${data} value="true"> ${label}</label></div>`;
  }
  return `<div class="fld"><label for="${esc(id)}">${label}</label><input id="${esc(id)}" ${data}${a.kind === 'number' ? ' inputmode="decimal"' : ''} maxlength="255" autocomplete="off"></div>`;
}

/** Диалог «Залогать время» (prototype: `logHtml`). Поля атрибутов — по ответу `work-attribute` инстанса. */
export function renderLogDialog(key: string, f: LogFormView): string {
  const ai = f.attributes.find((a) => a.key === f.aiTokensAttr);
  const tok = `<div class="fld"><label for="lg-tok">${esc(ai?.name ?? 'AI Tokens')}${ai?.required ? ' *' : ''}</label><input id="lg-tok" inputmode="numeric" placeholder="${t('e.g. 120000')}" maxlength="32" autocomplete="off"></div>`;
  const rest = f.attributes.filter((a) => a.key !== f.aiTokensAttr);
  const tempo = f.tempo
    ? `<fieldset class="tempo"><legend>${t('Tempo · work attributes')}</legend><div class="g2">${rest.map(attrField).join('')}${tok}</div>${f.aiTokensAttr ? '' : `<div class="note">${t('The AI Tokens attribute is missing on the instance — the value will be appended to the comment.')}</div>`}${f.unsupportedRequired.length ? `<div class="note">${t('Required attributes {0} cannot be filled in by the form — Tempo may reject the entry.', f.unsupportedRequired.map((n) => t('"{0}"', esc(n))).join(', '))}</div>` : ''}</fieldset>`
    : `${tok}<div class="note">${t('No Tempo on {0} — the entry goes to the issue’s standard work log, AI Tokens are appended to the comment.', esc(f.instanceName))}</div>`;
  return `<div class="ov" data-act="dlg-bg"><div class="dlg" role="dialog" aria-modal="true" aria-label="${t('Log Work')}">
    <div class="dlg-h">${IC.clock} ${t('Log Work')}<button class="ib" data-act="dlg-x" aria-label="${t('Close')}">${IC.x}</button></div>
    <form class="dlg-b" id="lg-form" novalidate>
      <div class="fld"><span class="lb">${t('Issue')}</span><div class="ro"><span class="k">${esc(key)}</span><span class="ell">${esc(f.summary)}</span></div></div>
      <div class="g2"><div class="fld"><label for="lg-dur">${t('Time spent')}</label><input id="lg-dur" placeholder="${t('1h 30m')}" maxlength="64" autocomplete="off"><small>${t('1h 30m · 1h30m · 90m · 1.5h')}</small></div>
      <div class="fld"><label for="lg-date">${t('Date')}</label><input type="date" id="lg-date" value="${esc(f.today)}" min="2000-01-01" max="${esc(f.today)}"></div></div>
      <div class="fld"><label for="lg-c">${t('Comment')}</label><textarea id="lg-c" rows="3" placeholder="${t('What was done')}" maxlength="30000"></textarea></div>
      ${tempo}
      <div class="err" id="lg-err" role="alert" hidden></div>
      <button type="submit" hidden></button>
    </form>
    <div class="dlg-f"><button class="btn" data-act="dlg-x">${t('Cancel')}</button><button class="btn pri" data-act="log-save">${t('Log')}</button></div>
  </div></div>`;
}

export function renderMeta(c: IssueCard): string {
  const i = c.issue;
  const spent = i.timetracking.spentSec ?? c.worklogs.reduce((s, l) => s + l.timeSpentSec, 0);
  const orig = i.timetracking.originalSec;
  const rem = i.timetracking.remainingSec ?? (orig ? Math.max(0, orig - spent) : undefined);
  const over = !!orig && spent > orig;
  const row = (l: string, v: string): string => `<div class="mr"><span class="l">${l}</span><span class="v">${v}</span></div>`;
  const watchers = i.watchers.length ? `<span class="stack">${i.watchers.slice(0, 6).map((w) => avatar(w, 22)).join('')}</span><span class="mut">${i.watchers.length}</span>` : dash;
  const epic = i.epic ? `<button class="ln" data-act="epic" data-key="${esc(i.epic.key)}" title="${esc(i.epic.key)}">${esc(i.epic.summary ?? i.epic.key)}</button>` : dash;
  const rel = i.fixVersions.length ? i.fixVersions.map((v) => `<button class="ln" data-act="release" data-id="${esc(v.id)}">${esc(v.name)}</button>`).join(', ') : dash;
  return `<aside class="meta">
    <div class="mg"><h5>${t('People')}</h5>${row(t('Assignee'), person(i.assignee))}${row(t('Reporter'), person(i.reporter))}${row(t('Watchers'), watchers)}</div>
    <div class="mg"><h5>${t('Details')}</h5>${row(t('Epic'), epic)}${row(t('Release'), rel)}${row(t('Labels'), i.labels.length ? i.labels.map((l) => `<span class="tag">${esc(l)}</span>`).join('') : dash)}${row(t('Components'), i.components.length ? esc(i.components.join(', ')) : dash)}</div>
    <div class="mg"><h5>${t('Time')}</h5>${row(t('Estimate'), orig ? esc(dur(orig)) : dash)}${row(t('Logged'), `${esc(dur(spent))}${over ? ` <span class="under">· ${t('over estimate')}</span>` : ''}`)}${row(t('Remaining'), rem !== undefined ? esc(dur(rem)) : dash)}${orig ? `<div class="bar"><i class="${over ? 'b-over' : 'b-acc'}" data-w="${Math.min(100, Math.round((spent / orig) * 100))}"></i></div>` : ''}</div>
    <div class="mg"><h5>${t('Dates')}</h5>${row(t('Created'), esc(fmtDateTime(i.created)))}${row(t('Updated'), esc(fmtDateTime(i.updated)))}${row(t('Due'), i.due ? esc(fmtDue(i.due)) : dash)}</div>
  </aside>`;
}

export function renderCard(c: IssueCard, tab: IssueTab): string {
  const i = c.issue;
  const project = i.key.split('-')[0];
  const body = tab === 'att' ? renderAttachments(c) : tab === 'com' ? renderComments(c) : tab === 'hist' ? renderHistory(c) : tab === 'wl' ? renderWorklog(c) : renderDescription(c);
  return `<div class="iv">
    <div class="iv-head">
      <div class="crumbs">${IC.server} ${esc(c.instanceName)}<span>›</span>${esc(project)}${i.epic ? `<span>›</span><button class="ln" data-act="epic" data-key="${esc(i.epic.key)}">${esc(i.epic.key)}</button>` : ''}<span>›</span>${typeIcon(i.type)}<span class="k">${esc(i.key)}</span></div>
      <h1>${esc(i.summary)}</h1>
      <div class="hrow"><button class="pill pill-btn s-${i.statusCategory}" data-act="transition" title="${t('Change Status')}">${esc(i.status || STATUS_LABEL[i.statusCategory])} ▾</button>${i.priority ? `<span class="prio">${priorityIcon(i.priority)}${esc(i.priority)}</span>` : ''}<span class="mut sm">${esc(i.type)}</span><span class="sp"></span>
        <button class="btn" data-act="copyKey">${IC.copy} ${t('Key')}</button>
        <button class="btn" data-act="openInBrowser">${IC.ext} ${t('Open in Jira')}</button>
        <button class="btn" data-act="pin"${c.pinned ? ' disabled' : ''}>${IC.pin} ${c.pinned ? t('Pinned') : t('Pin')}</button>
        <button class="btn pri" data-act="logWork">${IC.clock} ${t('Log Work')}</button></div>
    </div>
    <div class="main">${renderTabs(c, tab)}${body}</div>
    ${renderMeta(c)}
  </div>`;
}
