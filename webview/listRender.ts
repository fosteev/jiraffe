// Вкладки эпика и релиза — чистые функции «данные → HTML-строка» (prototype: vEpic, vRel, progressBlock, issueTable, segBar).
// Inline-стилей нет (CSP): ширины сегментов и цвета аватаров ставит list.ts через CSSOM по data-w / data-bg.
import type { Progress } from '../src/jira/types';
import { t } from '../src/l10n';
import { percent } from '../src/jira/epics';
import type { EpicPage, ListPage, ListRow, ReleasePage } from '../src/panels/protocol';
import { esc, fmtDue, IC, person, priorityIcon, STATUS_LABEL, typeIcon } from './render';

const dash = '<span class="mut">—</span>';

/** Сегментная полоса прогресса: готово / в работе / не начато (остаток — фон дорожки). */
export function segBar(p: Progress): string {
  const w = (n: number): string => (p.total ? ((n / p.total) * 100).toFixed(1) : '0');
  return `<div class="bar seg" role="img" aria-label="${esc(t('Done {0} of {1}', p.done, p.total))}"><i class="b-done" data-w="${w(p.done)}"></i><i class="b-prog" data-w="${w(p.prog)}"></i></div>`;
}

export function progressBlock(p: Progress): string {
  return `<div class="sum"><div><b>${esc(t('{0} of {1}', p.done, p.total))}</b><span>${esc(t('done · {0}%', percent(p)))}</span></div><div><b>${p.prog}</b><span>${t('in progress')}</span></div><div><b>${p.todo}</b><span>${t('not started')}</span></div></div>`
    + `${segBar(p)}<div class="legend"><span><i class="b-done"></i>${esc(t('Done {0}', p.done))}</span><span><i class="b-prog"></i>${esc(t('In Progress {0}', p.prog))}</span><span><i class="b-todo"></i>${esc(t('To Do {0}', p.todo))}</span></div>`;
}

/** Таблица задач; строка открывает карточку (`data-act="open"`). `extraTitle` — заголовок последней колонки (Релиз / Эпик). */
export function issueTable(rows: readonly ListRow[], extraTitle: string): string {
  const body = rows.map((r) => `<tr class="click" data-act="open" data-key="${esc(r.key)}" tabindex="0"><td>${typeIcon(r.type)}</td><td class="k nw">${esc(r.key)}</td><td>${esc(r.summary)}</td>`
    + `<td><span class="pill s-${r.statusCategory}" title="${esc(STATUS_LABEL[r.statusCategory])}">${esc(r.status || STATUS_LABEL[r.statusCategory])}</span></td>`
    + `<td>${r.priority ? `<span class="prio" title="${esc(r.priority)}">${priorityIcon(r.priority)}</span>` : dash}</td><td>${person(r.assignee)}</td>`
    + `<td class="mut nw">${r.extra ? esc(r.extra) : '—'}</td></tr>`).join('');
  return `<div class="tw-wrap"><table class="t"><thead><tr><th></th><th>${t('Key')}</th><th>${t('Issue')}</th><th>${t('Status')}</th><th>${t('Priority')}</th><th>${t('Assignee')}</th><th>${esc(extraTitle)}</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

const truncNote = (p: ListPage): string => (p.truncated ? `<p class="foot">${esc(t('Showing the first {0} issues — Jira has more; progress is computed from the shown ones.', p.rows.length))}</p>` : '');

const crumbs = (p: ListPage, section: string): string =>
  `<div class="crumbs">${IC.server} ${esc(p.instanceName)}${p.project ? `<span>›</span>${esc(p.project)}` : ''}<span>›</span>${section}</div>`;

export function renderEpicPage(p: EpicPage): string {
  const table = p.rows.length ? issueTable(p.rows, t('Release')) : `<p class="mut">${p.link ? t('This epic has no issues yet.') : t('The Epic Link field was not found on the instance — epic issues are unavailable. Refresh the instance capabilities or set the field in settings.')}</p>`;
  const foot = p.kind === 'cloud'
    ? t('Jira Cloud: epic issues are looked up by <code>parent</code>.')
    : t('Server/DC: epic issues are looked up by the Epic Link field{0}.', p.link ? ` (<code>${esc(p.link)}</code>)` : '');
  return `<div class="wide-pad">${crumbs(p, t('Epics'))}
  <h1 class="ico-h">${typeIcon('Epic')}${esc(p.summary)}</h1>
  <div class="hrow mb"><span class="k">${esc(p.key)}</span><span class="pill s-${p.statusCategory}" title="${esc(STATUS_LABEL[p.statusCategory])}">${esc(p.status || STATUS_LABEL[p.statusCategory])}</span><span class="sp"></span>
    <button class="btn" data-act="refresh">${t('Refresh')}</button><button class="btn" data-act="browser">${IC.ext} ${t('Open in Jira')}</button></div>
  ${p.rows.length ? progressBlock(p.progress) : ''}${table}${truncNote(p)}<p class="foot">${foot}</p></div>`;
}

export function renderReleasePage(p: ReleasePage): string {
  const left = p.daysLeft !== undefined ? ` · <b>${p.daysLeft >= 0 ? t('{0} d left', p.daysLeft) : t('overdue by {0} d', -p.daysLeft)}</b>` : '';
  const dates = `${p.startDate ? esc(t('Start {0}', fmtDue(p.startDate))) : t('No start date')} · ${p.releaseDate ? esc(p.released ? t('Released {0}', fmtDue(p.releaseDate)) : t('Release {0}', fmtDue(p.releaseDate))) : t('no release date')}${left}`;
  return `<div class="wide-pad">${crumbs(p, t('Releases'))}
  <h1 class="ico-h"><span class="tag-ic">${IC.tag}</span>${esc(p.name)}</h1>
  <div class="hrow mb">${p.released ? `<span class="pill s-done">${t('Released')}</span>` : `<span class="pill s-indeterminate">${t('Unreleased')}</span>`}
    <span class="sm">${dates}</span>${p.description ? `<span class="mut sm">${esc(p.description)}</span>` : ''}<span class="sp"></span>
    <button class="btn" data-act="refresh">${t('Refresh')}</button><button class="btn" data-act="browser">${IC.ext} ${t('Open in Jira')}</button></div>
  ${p.rows.length ? `${progressBlock(p.progress)}${issueTable(p.rows, t('Epic'))}${truncNote(p)}` : `<p class="mut">${t('This version has no issues yet.')}</p>`}</div>`;
}

export const renderListPage = (p: ListPage): string => (p.type === 'epic' ? renderEpicPage(p) : renderReleasePage(p));
