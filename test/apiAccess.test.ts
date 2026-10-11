import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { API_ALLOW_WRITES, API_ENABLED, API_SECTION, apiFlag, resolveApiAccess } from '../src/apiAccess';
import { ApiActivity } from '../src/state/apiActivity';

describe('package.json: настройки доступа API', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { contributes: { configuration: { properties: Record<string, Record<string, unknown>> } } };
  const props = pkg.contributes.configuration.properties;

  it('ключи в коде совпадают с package.json', () => {
    expect(`${API_SECTION}.${API_ENABLED}`).toBe('jiraffe.api.enabled');
    expect(`${API_SECTION}.${API_ALLOW_WRITES}`).toBe('jiraffe.api.allowWrites');
  });

  it('обе — boolean, по умолчанию true (Agentura 0.8.0 не ломается), scope application: .vscode/settings.json репо их не переопределит', () => {
    for (const key of ['jiraffe.api.enabled', 'jiraffe.api.allowWrites']) {
      expect(props[key], key).toMatchObject({ type: 'boolean', default: true, scope: 'application' });
      expect(String(props[key]?.markdownDescription), key).toMatch(/^%config\.api\./);
    }
  });
});

describe('настройки jiraffe.api.* → доступ API', () => {
  const dflt = { defaultValue: true };

  it('ничего не задано: чтение и запись открыты (Agentura 0.8.0 без настройки продолжает работать)', () => {
    expect(resolveApiAccess(dflt, dflt)).toEqual({ read: true, write: true });
    expect(resolveApiAccess(undefined, undefined)).toEqual({ read: true, write: true });
  });

  it('enabled=false закрывает всё, allowWrites при этом не важен', () => {
    expect(resolveApiAccess({ ...dflt, globalValue: false }, dflt)).toEqual({ read: false, write: false });
    expect(resolveApiAccess({ ...dflt, globalValue: false }, { ...dflt, globalValue: true })).toEqual({ read: false, write: false });
  });

  it('allowWrites=false: чтение открыто, запись закрыта', () => {
    expect(resolveApiAccess(dflt, { ...dflt, globalValue: false })).toEqual({ read: true, write: false });
    expect(resolveApiAccess({ ...dflt, globalValue: true }, { ...dflt, globalValue: true })).toEqual({ read: true, write: true });
  });

  it('workspace и папка не в счёт: чужой .vscode/settings.json не включает обратно выключенное пользователем', () => {
    const off = { ...dflt, globalValue: false, workspaceValue: true, workspaceFolderValue: true };
    expect(resolveApiAccess(off, off)).toEqual({ read: false, write: false });
    expect(resolveApiAccess(dflt, off)).toEqual({ read: true, write: false });
    // и наоборот: настройка уровня application в workspace не действует вообще
    expect(resolveApiAccess({ ...dflt, workspaceValue: false }, { ...dflt, workspaceFolderValue: false })).toEqual({ read: true, write: true });
  });

  it('мусор в пользовательских настройках — «выключено», а не «включено»', () => {
    for (const bad of ['false', 'true', 'yes', 0, 1, null, {}, []]) {
      expect(resolveApiAccess({ ...dflt, globalValue: bad }, dflt), String(JSON.stringify(bad))).toEqual({ read: false, write: false });
      expect(resolveApiAccess(dflt, { ...dflt, globalValue: bad }), String(JSON.stringify(bad))).toEqual({ read: true, write: false });
    }
  });

  it('стандартное значение извне (политика, configurationDefaults) уважается; мусорное стандартное — наше true', () => {
    expect(resolveApiAccess({ defaultValue: false }, dflt)).toEqual({ read: false, write: false });
    expect(resolveApiAccess(dflt, { defaultValue: false })).toEqual({ read: true, write: false });
    expect(resolveApiAccess({ defaultValue: 'x' }, { defaultValue: null })).toEqual({ read: true, write: true });
  });
});

describe('apiFlag: значение, которое показывает вкладка (то же, что решает гейт)', () => {
  it('не задано — стандартное, не изменено', () => {
    expect(apiFlag({ defaultValue: true })).toEqual({ value: true, def: true, modified: false });
    expect(apiFlag(undefined)).toEqual({ value: true, def: true, modified: false });
  });
  it('false в пользовательских — выключено и «изменено»; true, равное стандартному, — не «изменено»', () => {
    expect(apiFlag({ defaultValue: true, globalValue: false })).toEqual({ value: false, def: true, modified: true });
    expect(apiFlag({ defaultValue: true, globalValue: true })).toEqual({ value: true, def: true, modified: false });
  });
  it('мусор показываем как «выключено» (так решает и гейт) и «изменено» — есть что сбросить', () => {
    expect(apiFlag({ defaultValue: true, globalValue: 'false' })).toEqual({ value: false, def: true, modified: true });
    expect(apiFlag({ defaultValue: true, globalValue: null })).toEqual({ value: false, def: true, modified: true });
  });
  it('workspace игнорируется', () => {
    expect(apiFlag({ defaultValue: true, workspaceValue: false, workspaceFolderValue: false })).toEqual({ value: true, def: true, modified: false });
  });
});

describe('ApiActivity: последняя запись через API', () => {
  it('до первой записи пусто', () => {
    expect(new ApiActivity().get()).toBeUndefined();
  });

  it('помнит только последнюю: вид, ключ и время по часам', () => {
    let t = 1_000;
    const a = new ApiActivity(() => t);
    a.record('comment', 'ABC-1');
    expect(a.get()).toEqual({ kind: 'comment', key: 'ABC-1', at: 1_000 });
    t = 2_000;
    a.record('worklog', 'ABC-2');
    expect(a.get()).toEqual({ kind: 'worklog', key: 'ABC-2', at: 2_000 });
  });

  it('подписчики узнают о записи; отписка работает; упавший подписчик не мешает ни остальным, ни записи', () => {
    const a = new ApiActivity();
    const first = vi.fn(() => { throw new Error('view'); });
    const second = vi.fn();
    const sub1 = a.onDidChange(first);
    const sub2 = a.onDidChange(second);
    a.record('transition', 'ABC-3');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(a.get()?.key).toBe('ABC-3');
    sub1.dispose();
    sub2.dispose();
    a.record('comment', 'ABC-4');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(a.get()?.key).toBe('ABC-4');
  });
});
