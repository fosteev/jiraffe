import { describe, expect, it } from 'vitest';
import { FilterState, SAVED_KEY, STATE_KEY } from '../src/state/filters';
import { INSTANCES_KEY, InstanceStore, inScope } from '../src/state/instances';
import { SectionProject } from '../src/state/sectionProject';

const mem = (init: Record<string, unknown> = {}) => {
  const m = new Map(Object.entries(init));
  return { m, get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d), update: async (k: string, v: unknown) => void m.set(k, JSON.parse(JSON.stringify(v))) };
};
const secrets = { get: async () => undefined, store: async () => undefined, delete: async () => undefined };
const pilot = { id: 'jira-pilot-gps-com', name: 'Pilot', baseUrl: 'https://jira.pilot-gps.com', kind: 'dc' as const };
const tati = { id: 'atlassian-tatikoma-ru-jira', name: 'Tatikoma', baseUrl: 'https://atlassian.tatikoma.ru/jira', kind: 'dc' as const };

describe('набор инстансов workspace', () => {
  it('inScope: по id и по адресу, без набора — все', () => {
    expect(inScope(pilot, undefined)).toBe(true);
    expect(inScope(pilot, ['jira-pilot-gps-com'])).toBe(true);
    expect(inScope(pilot, ['https://jira.pilot-gps.com/'])).toBe(true);
    expect(inScope(tati, ['https://atlassian.tatikoma.ru/jira'])).toBe(true);
    expect(inScope(tati, ['https://atlassian.tatikoma.ru'])).toBe(false);
    expect(inScope(pilot, ['мусор', tati.id])).toBe(false);
  });

  it('list фильтрует, all и get — нет; смена набора будит подписчиков', () => {
    const store = new InstanceStore(mem({ [INSTANCES_KEY]: [pilot, tati] }) as never, secrets as never);
    const cur: { scope?: string[] } = {};
    store.setScope(() => cur.scope);
    expect(store.list().map((i) => i.id)).toEqual([pilot.id, tati.id]);
    let fired = 0;
    store.onDidChange(() => fired++);
    cur.scope = [tati.baseUrl];
    store.scopeChanged();
    expect(fired).toBe(1);
    expect(store.list().map((i) => i.id)).toEqual([tati.id]);
    expect(store.all()).toHaveLength(2);
    expect(store.get(pilot.id)?.name).toBe('Pilot');
    expect(store.visible(pilot.id)).toBe(false);
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
