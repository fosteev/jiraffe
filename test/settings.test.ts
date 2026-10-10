import { describe, expect, it } from 'vitest';
import { parseSettingsMessage } from '../src/panels/protocol';
import {
  buildSettingsState, parseDir, parseNumber, parseSetting, parseSort, resolveScalar, SETTING_IDS, type SettingsInput,
} from '../src/panels/settingsModel';
import { isAbsoluteDir, relativeInside } from '../src/panels/settingsPaths';

const base: SettingsInput = {
  maxResults: { defaultValue: 50 }, attachmentsDir: { defaultValue: '.jiraffe' }, maxImageMb: { defaultValue: 5 }, workdayHours: { defaultValue: 8 },
  sort: undefined, grouped: false, hasWorkspace: true,
};

describe('resolveScalar: уровень значения', () => {
  it('только default: уровень user (куда пишем), не изменено', () => {
    expect(resolveScalar({ defaultValue: 50 }, 1)).toEqual({ value: 50, level: 'user', target: 'global', modified: false });
  });
  it('без inspect — запасное значение', () => {
    expect(resolveScalar<number>(undefined, 7).value).toBe(7);
  });
  it('global', () => {
    expect(resolveScalar({ defaultValue: 50, globalValue: 20 }, 1)).toMatchObject({ value: 20, level: 'user', target: 'global', modified: true });
  });
  it('workspace перекрывает global', () => {
    expect(resolveScalar({ defaultValue: 50, globalValue: 20, workspaceValue: 30 }, 1)).toMatchObject({ value: 30, level: 'workspace', target: 'workspace' });
  });
  it('workspaceFolder перекрывает workspace', () => {
    expect(resolveScalar({ defaultValue: 50, workspaceValue: 30, workspaceFolderValue: 40 }, 1)).toMatchObject({ value: 40, level: 'workspaceFolder', target: 'workspaceFolder' });
  });
  it('явно заданное, но равное стандартному — не «изменено», уровень виден', () => {
    expect(resolveScalar({ defaultValue: 50, globalValue: 50 }, 1)).toMatchObject({ level: 'user', modified: false });
  });
});

describe('resolveScalar: значение не того типа в settings.json', () => {
  it('строка вместо числа: показываем стандартное, уровень и цель — там, где лежит мусор, «изменено» (есть «Сбросить»)', () => {
    expect(resolveScalar<number>({ defaultValue: 50, workspaceValue: '"><b>' as unknown as number }, 1))
      .toEqual({ value: 50, level: 'workspace', target: 'workspace', modified: true });
  });
  it('число вместо строки и NaN', () => {
    expect(resolveScalar<string>({ defaultValue: '.jiraffe', globalValue: 123 as unknown as string }, '.jiraffe').value).toBe('.jiraffe');
    expect(resolveScalar<number>({ defaultValue: 8, globalValue: Number.NaN }, 8)).toMatchObject({ value: 8, modified: true });
  });
  it('default не того типа — запасное значение', () => {
    expect(resolveScalar<number>({ defaultValue: 'x' as unknown as number }, 7).value).toBe(7);
  });
});

describe('buildSettingsState', () => {
  it('пять разделов, «Подключения» и «Интеграции» — заглушки; все id строк известны', () => {
    const s = buildSettingsState(base);
    expect(s.sections.map((x) => [x.id, x.soon])).toEqual([['conn', true], ['list', false], ['att', false], ['time', false], ['int', true]]);
    expect(s.rows.map((r) => r.id).sort()).toEqual([...SETTING_IDS].sort());
    expect(s.rows.every((r) => !r.modified)).toBe(true);
  });
  it('строки по разделам: список — 3, вложения — 2, время — 1', () => {
    const s = buildSettingsState(base);
    const n = (sec: string): number => s.rows.filter((r) => r.section === sec).length;
    expect([n('list'), n('att'), n('time'), n('conn'), n('int')]).toEqual([3, 2, 1, 0, 0]);
  });
  it('значения, метки уровня и изменённость', () => {
    const s = buildSettingsState({
      ...base, maxResults: { defaultValue: 50, workspaceValue: 20 }, attachmentsDir: { defaultValue: '.jiraffe', globalValue: '/abs/att' },
      workdayHours: { defaultValue: 8, globalValue: 7.5 }, sort: { field: 'priority', desc: false }, grouped: true,
    });
    const r = (id: string) => s.rows.find((x) => x.id === id)!;
    expect(r('maxResults')).toMatchObject({ level: 'workspace', modified: true, resetTo: '50', control: { kind: 'number', value: 20, min: 1, max: 100 } });
    expect(r('attachmentsDir')).toMatchObject({ level: 'user', modified: true, resetTo: '.jiraffe', control: { kind: 'text', value: '/abs/att', pick: true } });
    expect(r('workdayHours')).toMatchObject({ modified: true, control: { value: 7.5, min: 1, max: 24, step: 0.5 } });
    expect(r('sort')).toMatchObject({ level: 'state', modified: true, control: { kind: 'sort', field: 'priority', desc: false } });
    expect(r('grouped')).toMatchObject({ level: 'state', modified: true, control: { kind: 'switch', value: true } });
  });
  it('сортировка по умолчанию: поле пустое, варианты — «по умолчанию» + SORT_FIELDS', () => {
    const c = buildSettingsState(base).rows.find((x) => x.id === 'sort')!.control;
    expect(c).toMatchObject({ field: '', desc: true });
    expect((c as { fields: { value: string }[] }).fields.map((f) => f.value)).toEqual(['', 'key', 'priority', 'created', 'updated']);
  });
  it('нет папки — «Выбрать…» недоступно', () => {
    const c = buildSettingsState({ ...base, hasWorkspace: false }).rows.find((x) => x.id === 'attachmentsDir')!.control;
    expect(c).toMatchObject({ pick: false });
  });
});

