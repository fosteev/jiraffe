import { describe, expect, it } from 'vitest';
import { parseSettingsMessage } from '../src/panels/protocol';
import {
  buildSettingsState, parseDir, parseNumber, parseSetting, parseSort, resolveScalar, SETTING_IDS, type SettingsInput,
} from '../src/panels/settingsModel';
import type { Instance } from '../src/jira/types';
import { ConnectionStatus, accountLabel, connectionErrorText, instanceIdentity, instanceSnapshot, planScopeWrite } from '../src/panels/connectionStatus';
import { JiraError } from '../src/jira/http';
import { buildInstanceCard } from '../src/panels/settingsModel';
import { isAbsoluteDir, relativeInside } from '../src/panels/settingsPaths';

const base: SettingsInput = {
  maxResults: { defaultValue: 50 }, attachmentsDir: { defaultValue: '.jiraffe' }, maxImageMb: { defaultValue: 5 }, workdayHours: { defaultValue: 8 },
  sort: undefined, grouped: false, hasWorkspace: true, canScope: true, instances: [], scopeSet: false,
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
  it('пять разделов, заглушка только «Интеграции»; все id строк известны', () => {
    const s = buildSettingsState(base);
    expect(s.sections.map((x) => [x.id, x.soon])).toEqual([['conn', false], ['list', false], ['att', false], ['time', false], ['int', true]]);
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

const dc: Instance = { id: 'jira-a', name: 'Alpha', baseUrl: 'https://jira.a.io', kind: 'dc', caps: { tempo: true, epicLinkField: 'customfield_10', checkedAt: '2026-10-01T10:00:00.000Z', serverVersion: '9.12' } };
const cloud: Instance = { id: 'b-atlassian-net', name: 'Beta', baseUrl: 'https://b.atlassian.net', kind: 'cloud', email: 'x@y.z', caps: { tempo: false, epicLinkField: null, checkedAt: '2026-10-02T10:00:00.000Z' } };
const bare: Instance = { id: 'bare', name: 'Bare', baseUrl: 'https://bare.io', kind: 'dc' };

describe('карточка инстанса', () => {
  it('DC с Tempo и Epic Link, ok, аккаунт', () => {
    const c = buildInstanceCard(dc, { state: 'ok', account: 'Ann · ann' }, true);
    expect(c).toMatchObject({ id: 'jira-a', host: 'jira.a.io', kind: 'dc', state: 'ok', account: 'Ann · ann', serverVersion: '9.12', journal: 'tempo', epic: { kind: 'field', id: 'customfield_10' }, inScope: true });
    expect(c.error).toBeUndefined();
  });
  it('ошибка: текст есть, аккаунта нет', () => {
    const c = buildInstanceCard(dc, { state: 'error', message: 'boom' }, true);
    expect(c).toMatchObject({ state: 'error', error: 'boom' });
    expect(c.account).toBeUndefined();
  });
  it('без caps: журнал и Epic Link «не проверено», версии и времени нет; без статуса — «проверяется»', () => {
    const c = buildInstanceCard(bare, undefined, true);
    expect(c).toMatchObject({ state: 'checking', journal: 'unknown', epic: { kind: 'unknown' } });
    expect(c.serverVersion).toBeUndefined();
    expect(c.checkedAt).toBeUndefined();
  });
  it('Cloud без Tempo: журнал Jira, Epic Link — parent, подпись токена про email', () => {
    const c = buildInstanceCard(cloud, { state: 'ok', account: 'B' }, true);
    expect(c).toMatchObject({ kind: 'cloud', journal: 'jira', epic: { kind: 'parent' } });
    expect(c.tokenKind).toMatch(/email|почт/i);
  });
  it('DC без поля Epic Link в caps — «не найдено»', () => {
    expect(buildInstanceCard({ ...dc, caps: { tempo: false, epicLinkField: null, checkedAt: dc.caps!.checkedAt } }, undefined, true).epic).toEqual({ kind: 'none' });
  });
  it('вне набора workspace — inScope=false', () => {
    expect(buildInstanceCard(dc, undefined, false).inScope).toBe(false);
  });
  it('мусор в globalState не ломает сборку', () => {
    const junk = { id: 'j', baseUrl: 'not a url', name: 5, kind: 'x', caps: { tempo: 'yes', epicLinkField: 7, checkedAt: 'вчера', serverVersion: { a: 1 } } } as unknown as Instance;
    const c = buildInstanceCard(junk, undefined, true);
    expect(c).toMatchObject({ id: 'j', name: 'j', host: 'not a url', kind: 'dc', journal: 'jira', epic: { kind: 'none' } });
    expect(c.checkedAt).toBeUndefined();
    expect(c.serverVersion).toBeUndefined();
  });
  it('токена в состоянии нет: ни в карточке, ни в строках', () => {
    const s = buildSettingsState({ ...base, instances: [{ inst: { ...dc, token: 'SECRET123' } as Instance, status: undefined, inScope: true }] });
    expect(JSON.stringify(s)).not.toContain('SECRET123');
  });
});

describe('состояние: подключения и «Куда пишется время»', () => {
  const inst = (list: [Instance, boolean][]) => list.map(([i, inS]) => ({ inst: i, status: undefined, inScope: inS }));
  it('режим набора, счётчик ошибок на пункте меню, canScope', () => {
    const s = buildSettingsState({
      ...base, scopeSet: true, canScope: false,
      instances: [{ inst: dc, status: { state: 'error', message: 'x' }, inScope: true }, { inst: cloud, status: { state: 'ok', account: 'B' }, inScope: false }],
    });
    expect(s.connections).toMatchObject({ mode: 'some', canScope: false });
    expect(s.connections.cards.map((c) => c.inScope)).toEqual([true, false]);
    expect(s.sections.find((x) => x.id === 'conn')?.badge).toBe(1);
  });
  it('нет ошибок — бейджа нет', () => {
    expect(buildSettingsState({ ...base, instances: inst([[dc, true]]) }).sections.find((x) => x.id === 'conn')?.badge).toBeUndefined();
  });
  it('таблица времени: только инстансы набора; Tempo / журнал Jira / не проверено', () => {
    const s = buildSettingsState({ ...base, instances: inst([[dc, true], [cloud, true], [bare, true], [{ ...dc, id: 'out', name: 'Out' }, false]]) });
    expect(s.timeTargets.rows.map((r) => [r.name, r.journal, r.label])).toEqual([
      ['Alpha', 'tempo', 'Tempo'], ['Beta', 'jira', 'Jira work log'], ['Bare', 'unknown', 'Not checked yet'],
    ]);
    expect(s.timeTargets.rows[0].note).toMatch(/AI Tokens/);
    expect(s.timeTargets.rows[1].note).toMatch(/comment/);
    expect(s.timeTargets.rows[2].note).toBe('');
  });
  it('новые сообщения протокола: действия, набор', () => {
    expect(parseSettingsMessage({ type: 'instance', action: 'rename', id: 'jira-a' })).toEqual({ type: 'instance', action: 'rename', id: 'jira-a' });
    expect(parseSettingsMessage({ type: 'instance', action: 'drop', id: 'jira-a' })).toBeUndefined();
    expect(parseSettingsMessage({ type: 'instance', action: 'remove', id: '../x' })).toBeUndefined();
    expect(parseSettingsMessage({ type: 'instance', action: 'remove', id: 5 })).toBeUndefined();
    expect(parseSettingsMessage({ type: 'addInstance' })).toEqual({ type: 'addInstance' });
    expect(parseSettingsMessage({ type: 'scopeMode', mode: 'some' })).toEqual({ type: 'scopeMode', mode: 'some' });
    expect(parseSettingsMessage({ type: 'scopeMode', mode: 'none' })).toBeUndefined();
    expect(parseSettingsMessage({ type: 'scopeToggle', id: 'jira-a', on: false })).toEqual({ type: 'scopeToggle', id: 'jira-a', on: false });
    expect(parseSettingsMessage({ type: 'scopeToggle', id: 'jira-a', on: 'yes' })).toBeUndefined();
  });
});

describe('ConnectionStatus: проверки без гонок', () => {
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const me = (n: string) => ({ displayName: n, name: n.toLowerCase() });

  it('успех и ошибка; «проверяется» сразу; уведомления', async () => {
    const alive = new Set(['a', 'b']);
    let changes = 0;
    const st = new ConnectionStatus((id) => alive.has(id), () => changes++);
    const d = deferred<{ displayName: string; name: string }>();
    const p = st.check('a', () => d.promise);
    expect(st.get('a')).toEqual({ state: 'checking' });
    d.resolve(me('Ann'));
    await p;
    expect(st.get('a')).toEqual({ state: 'ok', account: 'Ann · ann' });
    await st.check('b', async () => { throw new JiraError(401, 'x', 'u'); });
    expect(st.get('b')).toMatchObject({ state: 'error' });
    expect(changes).toBe(4);
  });
  it('устаревший ответ выбрасывается: побеждает последний запуск', async () => {
    const st = new ConnectionStatus(() => true, () => undefined);
    const first = deferred<{ displayName: string; name: string }>();
    const second = deferred<{ displayName: string; name: string }>();
    const p1 = st.check('a', () => first.promise);
    const p2 = st.check('a', () => second.promise);
    second.resolve(me('New'));
    await p2;
    first.resolve(me('Old'));
    await p1;
    expect(st.get('a')).toEqual({ state: 'ok', account: 'New · new' });
  });
  it('ответ для удалённого за время запроса инстанса выбрасывается (и ошибка тоже)', async () => {
    const alive = new Set(['a', 'b']);
    const st = new ConnectionStatus((id) => alive.has(id), () => undefined);
    const d = deferred<{ displayName: string; name: string }>();
    const e = deferred<{ displayName: string; name: string }>();
    const p = st.check('a', () => d.promise);
    const q = st.check('b', () => e.promise);
    alive.delete('a');
    alive.delete('b');
    st.prune();
    d.resolve(me('Ann'));
    e.reject(new Error('late'));
    await Promise.all([p, q]);
    expect(st.get('a')).toBeUndefined();
    expect(st.get('b')).toBeUndefined();
  });
  it('forget отменяет идущую проверку, даже если инстанс снова есть', async () => {
    const st = new ConnectionStatus(() => true, () => undefined);
    const d = deferred<{ displayName: string; name: string }>();
    const p = st.check('a', () => d.promise);
    st.forget('a');
    d.resolve(me('Ann'));
    await p;
    expect(st.has('a')).toBe(false);
  });
  it('тексты: 401 — токен не принят, длинная ошибка обрезается, displayName=name не дублируется', () => {
    expect(connectionErrorText(new JiraError(401, 'Not authorized', 'u'))).toMatch(/401/);
    expect(connectionErrorText(new Error('x'.repeat(1000))).length).toBeLessThan(400);
    expect(connectionErrorText('str')).toBe('str');
    expect(accountLabel({ displayName: 'Ann', name: 'Ann' })).toBe('Ann');
  });
});

describe('набор workspace: что писать в jiraffe.instances', () => {
  const a = { id: 'jira-a-io', name: 'A', baseUrl: 'https://jira.a.io', kind: 'dc' } as Instance;
  const b = { id: 'jira-b-io', name: 'B', baseUrl: 'https://jira.b.io', kind: 'dc' } as Instance;
  const all = [a, b];
  it('«отмеченные» из «все» — явный список всех; уже задан или инстансов нет — ничего', () => {
    expect(planScopeWrite({ type: 'scopeMode', mode: 'some' }, undefined, undefined, all)).toEqual({ kind: 'write', value: [a.id, b.id] });
    expect(planScopeWrite({ type: 'scopeMode', mode: 'some' }, [a.id], undefined, all)).toEqual({ kind: 'skip' });
    expect(planScopeWrite({ type: 'scopeMode', mode: 'some' }, undefined, undefined, [])).toEqual({ kind: 'skip' });
  });
  it('«все»: снять workspace-значение; набор в пользовательских — пустой массив; уже «все» — ничего', () => {
    expect(planScopeWrite({ type: 'scopeMode', mode: 'all' }, [a.id], undefined, all)).toEqual({ kind: 'write', value: undefined });
    expect(planScopeWrite({ type: 'scopeMode', mode: 'all' }, [a.id], [], all)).toEqual({ kind: 'write', value: undefined });
    expect(planScopeWrite({ type: 'scopeMode', mode: 'all' }, [a.id], ['  '], all)).toEqual({ kind: 'write', value: undefined });
    expect(planScopeWrite({ type: 'scopeMode', mode: 'all' }, [a.id], [a.id], all)).toEqual({ kind: 'write', value: [] });
    expect(planScopeWrite({ type: 'scopeMode', mode: 'all' }, undefined, [a.id], all)).toEqual({ kind: 'skip' });
  });
  it('флажки: добавить/снять, запись-адрес нормализуется в id, неизвестные id выпадают, последний снять нельзя', () => {
    expect(planScopeWrite({ type: 'scopeToggle', id: b.id, on: true }, [a.baseUrl, 'gone-id'], undefined, all)).toEqual({ kind: 'write', value: [a.id, b.id] });
    expect(planScopeWrite({ type: 'scopeToggle', id: b.id, on: false }, [a.id, b.id], undefined, all)).toEqual({ kind: 'write', value: [a.id] });
    expect(planScopeWrite({ type: 'scopeToggle', id: a.id, on: false }, [a.id], undefined, all)).toEqual({ kind: 'empty' });
    expect(planScopeWrite({ type: 'scopeToggle', id: a.id, on: true }, undefined, undefined, all)).toEqual({ kind: 'skip' });
    expect(planScopeWrite({ type: 'scopeToggle', id: 'jira-x-io', on: true }, [a.id], undefined, all)).toEqual({ kind: 'skip' });
  });
  it('снимки: caps меняют snapshot, но не identity; другой email — другая identity', () => {
    const withCaps = { ...a, caps: { tempo: true, epicLinkField: null, checkedAt: '2026-10-11T00:00:00Z' } };
    expect(instanceSnapshot(withCaps)).not.toBe(instanceSnapshot(a));
    expect(instanceIdentity(withCaps)).toBe(instanceIdentity(a));
    expect(instanceIdentity({ ...a, kind: 'cloud', email: 'x@y' })).not.toBe(instanceIdentity({ ...a, kind: 'cloud', email: 'z@y' }));
  });
});
