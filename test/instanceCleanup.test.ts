import { describe, expect, it } from 'vitest';
import { FilterState, SAVED_KEY, STATE_KEY } from '../src/state/filters';
import { INSTANCES_KEY, InstanceStore } from '../src/state/instances';
import { forgetInstance, watchRemovedInstances } from '../src/state/instanceCleanup';
import { SectionProject } from '../src/state/sectionProject';

const mem = (init: Record<string, unknown> = {}) => {
  const m = new Map(Object.entries(init));
  return {
    m,
    get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d),
    update: async (k: string, v: unknown) => void (v === undefined ? m.delete(k) : m.set(k, JSON.parse(JSON.stringify(v)))),
  };
};
const secrets = { get: async () => undefined, store: async () => undefined, delete: async () => undefined };
const a = { id: 'a', name: 'A', baseUrl: 'https://a.test', kind: 'dc' as const };
const b = { id: 'b', name: 'B', baseUrl: 'https://b.test', kind: 'dc' as const };

describe('отключение инстанса: сохранённые фильтры', () => {
  it('deleteFiltersOf удаляет фильтры инстанса одним update, без instanceId и чужие остаются', async () => {
    const m = mem({
      [SAVED_KEY]: [
        { id: '1', name: 'A1', jql: 'x', instanceId: 'a' },
        { id: '2', name: 'B1', jql: 'y', instanceId: 'b' },
        { id: '3', name: 'Any', jql: 'z' },
        { id: '4', name: 'A2', jql: 'w', instanceId: 'a' },
      ],
    });
    let updates = 0;
    const counting = { ...m, update: async (k: string, v: unknown) => { updates++; await m.update(k, v); } };
    const f = new FilterState(counting as never);
    let fired = 0;
    f.onDidChangeSaved(() => fired++);
    expect(await f.deleteFiltersOf('a')).toBe(2);
    expect(updates).toBe(1);
    expect(f.listSaved().map((x) => x.id)).toEqual(['2', '3']);
    expect(fired).toBe(1);
  });

  it('нечего удалять — запись и событие не нужны', async () => {
    const m = mem({ [SAVED_KEY]: [{ id: '3', name: 'Any', jql: 'z' }] });
    let updates = 0;
    const f = new FilterState({ ...m, update: async () => void updates++ } as never);
    expect(await f.deleteFiltersOf('a')).toBe(0);
    expect(updates).toBe(0);
  });
});

describe('отключение инстанса: проекты', () => {
  it('проект режима «Проект» с этим инстансом сбрасывается, режим и чужой проект остаются', async () => {
    const local = mem();
    const f = new FilterState(mem() as never, local as never);
    f.setProject({ instanceId: 'a', key: 'ABC' });
    await f.forgetInstance('b');
    expect(f.snapshot.project).toEqual({ instanceId: 'a', key: 'ABC' });
    await f.forgetInstance('a');
    expect(f.snapshot.project).toBeUndefined();
    expect(f.snapshot.mode).toBe('project');
    expect(new FilterState(mem() as never, local as never).snapshot.project).toBeUndefined();
    expect(local.m.has(STATE_KEY)).toBe(true);
  });

  it('SectionProject: сбрасывает выбор workspace и глобальный запасной, чужой не трогает', async () => {
    const local = mem({ k: { instanceId: 'a', key: 'ABC' } });
    const global = mem({ k: { instanceId: 'a', key: 'OLD' } });
    const sp = new SectionProject(local as never, 'k', global as never);
    let fired = 0;
    sp.onDidChange(() => fired++);
    await sp.forgetInstance('b');
    expect(sp.get()).toEqual({ instanceId: 'a', key: 'ABC' });
    expect(fired).toBe(0);
    await sp.forgetInstance('a');
    expect(sp.get()).toBeUndefined(); // не откатывается на запасной с тем же инстансом
    expect(fired).toBe(1);
  });

  it('SectionProject: выбор workspace — другого инстанса, а запасной указывает на удалённый — запасной очищается', async () => {
    const local = mem({ k: { instanceId: 'b', key: 'BBB' } });
    const global = mem({ k: { instanceId: 'a', key: 'OLD' } });
    const sp = new SectionProject(local as never, 'k', global as never);
    await sp.forgetInstance('a');
    expect(sp.get()).toEqual({ instanceId: 'b', key: 'BBB' });
    expect(global.m.has('k')).toBe(false);
  });
});

describe('watchRemovedInstances + forgetInstance на настоящем InstanceStore', () => {
  const setup = async () => {
    const st = mem({ [INSTANCES_KEY]: [a, b] });
    const store = new InstanceStore(st as never, secrets as never);
    const g = mem({
      [SAVED_KEY]: [{ id: '1', name: 'A1', jql: 'x', instanceId: 'a' }, { id: '2', name: 'Any', jql: 'z' }, { id: '3', name: 'B1', jql: 'y', instanceId: 'b' }],
    });
    const filters = new FilterState(g as never, mem() as never);
    filters.setProject({ instanceId: 'a', key: 'ABC' });
    const epic = new SectionProject(mem({ e: { instanceId: 'a', key: 'E' } }) as never, 'e');
    const rel = new SectionProject(mem({ r: { instanceId: 'b', key: 'R' } }) as never, 'r');
    const removed: string[] = [];
    const sub = watchRemovedInstances(store, (id) => { removed.push(id); void forgetInstance(id, [filters, epic, rel]); });
    return { store, filters, epic, rel, removed, sub };
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('remove: фильтры, проект и проект эпиков чистятся; релизы другого инстанса и фильтры без instanceId остаются', async () => {
    const { store, filters, epic, rel, removed } = await setup();
    await store.remove('a');
    await settle();
    expect(removed).toEqual(['a']);
    expect(filters.listSaved().map((f) => f.id)).toEqual(['2', '3']);
    expect(filters.snapshot.project).toBeUndefined();
    expect(epic.get()).toBeUndefined();
    expect(rel.get()).toEqual({ instanceId: 'b', key: 'R' });
  });

  it('смена набора workspace и обновление caps удалением не считаются', async () => {
    const { store, removed, filters } = await setup();
    store.setScope(() => ['b']);
    store.scopeChanged();
    await store.updateCaps('a', { serverVersion: '9', checkedAt: '2026-01-01T00:00:00Z', tempo: false, epicLinkField: undefined } as never);
    await store.add({ ...a, name: 'A renamed' }, 'tok');
    await settle();
    expect(removed).toEqual([]);
    expect(filters.listSaved()).toHaveLength(3);
  });

  it('после dispose не реагирует', async () => {
    const { store, removed, sub } = await setup();
    sub.dispose();
    await store.remove('b');
    expect(removed).toEqual([]);
  });

  it('сбой одного хранилища не мешает остальным', async () => {
    const calls: string[] = [];
    await forgetInstance('a', [
      { forgetInstance: async () => { throw new Error('boom'); } },
      { forgetInstance: async (id) => void calls.push(id) },
    ]);
    expect(calls).toEqual(['a']);
  });
});