describe('валидация значений из webview', () => {
  it('числа: диапазоны как в package.json', () => {
    expect(parseNumber('maxResults', 1).ok).toBe(true);
    expect(parseNumber('maxResults', 100).ok).toBe(true);
    expect(parseNumber('maxResults', 0).ok).toBe(false);
    expect(parseNumber('maxResults', 101).ok).toBe(false);
    expect(parseNumber('maxResults', 2.5).ok).toBe(false);
    expect(parseNumber('maxImageMb', 0.5).ok).toBe(false);
    expect(parseNumber('maxImageMb', 1.5).ok).toBe(true);
    expect(parseNumber('maxImageMb', 50).ok).toBe(true);
    expect(parseNumber('maxImageMb', 51).ok).toBe(false);
    expect(parseNumber('workdayHours', 7.5).ok).toBe(true);
    expect(parseNumber('workdayHours', 24).ok).toBe(true);
    expect(parseNumber('workdayHours', 25).ok).toBe(false);
    for (const bad of ['5', null, undefined, NaN, Infinity, {}, []]) expect(parseNumber('workdayHours', bad).ok).toBe(false);
  });
  it('путь: пустой = сброс, не строка и NUL — отказ', () => {
    expect(parseDir('  docs/att ')).toEqual({ ok: true, value: 'docs/att' });
    expect(parseDir('  ')).toEqual({ ok: true, value: undefined });
    expect(parseDir(5).ok).toBe(false);
    expect(parseDir('a\0b').ok).toBe(false);
    expect(parseDir('x'.repeat(513)).ok).toBe(false);
    for (const bad of ['..', '../out', 'docs/../../out', '..\\out', '/abs/../x']) expect(parseDir(bad).ok, bad).toBe(false);
    expect(parseDir('..foo/x')).toEqual({ ok: true, value: '..foo/x' });
  });
  it('сортировка', () => {
    expect(parseSort({ field: '', desc: true })).toEqual({ ok: true, value: undefined });
    expect(parseSort({ field: 'key', desc: false })).toEqual({ ok: true, value: { field: 'key', desc: false } });
    expect(parseSort({ field: 'status', desc: true }).ok).toBe(false);
    expect(parseSort({ field: 'key' }).ok).toBe(false);
    expect(parseSort(null).ok).toBe(false);
  });
  it('parseSetting: неизвестный id и тип', () => {
    expect(parseSetting('nope', 1).ok).toBe(false);
    expect(parseSetting('__proto__', 1).ok).toBe(false);
    expect(parseSetting('grouped', 'yes').ok).toBe(false);
    expect(parseSetting('grouped', true)).toEqual({ ok: true, value: { id: 'grouped', value: true } });
    expect(parseSetting('maxResults', 30)).toEqual({ ok: true, value: { id: 'maxResults', value: 30 } });
  });
  it('parseSettingsMessage', () => {
    expect(parseSettingsMessage(null)).toBeUndefined();
    expect(parseSettingsMessage('ready')).toBeUndefined();
    expect(parseSettingsMessage({ type: 'evil' })).toBeUndefined();
    expect(parseSettingsMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseSettingsMessage({ type: 'pickDir' })).toEqual({ type: 'pickDir' });
    expect(parseSettingsMessage({ type: 'openJson' })).toEqual({ type: 'openJson' });
    expect(parseSettingsMessage({ type: 'reset', id: 'sort' })).toEqual({ type: 'reset', id: 'sort' });
    expect(parseSettingsMessage({ type: 'reset', id: 'jiraffe.instances' })).toBeUndefined();
    expect(parseSettingsMessage({ type: 'set', id: 'workdayHours', value: 6 })).toEqual({ type: 'set', setting: { id: 'workdayHours', value: 6 } });
    expect(parseSettingsMessage({ type: 'set', id: 'workdayHours', value: 99 })).toMatchObject({ type: 'invalid' });
    expect(parseSettingsMessage({ type: 'set', id: 'instances', value: [] })).toMatchObject({ type: 'invalid' });
  });
});

describe('пути', () => {
  it('relativeInside: внутри — относительный через /, снаружи и сам workspace — undefined', () => {
    expect(relativeInside('/w/proj', '/w/proj/docs/att')).toBe('docs/att');
    expect(relativeInside('/w/proj', '/w/proj/.jiraffe')).toBe('.jiraffe');
    expect(relativeInside('/w/proj', '/w/proj')).toBeUndefined();
    expect(relativeInside('/w/proj', '/w/other')).toBeUndefined();
    expect(relativeInside('/w/proj', '/w')).toBeUndefined();
    expect(relativeInside('/w/proj', '/w/proj-x/a')).toBe(undefined);
  });
  it('isAbsoluteDir: POSIX и Windows', () => {
    expect(isAbsoluteDir('/abs')).toBe(true);
    expect(isAbsoluteDir('C:\\att')).toBe(true);
    expect(isAbsoluteDir('docs/att')).toBe(false);
    expect(isAbsoluteDir('.jiraffe')).toBe(false);
  });
});
