// Разметка карточки задачи — чистые функции «данные → HTML-строка» (без DOM), тестируются в vitest.
// Inline-стили не используем (CSP): цвета и ширины проставляет issue.ts через CSSOM по data-атрибутам.
import { formatDuration } from '../src/duration';
import type { UserRef } from '../src/jira/types';
import { ISSUE_TABS, type IssueCard, type IssueTab } from '../src/panels/protocol';

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TAB_LABEL: Record<IssueTab, string> = { desc: 'Описание', com: 'Комментарии', hist: 'История', wl: 'Журнал работ' };
const STATUS_LABEL = { new: 'Открыта', indeterminate: 'В работе', done: 'Готово' } as const;

const st = 'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"';
const IC = {
  server: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="4.5" rx="1" ${st}/><rect x="2.5" y="9" width="11" height="4.5" rx="1" ${st}/><circle cx="5" cy="4.75" r=".8" fill="currentColor"/><circle cx="5" cy="11.25" r=".8" fill="currentColor"/></svg>`,
  copy: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.2" ${st}/><path d="M3 10.5V3.8C3 3.3 3.3 3 3.8 3h6.7" ${st}/></svg>`,
  ext: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5l-6 6M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" ${st}/></svg>`,
  clock: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.8" ${st}/><path d="M8 4.6V8l2.4 1.5" ${st}/></svg>`,
  info: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" ${st}/><path d="M8 7.3v4M8 4.9v.1" ${st}/></svg>`,
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
const person = (u: UserRef | undefined): string => (u ? `<span class="who-c">${avatar(u, 18)}${esc(u.name)}</span>` : '<span class="mut">—</span>');

export function fmtDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}
/** `due` приходит как `YYYY-MM-DD` — без сдвига часового пояса. */
export function fmtDue(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) : d;
}
const dur = (sec: number): string => (sec > 0 ? formatDuration(sec) : '0м');
const dash = '<span class="mut">—</span>';
const clip = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export function renderTabs(c: IssueCard, tab: IssueTab): string {
  const counts: Record<IssueTab, number | undefined> = { desc: undefined, com: c.issue.comments.length, hist: c.issue.history.length + 1, wl: c.worklogs.length };
  return `<div class="subtabs" role="tablist">${ISSUE_TABS.map((t) =>
    `<button class="${t === tab ? 'on' : ''}" role="tab" aria-selected="${t === tab}" data-act="tab" data-tab="${t}">${TAB_LABEL[t]}${counts[t] != null ? `<span class="cnt">${counts[t]}</span>` : ''}</button>`,
  ).join('')}</div>`;
}

export function renderDescription(c: IssueCard): string {
  return `<div class="rich">${c.issue.descriptionHtml || '<p class="mut">Описание не заполнено.</p>'}</div>`;
}

export function renderComments(c: IssueCard): string {
  const list = c.issue.comments.length
    ? c.issue.comments.map((m) => `<div class="cm">${avatar(m.author, 28)}<div><div class="who"><b>${esc(m.author?.name ?? '—')}</b><span class="mut sm">${esc(fmtDateTime(m.created))}</span></div><div class="tx rich">${m.bodyHtml}</div></div></div>`).join('')
    : '<p class="mut">Комментариев нет.</p>';
  return `${list}<div class="ro-note">В MVP комментарии только читаются. Ответ из VS Code — в следующей версии.</div>`;
}

export function renderHistory(c: IssueCard): string {
  const rows = c.issue.history.map((h) => `<div class="hi">${avatar(h.author, 28)}<div><div class="who"><b>${esc(h.author?.name ?? '—')}</b> <span class="mut sm">${esc(fmtDateTime(h.created))}</span></div>${h.items.map((i) =>
    `<div class="chg"><span class="f">${esc(i.field)}</span>${i.from !== null ? `<span class="val old">${esc(clip(i.from))}</span><span class="arr">→</span>` : ''}<span class="val">${i.to !== null ? esc(clip(i.to)) : '<span class="mut">(пусто)</span>'}</span></div>`).join('')}</div></div>`);
  // Создание задачи в changelog Jira не пишет — добавляем сами, как в прототипе.
  rows.push(`<div class="hi">${avatar(c.issue.reporter, 28)}<div><div class="who"><b>${esc(c.issue.reporter?.name ?? '—')}</b> <span class="mut sm">${esc(fmtDateTime(c.issue.created))}</span></div><div class="chg mut">создал(а) задачу</div></div></div>`);
  return rows.join('');
}

