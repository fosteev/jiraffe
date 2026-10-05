import { describe, expect, it } from 'vitest';
import { InstanceStore } from '../src/state/instances';
import { activeFilterCount, describeFilters, emptyQuick, FilterState, sanitizeSnapshot } from '../src/state/filters';
import { jqlForInstance } from '../src/state/query';
import { InstanceMeta, intersectNames, keyPrefix, matchInstancesByKey, unionNames } from '../src/state/meta';
import { countLabel, mdEscape, tooltipMarkdown } from '../src/views/format';

const mem = (init: Record<string, unknown> = {}) => {
  const m = new Map(Object.entries(init));
  return { get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d), update: async (k: string, v: unknown) => void m.set(k, JSON.parse(JSON.stringify(v))) };
};

describe('FilterState', () => {
  it('значения по умолчанию и сохранение в memento', async () => {
    const m = mem();
    const f = new FilterState(m as never);
    expect(f.snapshot.mode).toBe('mine');
    f.setProject({ instanceId: 'a', key: 'ABC' });
    f.setQuick({ statusCategory: ['new'], types: ['Bug'], priorities: [], projects: [] }, ['a']);
    const again = new FilterState(m as never);
    expect(again.snapshot.mode).toBe('project');
    expect(again.snapshot.project).toEqual({ instanceId: 'a', key: 'ABC' });
    expect(again.snapshot.quick.types).toEqual(['Bug']);
  });

  it('битое состояние не ломает загрузку', () => {
    expect(sanitizeSnapshot('мусор').mode).toBe('mine');
    const s = sanitizeSnapshot({ mode: 'x', quick: { statusCategory: ['new', 'boom', 5], types: 'Bug' }, project: { key: 'A' }, instances: [1, 'a'] });
    expect(s.mode).toBe('mine');
    expect(s.quick.statusCategory).toEqual(['new']);
    expect(s.quick.types).toEqual([]);
    expect(s.project).toBeUndefined();
    expect(s.instances).toEqual(['a']);
  });

  it('activeInstanceIds: режимы, фильтр по инстансам, несуществующие отбрасываются', () => {
    const f = new FilterState(mem() as never);
    expect(f.activeInstanceIds(['a', 'b'])).toEqual(['a', 'b']);
    f.setQuick(emptyQuick(), ['b', 'gone']);
    expect(f.activeInstanceIds(['a', 'b'])).toEqual(['b']);
    f.setQuick(emptyQuick(), ['gone']);
    expect(f.activeInstanceIds(['a', 'b'])).toEqual(['a', 'b']);
    f.setProject({ instanceId: 'a', key: 'ABC' });
    expect(f.activeInstanceIds(['a', 'b'])).toEqual(['a']);
    expect(f.activeInstanceIds(['b'])).toEqual([]);
    f.setJql('x = 1', { scope: 'b' });
    expect(f.activeInstanceIds(['a', 'b'])).toEqual(['b']);
    f.setJql('x = 1');
    expect(f.activeInstanceIds(['a', 'b'])).toEqual(['a', 'b']); // без scope — опять все (выбор инстансов 'gone' устарел)
  });

  it('reset не трогает режим и проект', () => {
    const f = new FilterState(mem() as never);
    f.setProject({ instanceId: 'a', key: 'ABC' });
    f.setText('foo');
    f.setQuick({ statusCategory: ['done'], types: [], priorities: [], projects: [] }, ['a']);
    f.reset();
    expect(f.snapshot.text).toBe('');
    expect(activeFilterCount(f.snapshot)).toBe(0);
    expect(f.snapshot.project?.key).toBe('ABC');
    expect(f.snapshot.mode).toBe('project');
  });

  it('reset(existing) снимает ссылки на удалённые инстансы', () => {
    const f = new FilterState(mem() as never);
    f.setProject({ instanceId: 'gone', key: 'ABC' });
    f.reset(['a']);
    expect(f.snapshot.mode).toBe('project');
    expect(f.snapshot.project).toBeUndefined();
    f.setJql('x = 1', { scope: 'gone' });
    f.reset(['a']);
    expect(f.snapshot.jqlScope).toBeUndefined();
    expect(f.activeInstanceIds(['a'])).toEqual(['a']);
    f.setJql('x = 1', { scope: 'a' });
    f.reset(['a']);
    expect(f.snapshot.jqlScope).toBe('a');
  });

  it('setJql baked: категории или всё; выбор инстансов остаётся', () => {
    const f = new FilterState(mem() as never);
    f.setQuick({ statusCategory: ['new'], types: ['Bug'], priorities: ['High'], projects: [] }, ['a']);
    f.setText('foo');
    f.setJql('x = 1', { baked: 'categories' });
    expect(f.snapshot.quick).toEqual({ statusCategory: [], types: ['Bug'], priorities: ['High'], projects: [] });
    expect(f.snapshot.text).toBe('foo');
    expect(f.snapshot.instances).toEqual(['a']);
    f.setJql('x = 2', { baked: 'all' });
    expect(f.snapshot.quick).toEqual(emptyQuick());
    expect(f.snapshot.text).toBe('');
    expect(f.snapshot.instances).toEqual(['a']);
  });

  it('локальные фильтры: сохранить, прочитать, удалить; слушатели раздельные', async () => {
    const f = new FilterState(mem() as never);
    let snap = 0;
    let saved = 0;
    f.onDidChange(() => snap++);
    f.onDidChangeSaved(() => saved++);
    const s = await f.saveFilter('Мой', 'project = ABC', 'a');
    expect(f.listSaved()).toEqual([{ id: s.id, name: 'Мой', jql: 'project = ABC', instanceId: 'a' }]);
    await f.deleteFilter(s.id);
    expect(f.listSaved()).toEqual([]);
    expect(saved).toBe(2);
    expect(snap).toBe(0); // дерево задач не перезагружается от правки списка фильтров
  });

  it('упавший слушатель не ломает изменение', () => {
    const f = new FilterState(mem() as never);
    f.onDidChange(() => {
      throw new Error('x');
    });
    f.setText('a');
    expect(f.snapshot.text).toBe('a');
  });
});

