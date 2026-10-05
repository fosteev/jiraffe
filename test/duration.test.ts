import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration } from '../src/duration';

describe('parseDuration', () => {
  it.each([
    ['1ч 30м', 5400],
    ['1ч30м', 5400],
    ['1h30m', 5400],
    ['1h 30m', 5400],
    ['90m', 5400],
    ['1.5h', 5400],
    ['1,5ч', 5400],
    ['2', 7200],
    ['0.5', 1800],
    ['45 мин', 2700],
    ['2 часа', 7200],
    ['  3H ', 10800],
    ['2ч', 7200],
    ['15м', 900],
    ['1 ч. 30 мин.', 5400],
    ['1Ч 30М', 5400],
    ['1 h 30 m', 5400],
    ['1ч, 30м', 5400],
    ['1 минуту', 60],
    ['0.01h', 60],
    ['10000h', 36_000_000],
  ])('%s → %i', (input, sec) => {
    expect(parseDuration(input)).toBe(sec);
  });

  it.each(['', '   ', 'abc', '1x', 'ч', '1ч abc', '1 30', '-1h', '0', '0м', '1h-2m', '1.2.3h', '1.5.5', '1h30', '1e5h', '0.001h', '10001h', '99999999999999999999h', '1ч..', '.5h'])(
    'мусор %j → null',
    (input) => {
      expect(parseDuration(input)).toBeNull();
    },
  );
});

describe('formatDuration', () => {
  it('форматирует часы и минуты', () => {
    expect(formatDuration(5400)).toBe('1h 30m');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(1800)).toBe('30m');
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(90000)).toBe('25h');
  });
  it('округляет секунды до минут', () => {
    expect(formatDuration(5429)).toBe('1h 30m');
    expect(formatDuration(5431)).toBe('1h 31m');
    expect(formatDuration(29)).toBe('0m');
    expect(formatDuration(30)).toBe('1m');
    expect(formatDuration(3599)).toBe('1h');
  });
  it('отрицательное и не-число → 0м', () => {
    expect(formatDuration(-60)).toBe('0m');
    expect(formatDuration(NaN)).toBe('0m');
    expect(formatDuration(Infinity)).toBe('0m');
  });
  it('обратим с parseDuration', () => {
    expect(parseDuration(formatDuration(5400))).toBe(5400);
  });
});
