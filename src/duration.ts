const HOUR = 3600;
const MIN = 60;

const UNIT_SEC: Record<string, number> = {
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
  ч: HOUR, час: HOUR, часа: HOUR, часов: HOUR,
  m: MIN, min: MIN, mins: MIN, minute: MIN, minutes: MIN,
  м: MIN, мин: MIN, минута: MIN, минуту: MIN, минуты: MIN, минут: MIN,
};

// число, затем необязательная единица с необязательной точкой-сокращением (`1 ч. 30 мин.`)
const TOKEN = /^\s*(\d+(?:[.,]\d+)?)\s*(?:([a-zа-яё]+)\.?)?/i;
/** Потолок ввода — 10 000 часов: всё больше — опечатка, а не время работы. */
const MAX_SEC = 10_000 * HOUR;

/**
 * Разбирает ввод длительности в секунды. Понимает `1ч 30м`, `1h30m`, `90m`, `1.5h`,
 * `45 мин`; голое число — часы (`2` → 2 ч). Результат округляется до целых минут (как в
 * `formatDuration`). Мусор, пустая строка, ноль (в т.ч. меньше полуминуты) и больше 10 000 ч → null.
 */
export function parseDuration(input: string): number | null {
  let rest = input.trim().toLowerCase();
  if (!rest) return null;

  let total = 0;
  let tokens = 0;
  while (rest) {
    const m = TOKEN.exec(rest);
    if (!m) return null;
    const value = parseFloat(m[1].replace(',', '.'));
    const unit = m[2];
    if (unit === undefined) {
      // число без единицы — часы, но только если это весь ввод
      if (tokens > 0 || m[0].length !== rest.length) return null;
      total = value * HOUR;
    } else {
      const mul = UNIT_SEC[unit];
      if (mul === undefined) return null;
      total += value * mul;
    }
    tokens++;
    rest = rest.slice(m[0].length).replace(/^[\s,]+/, '');
  }
  const sec = Math.round(total / MIN) * MIN;
  return sec > 0 && sec <= MAX_SEC ? sec : null;
}

/** 5400 → `1ч 30м`, 3600 → `1ч`, 1800 → `30м`, 0 → `0м`. Секунды округляются до минут; отрицательное и NaN → `0м`. */
export function formatDuration(seconds: number): string {
  const totalMin = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds / MIN)) : 0;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}м`;
  return m === 0 ? `${h}ч` : `${h}ч ${m}м`;
}
