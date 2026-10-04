// Вкладки эпика и релиза — чистые функции «данные → HTML-строка» (prototype: vEpic, vRel, progressBlock, issueTable, segBar).
// Inline-стилей нет (CSP): ширины сегментов и цвета аватаров ставит list.ts через CSSOM по data-w / data-bg.
import type { Progress } from '../src/jira/types';
import { percent } from '../src/jira/epics';
import type { EpicPage, ListPage, ListRow, ReleasePage } from '../src/panels/protocol';
import { esc, fmtDue, IC, person, priorityIcon, STATUS_LABEL, typeIcon } from './render';

const dash = '<span class="mut">—</span>';

/** Сегментная полоса прогресса: готово / в работе / не начато (остаток — фон дорожки). */
export function segBar(p: Progress): string {
  const w = (n: number): string => (p.total ? ((n / p.total) * 100).toFixed(1) : '0');
  return `<div class="bar seg" role="img" aria-label="Готово ${p.done} из ${p.total}"><i class="b-done" data-w="${w(p.done)}"></i><i class="b-prog" data-w="${w(p.prog)}"></i></div>`;
}

export function progressBlock(p: Progress): string {
  return `<div class="sum"><div><b>${p.done} из ${p.total}</b><span>готово · ${percent(p)}%</span></div><div><b>${p.prog}</b><span>в работе</span></div><div><b>${p.todo}</b><span>не начато</span></div></div>`
    + `${segBar(p)}<div class="legend"><span><i class="b-done"></i>Готово ${p.done}</span><span><i class="b-prog"></i>В работе ${p.prog}</span><span><i class="b-todo"></i>Открыто ${p.todo}</span></div>`;
}

/** Таблица задач; строка открывает карточку (`data-act="open"`). `extraTitle` — заголовок последней колонки (Релиз / Эпик). */
export function issueTable(rows: readonly ListRow[], extraTitle: string): string {
  const body = rows.map((r) => `<tr class="click" data-act="open" data-key="${esc(r.key)}" tabindex="0"><td>${typeIcon(r.type)}</td><td class="k nw">${esc(r.key)}</td><td>${esc(r.summary)}</td>`
    + `<td><span class="pill s-${r.statusCategory}" title="${esc(STATUS_LABEL[r.statusCategory])}">${esc(r.status || STATUS_LABEL[r.statusCategory])}</span></td>`
    + `<td>${r.priority ? `<span class="prio" title="${esc(r.priority)}">${priorityIcon(r.priority)}</span>` : dash}</td><td>${person(r.assignee)}</td>`
    + `<td class="mut nw">${r.extra ? esc(r.extra) : '—'}</td></tr>`).join('');
  return `<div class="tw-wrap"><table class="t"><thead><tr><th></th><th>Ключ</th><th>Задача</th><th>Статус</th><th>Приоритет</th><th>Исполнитель</th><th>${esc(extraTitle)}</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

const truncNote = (p: ListPage): string => (p.truncated ? `<p class="foot">Показаны первые ${p.rows.length} задач — в Jira их больше; прогресс посчитан по показанным.</p>` : '');

const crumbs = (p: ListPage, section: string): string =>
  `<div class="crumbs">${IC.server} ${esc(p.instanceName)}${p.project ? `<span>›</span>${esc(p.project)}` : ''}<span>›</span>${section}</div>`;

export function renderEpicPage(p: EpicPage): string {
  const table = p.rows.length ? issueTable(p.rows, 'Релиз') : `<p class="mut">${p.link ? 'В эпике пока нет задач.' : 'Поле Epic Link не найдено на инстансе — задачи эпика недоступны. Обновите возможности инстанса или задайте поле в настройках.'}</p>`;
  const foot = p.kind === 'cloud'
    ? 'Jira Cloud: задачи эпика ищутся по <code>parent</code>.'
    : `Server/DC: задачи эпика ищутся по полю Epic Link${p.link ? ` (<code>${esc(p.link)}</code>)` : ''}.`;
  return `<div class="wide-pad">${crumbs(p, 'Эпики')}
  <h1 class="ico-h">${typeIcon('Epic')}${esc(p.summary)}</h1>
  <div class="hrow mb"><span class="k">${esc(p.key)}</span><span class="pill s-${p.statusCategory}" title="${esc(STATUS_LABEL[p.statusCategory])}">${esc(p.status || STATUS_LABEL[p.statusCategory])}</span><span class="sp"></span>
    <button class="btn" data-act="refresh">Обновить</button><button class="btn" data-act="browser">${IC.ext} Открыть в Jira</button></div>
  ${p.rows.length ? progressBlock(p.progress) : ''}${table}${truncNote(p)}<p class="foot">${foot}</p></div>`;
}

export function renderReleasePage(p: ReleasePage): string {
  const left = p.daysLeft !== undefined ? ` · <b>${p.daysLeft >= 0 ? `осталось ${p.daysLeft} дн.` : `просрочен на ${-p.daysLeft} дн.`}</b>` : '';
  const dates = `${p.startDate ? `Старт ${esc(fmtDue(p.startDate))}` : 'Старт не задан'} · ${p.releaseDate ? `${p.released ? 'Выпущен' : 'Релиз'} ${esc(fmtDue(p.releaseDate))}` : 'дата релиза не задана'}${left}`;
  return `<div class="wide-pad">${crumbs(p, 'Релизы')}
  <h1 class="ico-h"><span class="tag-ic">${IC.tag}</span>${esc(p.name)}</h1>
  <div class="hrow mb">${p.released ? '<span class="pill s-done">Выпущен</span>' : '<span class="pill s-indeterminate">Не выпущен</span>'}
    <span class="sm">${dates}</span>${p.description ? `<span class="mut sm">${esc(p.description)}</span>` : ''}<span class="sp"></span>
    <button class="btn" data-act="refresh">Обновить</button><button class="btn" data-act="browser">${IC.ext} Открыть в Jira</button></div>
  ${p.rows.length ? `${progressBlock(p.progress)}${issueTable(p.rows, 'Эпик')}${truncNote(p)}` : '<p class="mut">В версии пока нет задач.</p>'}</div>`;
}

export const renderListPage = (p: ListPage): string => (p.type === 'epic' ? renderEpicPage(p) : renderReleasePage(p));
