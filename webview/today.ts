// Блок «Сегодня» раздела Tempo (prototype: `renderTempo`, без недельной таблицы) — чистая функция «данные → HTML».
import { formatDuration } from '../src/duration';
import type { TodayView } from '../src/panels/protocol';
import { esc } from './render';

const clock = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.6V8l2.4 1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

/** «пт, 2 октября» — из `YYYY-MM-DD` без сдвига часового пояса. */
export function dayLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
}

export function renderToday(v: TodayView): string {
  if (v.noInstances) {
    return `<div class="tp"><p class="mut sm">Нет подключённых инстансов Jira.</p><div class="row-btns"><button class="btn sm pri" data-act="addInstance">Добавить инстанс</button></div></div>`;
  }
  const pct = v.workdaySec > 0 ? Math.min(100, Math.round((v.totalSec / v.workdaySec) * 100)) : 0;
  const left = Math.max(0, v.workdaySec - v.totalSec);
  const rows = v.instances.flatMap((i) => i.entries.map((e) =>
    `<div class="row" data-act="open" data-inst="${esc(i.instanceId)}" data-key="${esc(e.key)}" tabindex="0" title="${esc(`${i.name} · ${e.key}${e.summary ? ` — ${e.summary}` : ''}${e.comment ? `\n${e.comment}` : ''}`)}"><span class="k">${esc(e.key)}</span><span class="lbl mut">${esc(e.comment || e.summary || '')}</span><span class="t">${esc(formatDuration(e.timeSpentSec))}</span></div>`));
  const errors = v.instances.filter((i) => i.error).map((i) => `<div class="tp-err" title="${esc(i.error ?? '')}">${esc(i.name)}: ${esc(i.error ?? '')}</div>`);
  const empty = !rows.length && !errors.length ? `<p class="mut sm">${v.loading ? 'Загрузка…' : 'Сегодня записей нет.'}</p>` : '';
  return `<div class="tp">
    <div class="tp-top"><div><div class="sm mut">Сегодня, ${esc(dayLabel(v.date))}${v.loading ? ' · обновляю…' : ''}</div><div class="big">${esc(formatDuration(v.totalSec))}</div></div><div class="sm mut">из ${esc(formatDuration(v.workdaySec))} · осталось ${esc(formatDuration(left))}</div></div>
    <div class="bar"><i class="b-acc" data-w="${pct}"></i></div>
    <div class="tl">${rows.join('')}</div>${empty}${errors.join('')}
    <div class="row-btns"><button class="btn sm" data-act="refresh">Обновить</button><button class="btn sm pri" data-act="logWork">${clock} Залогать</button></div>
  </div>`;
}
