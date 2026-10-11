import { describe, expect, it } from 'vitest';
import { FilterState, SAVED_KEY, STATE_KEY } from '../src/state/filters';
import { INSTANCES_KEY, InstanceStore, inScope, tokenKey } from '../src/state/instances';
import { SectionProject } from '../src/state/sectionProject';

const mem = (init: Record<string, unknown> = {}) => {
  const m = new Map(Object.entries(init));
  return { m, get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d), update: async (k: string, v: unknown) => void m.set(k, JSON.parse(JSON.stringify(v))) };
};
const secrets = { get: async () => undefined, store: async () => undefined, delete: async () => undefined };
const northwind = { id: 'jira-northwind-io', name: 'Northwind', baseUrl: 'https://jira.northwind.io', kind: 'dc' as const };
const tati = { id: 'tracker-initech-net-jira', name: 'Initech', baseUrl: 'https://tracker.initech.net/jira', kind: 'dc' as const };

describe('набор инстансов workspace', () => {
  it('inScope: по id и по адресу, без набора — все', () => {
    expect(inScope(northwind, undefined)).toBe(true);
    expect(inScope(northwind, ['jira-northwind-io'])).toBe(true);
    expect(inScope(northwind, ['https://jira.northwind.io/'])).toBe(true);
    expect(inScope(tati, ['https://tracker.initech.net/jira'])).toBe(true);
    expect(inScope(tati, ['https://tracker.initech.net'])).toBe(false);
    expect(inScope(northwind, ['мусор', tati.id])).toBe(false);
  });

  it('list фильтрует, all и get — нет; смена набора будит подписчиков', () => {
    const store = new InstanceStore(mem({ [INSTANCES_KEY]: [northwind, tati] }) as never, secrets as never);
    const cur: { scope?: string[] } = {};
    store.setScope(() => cur.scope);
    expect(store.list().map((i) => i.id)).toEqual([northwind.id, tati.id]);
    let fired = 0;
    store.onDidChange(() => fired++);
    cur.scope = [tati.baseUrl];
    store.scopeChanged();
    expect(fired).toBe(1);
    expect(store.list().map((i) => i.id)).toEqual([tati.id]);
    expect(store.all()).toHaveLength(2);
    expect(store.get(northwind.id)?.name).toBe('Northwind');
    expect(store.visible(northwind.id)).toBe(false);
    expect(store.visible(tati.id)).toBe(true);
    expect(store.visible('нет-такого')).toBe(false);
  });

  it('FilterState: выбор — в workspace (с фолбэком на глобальный), сохранённые фильтры — глобально', async () => {
    const global = mem({ [STATE_KEY]: { mode: 'project', project: { instanceId: 'a', key: 'G' } } });
    const local = mem();
    const f = new FilterState(global as never, local as never);
    expect(f.snapshot.project?.key).toBe('G');
    f.setProject({ instanceId: 'a', key: 'L' });
    await f.saveFilter('x', 'project = X');
    expect((local.m.get(STATE_KEY) as { project: { key: string } }).project.key).toBe('L');
    expect((global.m.get(STATE_KEY) as { project: { key: string } }).project.key).toBe('G');
    expect(local.m.has(SAVED_KEY)).toBe(false);
    expect(global.m.get(SAVED_KEY)).toHaveLength(1);
  });

  it('SectionProject: свой выбор у workspace, пока его нет — глобальный', () => {
    const global = mem({ k: { instanceId: 'a', key: 'G' } });
    const local = mem();
    const sp = new SectionProject(local as never, 'k', global as never);
    expect(sp.get()?.key).toBe('G');
    sp.set({ instanceId: 'a', key: 'L' });
    expect(sp.get()?.key).toBe('L');
    expect((global.m.get('k') as { key: string }).key).toBe('G');
  });
});

describe('InstanceStore: rename и setToken', () => {
  const fakeSecrets = () => {
    const m = new Map<string, string>();
    return { m, get: async (k: string) => m.get(k), store: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k) };
  };
  const make = () => {
    const state = mem({ [INSTANCES_KEY]: [{ ...northwind, caps: { tempo: true, epicLinkField: null, checkedAt: 'x' } }, tati] });
    const sec = fakeSecrets();
    sec.m.set(tokenKey(northwind.id), 'old');
    const store = new InstanceStore(state as never, sec as never);
    let fired = 0;
    store.onDidChange(() => fired++);
    return { store, sec, state, fired: () => fired };
  };

  it('rename: обрезает пробелы, остальное (caps, другие инстансы) не трогает, будит подписчиков', async () => {
    const { store, fired } = make();
    expect(await store.rename(northwind.id, '  Работа  ')).toBe(true);
    expect(store.get(northwind.id)).toMatchObject({ name: 'Работа', baseUrl: northwind.baseUrl, caps: { tempo: true } });
    expect(store.get(tati.id)?.name).toBe('Initech');
    expect(fired()).toBe(1);
  });
  it('rename: пустое имя и неизвестный id — false, без записи и события', async () => {
    const { store, fired } = make();
    expect(await store.rename(northwind.id, '   ')).toBe(false);
    expect(await store.rename('нет', 'X')).toBe(false);
    expect(store.get(northwind.id)?.name).toBe('Northwind');
    expect(fired()).toBe(0);
  });
  it('setToken: заменяет токен существующего инстанса, будит подписчиков', async () => {
    const { store, sec, fired } = make();
    expect(await store.setToken(northwind.id, ' new ')).toBe(true);
    expect(await store.getToken(northwind.id)).toBe('new');
    expect(sec.m.get(tokenKey(tati.id))).toBeUndefined();
    expect(fired()).toBe(1);
  });
  it('setToken: пустой токен и неизвестный id — false, токена-сироты нет', async () => {
    const { store, sec, fired } = make();
    expect(await store.setToken(northwind.id, '  ')).toBe(false);
    expect(await store.setToken('удалён', 'tok')).toBe(false);
    expect(sec.m.get(tokenKey(northwind.id))).toBe('old');
    expect(sec.m.has(tokenKey('удалён'))).toBe(false);
    expect(fired()).toBe(0);
  });
  it('setToken: инстанс отключили, пока шла запись токена, — токен убирается, false', async () => {
    const { store, sec, state } = make();
    const store0 = sec.store;
    sec.store = async (k: string, v: string) => {
      await store0(k, v);
      await state.update(INSTANCES_KEY, [tati]); // remove из палитры успел между проверкой и записью
    };
    expect(await store.setToken(northwind.id, 'new')).toBe(false);
    expect(sec.m.has(tokenKey(northwind.id))).toBe(false);
  });
});