export function renderWorklog(c: IssueCard): string {
  const logs = [...c.worklogs].sort((a, b) => Date.parse(b.started) - Date.parse(a.started));
  const total = logs.reduce((s, l) => s + l.timeSpentSec, 0);
  const src = c.tempo
    ? `${IC.clock} Tempo Timesheets · атрибуты («Тип работ», «AI Tokens») — в этапе 6`
    : `${IC.info} Tempo на ${esc(c.instanceName)} нет — стандартный журнал работ Jira`;
  const table = logs.length
    ? `<div class="tw-wrap"><table class="t"><thead><tr><th>Кто</th><th>Дата</th><th class="num">Время</th><th>Комментарий</th></tr></thead><tbody>${logs.map((l) =>
      `<tr><td>${person(l.author)}</td><td class="left num">${esc(fmtDate(l.started))}</td><td class="num">${esc(dur(l.timeSpentSec))}</td><td>${esc(l.comment)}</td></tr>`).join('')}</tbody><tfoot><tr><td>Итого</td><td></td><td class="num">${esc(dur(total))}</td><td></td></tr></tfoot></table></div>`
    : c.worklogError ? `<p class="mut">Журнал работ не загрузился: ${esc(c.worklogError)}</p>` : '<p class="mut">Записей пока нет.</p>';
  return `<div class="toolbar"><span class="src">${src}</span><span class="sp"></span><button class="btn sm pri" data-act="logWork">${IC.clock} Залогать время</button></div>${table}`;
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
    <div class="mg"><h5>Люди</h5>${row('Исполнитель', person(i.assignee))}${row('Автор', person(i.reporter))}${row('Наблюдатели', watchers)}</div>
    <div class="mg"><h5>Детали</h5>${row('Эпик', epic)}${row('Релиз', rel)}${row('Метки', i.labels.length ? i.labels.map((l) => `<span class="tag">${esc(l)}</span>`).join('') : dash)}${row('Компоненты', i.components.length ? esc(i.components.join(', ')) : dash)}</div>
    <div class="mg"><h5>Время</h5>${row('Оценка', orig ? esc(dur(orig)) : dash)}${row('Залогано', `${esc(dur(spent))}${over ? ' <span class="under">· сверх оценки</span>' : ''}`)}${row('Осталось', rem !== undefined ? esc(dur(rem)) : dash)}${orig ? `<div class="bar"><i class="${over ? 'b-over' : 'b-acc'}" data-w="${Math.min(100, Math.round((spent / orig) * 100))}"></i></div>` : ''}</div>
    <div class="mg"><h5>Даты</h5>${row('Создана', esc(fmtDateTime(i.created)))}${row('Обновлена', esc(fmtDateTime(i.updated)))}${row('Срок', i.due ? esc(fmtDue(i.due)) : dash)}</div>
  </aside>`;
}

export function renderCard(c: IssueCard, tab: IssueTab): string {
  const i = c.issue;
  const project = i.key.split('-')[0];
  const body = tab === 'com' ? renderComments(c) : tab === 'hist' ? renderHistory(c) : tab === 'wl' ? renderWorklog(c) : renderDescription(c);
  return `<div class="iv">
    <div class="iv-head">
      <div class="crumbs">${IC.server} ${esc(c.instanceName)}<span>›</span>${esc(project)}${i.epic ? `<span>›</span><button class="ln" data-act="epic" data-key="${esc(i.epic.key)}">${esc(i.epic.key)}</button>` : ''}<span>›</span>${typeIcon(i.type)}<span class="k">${esc(i.key)}</span></div>
      <h1>${esc(i.summary)}</h1>
      <div class="hrow"><span class="pill s-${i.statusCategory}" title="${esc(STATUS_LABEL[i.statusCategory])}">${esc(i.status || STATUS_LABEL[i.statusCategory])}</span>${i.priority ? `<span class="prio">${priorityIcon(i.priority)}${esc(i.priority)}</span>` : ''}<span class="mut sm">${esc(i.type)}</span><span class="sp"></span>
        <button class="btn" data-act="copyKey">${IC.copy} Ключ</button>
        <button class="btn" data-act="openInBrowser">${IC.ext} Открыть в Jira</button>
        <button class="btn" data-act="pin"${c.pinned ? ' disabled' : ''}>${IC.pin} ${c.pinned ? 'Закреплена' : 'Закрепить'}</button>
        <button class="btn pri" data-act="logWork">${IC.clock} Залогать время</button></div>
    </div>
    <div class="main">${renderTabs(c, tab)}${body}</div>
    ${renderMeta(c)}
  </div>`;
}