describe('describeFilters', () => {
  const base = () => new FilterState(mem() as never);
  it('«2 фильтра · HOME»', () => {
    const f = base();
    f.setProject({ instanceId: 'a', key: 'HOME' });
    f.setQuick({ statusCategory: ['new', 'done'], types: [], priorities: [], projects: [] }, []);
    expect(describeFilters(f.snapshot)).toBe('2 filters · HOME');
  });
  it('склонения и режимы', () => {
    const f = base();
    expect(describeFilters(f.snapshot)).toBe('assigned to me');
    f.setText('x');
    expect(describeFilters(f.snapshot)).toBe('1 filter');
    f.setQuick({ statusCategory: ['new', 'done'], types: ['a', 'b', 'c'], priorities: [], projects: [] }, []);
    expect(describeFilters(f.snapshot)).toBe('6 filters');
    f.setJql('a = 1', { savedName: 'Баги' });
    expect(describeFilters(f.snapshot)).toBe('6 filters · “Баги”');
    f.setJql('a = 1');
    expect(describeFilters(f.snapshot)).toBe('6 filters · JQL');
    f.setMode('project');
    expect(describeFilters(f.snapshot)).toBe('6 filters · no project selected');
  });
  it('выбор инстансов не считается там, где не действует', () => {
    const f = base();
    f.setQuick(emptyQuick(), ['a']);
    expect(describeFilters(f.snapshot)).toBe('1 filter');
    f.setProject({ instanceId: 'b', key: 'HOME' });
    expect(describeFilters(f.snapshot)).toBe('HOME');
    f.setJql('x = 1', { scope: 'b' });
    expect(activeFilterCount(f.snapshot)).toBe(0);
  });
});

describe('meta helpers', () => {
  it('keyPrefix / matchInstancesByKey', () => {
    expect(keyPrefix('abc-12')).toBe('ABC');
    expect(keyPrefix('abc12')).toBeUndefined();
    const m = new Map([['a', [{ key: 'ABC' }, { key: 'XYZ' }]], ['b', [{ key: 'ABC' }]], ['c', [{ key: 'QQ' }]]]);
    expect(matchInstancesByKey('abc-1', m)).toEqual(['a', 'b']);
    expect(matchInstancesByKey('xyz-1', m)).toEqual(['a']);
    expect(matchInstancesByKey('zzz-1', m)).toEqual([]);
    expect(matchInstancesByKey('bad', m)).toEqual([]);
  });
  it('intersectNames / unionNames', () => {
    expect(intersectNames(['bug', 'Story', 'Nope'], [{ name: 'Bug' }, { name: 'Story' }])).toEqual(['Bug', 'Story']);
    expect(unionNames([[{ name: 'Bug' }, { name: 'Task' }], [{ name: 'bug' }, { name: 'Баг' }]])).toEqual(['Bug', 'Task', 'Баг']);
  });
});

describe('InstanceMeta', () => {
  const secrets = new Map([['jiraffe.token.a', 't']]);
  const store = new InstanceStore(mem() as never, { get: async (k: string) => secrets.get(k), store: async () => undefined, delete: async () => undefined } as never);
  const inst = { id: 'a', name: 'A', baseUrl: 'https://h.example', kind: 'dc' as const };

  it('кэширует успех, не кэширует ошибку, сбрасывается по изменению store', async () => {
    let calls = 0;
    let fail = true;
    const factory = (() => ({
      projects: async () => {
        calls++;
        if (fail) throw new Error('boom');
        return [{ id: '1', key: 'ABC', name: 'Abc' }];
      },
    })) as never;
    const meta = new InstanceMeta(store, factory);
    await expect(meta.projects(inst)).rejects.toThrow('boom');
    fail = false;
    expect((await meta.projects(inst))[0].key).toBe('ABC');
    await meta.projects(inst);
    expect(calls).toBe(2);
    meta.invalidate();
    await meta.projects(inst);
    expect(calls).toBe(3);
  });

  it('без токена — понятная ошибка', async () => {
    const meta = new InstanceMeta(store, (() => ({})) as never);
    await expect(meta.projects({ ...inst, id: 'zzz' })).rejects.toThrow('token not found');
  });
});

describe('format', () => {
  it('mdEscape глушит разметку', () => {
    expect(mdEscape('a *b* [c](d) <x>\nz')).toBe('a \\*b\\* \\[c\\]\\(d\\) \\<x\\> z');
  });
  it('countLabel', () => {
    expect(countLabel(5, 12, true)).toBe('12');
    expect(countLabel(5, undefined, true)).toBe('5+');
    expect(countLabel(3, undefined, false)).toBe('3');
  });
  it('tooltipMarkdown содержит ключ, статус и экранированное название', () => {
    const t = tooltipMarkdown({ instanceId: 'a', key: 'ABC-1', summary: 'Fix *it*', type: 'Bug', status: 'Open', statusCategory: 'new', updated: '2026-10-02T10:20:30.000+0300' }, 'Main');
    expect(t).toContain('ABC\\-1');
    expect(t).toContain('Fix \\*it\\*');
    expect(t).toContain('To Do');
    expect(t).toContain('unassigned');
  });
});

describe('jqlForInstance', () => {
  const inst = { id: 'a', name: 'A', baseUrl: 'https://h.example', kind: 'dc' as const };
  const snap = (types: string[], priorities: string[] = []) => {
    const f = new FilterState(mem() as never);
    f.setQuick({ statusCategory: ['new'], types, priorities, projects: [] }, []);
    return f.snapshot;
  };
  const meta = (types: string[] | Error, prios: string[] = ['High']) => ({
    types: async () => {
      if (types instanceof Error) throw types;
      return types.map((name) => ({ id: name, name }));
    },
    priorities: async () => prios.map((name) => ({ id: name, name })),
    projects: async () => [{ id: '1', key: 'ABC', name: 'Abc' }],
  });

  it('сужает типы до существующих на инстансе', async () => {
    expect(await jqlForInstance(snap(['bug', 'Баг']), inst, meta(['Bug', 'Task']))).toBe(
      'assignee = currentUser() AND resolution = Unresolved AND statusCategory in (1, 2) AND issuetype in ("Bug") ORDER BY updated DESC',
    );
  });
  it('нет подходящего типа — null', async () => {
    expect(await jqlForInstance(snap(['Баг']), inst, meta(['Bug']))).toBeNull();
    expect(await jqlForInstance(snap([], ['Urgent']), inst, meta(['Bug']))).toBeNull();
  });
  it('справочник недоступен — выбор как есть', async () => {
    expect(await jqlForInstance(snap(['Bug']), inst, meta(new Error('x')))).toContain('issuetype in ("Bug")');
  });
  it('без типов справочник не запрашивается', async () => {
    const m = { types: async () => { throw new Error('не должен вызываться'); }, priorities: async () => [], projects: async () => [] };
    expect(await jqlForInstance(snap([]), inst, m)).toContain('statusCategory in (1, 2)');
  });
  it('проекты сужаются до существующих на инстансе, в режиме «проект» не действуют', async () => {
    const withProjects = (projects: string[], mode?: 'project') => {
      const f = new FilterState(mem() as never);
      f.setQuick({ statusCategory: [], types: [], priorities: [], projects }, []);
      if (mode) f.setProject({ instanceId: 'a', key: 'ABC' });
      return f.snapshot;
    };
    expect(await jqlForInstance(withProjects(['abc', 'XYZ']), inst, meta([]))).toBe(
      'assignee = currentUser() AND resolution = Unresolved AND project in (ABC) ORDER BY updated DESC',
    );
    expect(await jqlForInstance(withProjects(['XYZ']), inst, meta([]))).toBeNull();
    expect(await jqlForInstance(withProjects(['XYZ'], 'project'), inst, meta([]))).toBe('project = ABC ORDER BY updated DESC');
    const f = new FilterState(mem() as never);
    f.setQuick({ statusCategory: [], types: [], priorities: [], projects: ['XYZ'] }, []);
    expect(activeFilterCount(f.snapshot)).toBe(1);
    f.setProject({ instanceId: 'a', key: 'ABC' });
    expect(activeFilterCount(f.snapshot)).toBe(0);
  });
  it('ключ ищется как ключ, только если проект есть на инстансе', async () => {
    const withText = (text: string) => {
      const f = new FilterState(mem() as never);
      f.setText(text);
      return f.snapshot;
    };
    expect(await jqlForInstance(withText('abc-7'), inst, meta([]))).toContain('(key = ABC-7 OR text ~');
    expect(await jqlForInstance(withText('utf-8'), inst, meta([]))).not.toContain('key =');
    expect(await jqlForInstance(withText('abc-7'), inst, meta([]), { textOnly: true })).not.toContain('key =');
    const broken = { ...meta([]), projects: async () => { throw new Error('x'); } };
    expect(await jqlForInstance(withText('abc-7'), inst, broken)).not.toContain('key =');
  });
});
