import * as vscode from 'vscode';
import type { Instance } from '../jira/types';
import { buildJql, isIssueKey, SORT_FIELDS, type IssueSort, type Mode, type QuickFilters } from '../jql';
import { instancesApply, projectsApply, type FilterState } from '../state/filters';
import type { InstanceStore } from '../state/instances';
import { matchInstancesByKey, unionNames, type InstanceMeta } from '../state/meta';
import { jqlForInstance } from '../state/query';
import { isIssueRef, type IssuePanelManager } from '../panels/issuePanel';
import { isIssueKey as isCardKey } from '../panels/protocol';
import { CATEGORY_LABEL, hostOf } from '../views/format';
import { savedFilterIdOf, type ApplyFilterArg } from '../views/filtersTree';
import { sortLabel, type IssueRef, type IssuesTree } from '../views/issuesTree';
import { t } from '../l10n';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const withProgress = <T>(title: string, task: () => Promise<T>): Thenable<T> =>
  vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);

const modeLabel = (m: Mode): string => (m === 'mine' ? t('Assigned to Me') : m === 'project' ? t('Project') : 'JQL');

/** Результаты по инстансам: упавшие не мешают остальным, список ошибок показываем одним предупреждением. */
export async function perInstance<T>(instances: Instance[], load: (i: Instance) => Promise<T>): Promise<{ ok: [Instance, T][]; failed: string[] }> {
  const res = await Promise.allSettled(instances.map(load));
  const ok: [Instance, T][] = [];
  const failed: string[] = [];
  res.forEach((r, idx) => {
    if (r.status === 'fulfilled') ok.push([instances[idx], r.value]);
    else failed.push(`«${instances[idx].name}»: ${errText(r.reason)}`);
  });
  return { ok, failed };
}

/**
 * Ключ задачи (аргумент или InputBox) → `IssueRef`: инстанс по префиксу проекта (кэш проектов), при неоднозначности — QuickPick.
 * Общий для `openIssueByKey` и `logWork` из палитры без открытой карточки.
 */
export async function pickIssueRef(store: InstanceStore, meta: InstanceMeta, arg?: unknown, title = t('Open Issue by Key')): Promise<IssueRef | undefined> {
  const all = store.list();
  if (!all.length) {
    const act = await vscode.window.showInformationMessage(t('Jiraffe: no instances yet'), t('Add'));
    if (act) await vscode.commands.executeCommand('jiraffe.addInstance');
    return undefined;
  }
  let key = typeof arg === 'string' ? arg : undefined;
  if (!key) {
    key = await vscode.window.showInputBox({
      title,
      prompt: t('For example ABC-123'),
      validateInput: (v) => (isIssueKey(v) ? undefined : t('A key like ABC-123')),
    });
  }
  if (!key) return undefined;
  key = key.trim().toUpperCase();
  if (!isIssueKey(key)) {
    void vscode.window.showWarningMessage(t('Jiraffe: “{0}” is not an issue key (expected like ABC-123)', key.slice(0, 64)));
    return undefined;
  }
  let target: Instance | undefined;
  if (all.length === 1) {
    target = all[0];
  } else {
    const { ok } = await withProgress(t('Jiraffe: detecting the instance by key…'), () => perInstance(all, (i) => meta.projects(i)));
    const matches = matchInstancesByKey(key, new Map(ok.map(([i, ps]) => [i.id, ps])));
    if (matches.length === 1) target = store.get(matches[0]);
    else {
      const pool = matches.length ? all.filter((i) => matches.includes(i.id)) : all;
      const picked = await vscode.window.showQuickPick(
        pool.map((i) => ({ label: i.name, description: hostOf(i.baseUrl), instance: i })),
        { placeHolder: matches.length ? t('Project {0} exists on several instances — which one?', key.split('-')[0]) : t('Project {0} not found — which instance should {1} be searched on?', key.split('-')[0], key) },
      );
      target = picked?.instance;
    }
  }
  return target ? { instanceId: target.id, key } : undefined;
}

export function registerFilterCommands(
  store: InstanceStore,
  filters: FilterState,
  meta: InstanceMeta,
  issues: IssuesTree,
  refreshFilters: () => void,
  panels: IssuePanelManager,
  /** Что ещё обновить по `jiraffe.refresh` (сводка «сегодня» — этап 6). */
  onRefresh: () => void = () => undefined,
): vscode.Disposable[] {
  const needInstances = async (): Promise<Instance[] | undefined> => {
    const all = store.list();
    if (!all.length) {
      const act = await vscode.window.showInformationMessage(t('Jiraffe: no instances yet'), t('Add'));
      if (act) await vscode.commands.executeCommand('jiraffe.addInstance');
      return undefined;
    }
    return all;
  };

  async function pickProject(): Promise<boolean> {
    const all = await needInstances();
    if (!all) return false;
    const { ok, failed } = await withProgress(t('Jiraffe: loading projects…'), () => perInstance(all, (i) => meta.projects(i)));
    if (failed.length) void vscode.window.showWarningMessage(t('Jiraffe: projects failed to load — {0}', failed.join('; ')));
    type Item = vscode.QuickPickItem & { sel?: { instanceId: string; key: string } };
    const items: Item[] = [];
    for (const [inst, projects] of ok) {
      if (ok.length > 1) items.push({ label: inst.name, kind: vscode.QuickPickItemKind.Separator });
      for (const p of [...projects].sort((a, b) => a.key.localeCompare(b.key))) {
        items.push({ label: p.key, description: p.name, detail: ok.length > 1 ? hostOf(inst.baseUrl) : undefined, sel: { instanceId: inst.id, key: p.key } });
      }
    }
    if (!items.length) {
      void vscode.window.showInformationMessage(t('Jiraffe: no projects found'));
      return false;
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: t('Project'), matchOnDescription: true });
    if (!picked?.sel) return false;
    filters.setProject(picked.sel);
    return true;
  }

  /**
   * Конвертирует текущий вид в JQL и даёт отредактировать. В JQL запекаются режим и категории статуса; типы, приоритеты,
   * поиск и выбор инстансов остаются быстрыми фильтрами поверх запроса — они зависят от инстанса (сужение типов,
   * ключ vs текст), запечённые дали бы 400 там, где такого типа нет.
   */
  async function editJql(): Promise<void> {
    const snap = filters.snapshot;
    const converting = snap.mode !== 'jql';
    const current = converting
      ? buildJql({ mode: snap.mode, projectKey: snap.project?.key, quick: { statusCategory: snap.quick.statusCategory } })
      : snap.jql;
    const jql = await vscode.window.showInputBox({
      title: 'JQL',
      prompt: converting
        ? t('The current view was converted to JQL; edit as needed. Types, priorities and search stay as quick filters on top of the query')
        : t('The query runs on all selected instances (unless the filter is bound to one)'),
      value: current,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : t('The query is empty')),
    });
    if (jql === undefined) return;
    const scope = converting ? (snap.mode === 'project' ? snap.project?.instanceId : undefined) : snap.jqlScope;
    // привязка к удалённому инстансу не переживает правку — иначе дерево так и останется пустым
    filters.setJql(jql.trim(), { scope: scope && store.get(scope) ? scope : undefined, baked: converting ? 'categories' : undefined });
  }

  /** Выбор сортировки «Задач». Повторный выбор текущей — сменить направление. */
  async function sortIssues(): Promise<void> {
    const cur = issues.sort;
    type Item = vscode.QuickPickItem & { sort?: IssueSort };
    const items: Item[] = [
      {
        label: t('Default'),
        description: t('ORDER BY from the JQL, otherwise by updated date'),
        iconPath: new vscode.ThemeIcon(cur ? 'blank' : 'check'),
      },
      ...SORT_FIELDS.map((field): Item => {
        const active = cur?.field === field;
        // Даты и номера — свежие сверху, приоритет — срочные сверху; у текущей — обратное направление.
        const desc = active ? !cur.desc : true;
        return {
          label: sortLabel(field),
          description: active ? `${cur.desc ? '↓' : '↑'} · ${t('select again to reverse')}` : undefined,
          iconPath: new vscode.ThemeIcon(active ? 'check' : 'blank'),
          sort: { field, desc },
        };
      }),
    ];
    const pick = await vscode.window.showQuickPick(items, { title: t('Sort Issues') });
    if (pick) issues.setSort(pick.sort);
  }

  async function quickFilters(): Promise<void> {
    const all = await needInstances();
    if (!all) return;
    const snap = filters.snapshot;
    const { ok, failed } = await withProgress(t('Jiraffe: loading types and priorities…'), async () => ({
      types: await perInstance(all, (i) => meta.types(i)),
      prios: await perInstance(all, (i) => meta.priorities(i)),
      projects: projectsApply(snap) ? await perInstance(all, (i) => meta.projects(i)) : { ok: [], failed: [] },
    })).then((r) => ({ ok: r, failed: [...r.types.failed, ...r.prios.failed, ...r.projects.failed] }));
    if (failed.length) void vscode.window.showWarningMessage(t('Jiraffe: lookups failed to load — {0}', [...new Set(failed)].join('; ')));

    type Group = 'status' | 'type' | 'prio' | 'inst' | 'proj';
    type Item = vscode.QuickPickItem & { group?: Group; value?: string };
    const items: Item[] = [{ label: t('Status'), kind: vscode.QuickPickItemKind.Separator }];
    for (const c of ['new', 'indeterminate', 'done'] as const) {
      items.push({ label: CATEGORY_LABEL[c], group: 'status', value: c, picked: snap.quick.statusCategory.includes(c) });
    }
    const types = unionNames(ok.types.ok.map(([, tp]) => tp));
    const prios = unionNames(ok.prios.ok.map(([, p]) => p));
    // выбранное ранее, но пропавшее из справочников (инстанс упал) — оставляем, чтобы не терять молча
    const keep = (sel: string[], have: string[]): string[] => [...have, ...sel.filter((s) => !have.some((h) => h.toLowerCase() === s.toLowerCase()))];
    const typeNames = keep(snap.quick.types, types);
    const prioNames = keep(snap.quick.priorities, prios);
    if (typeNames.length) items.push({ label: t('Type'), kind: vscode.QuickPickItemKind.Separator });
    for (const tp of typeNames) items.push({ label: tp, group: 'type', value: tp, picked: snap.quick.types.some((x) => x.toLowerCase() === tp.toLowerCase()) });
    if (prioNames.length) items.push({ label: t('Priority'), kind: vscode.QuickPickItemKind.Separator });
    for (const p of prioNames) items.push({ label: p, group: 'prio', value: p, picked: snap.quick.priorities.some((x) => x.toLowerCase() === p.toLowerCase()) });
    // в режиме «проект» и у JQL из фильтра инстанс один — группу не показываем, выбор сохраняем как был
    const instGroup = all.length > 1 && instancesApply(snap);
    if (instGroup) {
      items.push({ label: t('Instance'), kind: vscode.QuickPickItemKind.Separator });
      for (const i of all) items.push({ label: i.name, description: hostOf(i.baseUrl), group: 'inst', value: i.id, picked: snap.instances.includes(i.id) });
    }
    // в режиме «проект» группа не нужна; проектов бывает много — она последняя, чтобы не закапывать остальные
    const projGroup = projectsApply(snap);
    if (projGroup) {
      const byKey = new Map<string, { name: string; hosts: string[] }>();
      for (const [inst, ps] of ok.projects.ok) {
        for (const p of ps) {
          const k = p.key.toUpperCase();
          const e = byKey.get(k) ?? byKey.set(k, { name: p.name, hosts: [] }).get(k)!;
          e.hosts.push(hostOf(inst.baseUrl));
        }
      }
      for (const k of snap.quick.projects) if (!byKey.has(k.toUpperCase())) byKey.set(k.toUpperCase(), { name: '', hosts: [] });
      if (byKey.size) items.push({ label: t('Project'), kind: vscode.QuickPickItemKind.Separator });
      const picked = new Set(snap.quick.projects.map((k) => k.toUpperCase()));
      for (const [k, e] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
        const description = all.length > 1 && e.hosts.length ? [e.name, ...e.hosts].filter(Boolean).join(' · ') : e.name;
        items.push({ label: k, description, group: 'proj', value: k, picked: picked.has(k) });
      }
    }

    const picked = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: t('Quick Filters (OR within a group, AND between groups)'), matchOnDescription: true });
    if (!picked) return;
    const by = (g: Group): string[] => picked.filter((p) => p.group === g).map((p) => p.value!);
    const quick: QuickFilters = {
      statusCategory: by('status') as QuickFilters['statusCategory'],
      types: by('type'),
      priorities: by('prio'),
      projects: projGroup ? by('proj') : snap.quick.projects,
    };
    const insts = by('inst');
    filters.setQuick(quick, !instGroup ? snap.instances : insts.length === all.length ? [] : insts); // «все» = без ограничения
  }

  async function search(): Promise<void> {
    const text = await vscode.window.showInputBox({
      title: t('Search'),
      prompt: t('Text (searched in summary, description, comments) or an issue key like ABC-123. Empty clears the search'),
      value: filters.snapshot.text,
    });
    if (text !== undefined) filters.setText(text.trim());
  }

  async function saveFilter(): Promise<void> {
    const snap = filters.snapshot;
    if (snap.mode === 'project' && !snap.project) {
      void vscode.window.showInformationMessage(t('Jiraffe: choose a project first'));
      return;
    }
    // Привязка к инстансу: проект, JQL из фильтра инстанса или единственный выбранный инстанс.
    const chosen = instancesApply(snap) ? snap.instances.filter((id) => store.get(id)) : [];
    const scope = snap.mode === 'project' ? snap.project?.instanceId : snap.mode === 'jql' && snap.jqlScope ? snap.jqlScope : chosen.length === 1 ? chosen[0] : undefined;
    const scopeInst = scope ? store.get(scope) : undefined;
    // С привязкой — JQL как для этого инстанса (типы сужены, ключ/текст решены); без неё — как есть.
    const jql = (scopeInst ? await jqlForInstance(snap, scopeInst, meta).catch(() => null) : null)
      ?? buildJql({ mode: snap.mode, projectKey: snap.project?.key, jql: snap.jql, quick: snap.quick, text: snap.text });
    const name = await vscode.window.showInputBox({
      title: t('Save as Filter'),
      prompt: jql,
      value: snap.savedName,
      validateInput: (v) => (v.trim() ? undefined : t('The name is empty')),
    });
    if (!name) return;
    const f = await filters.saveFilter(name.trim(), jql, scopeInst?.id);
    filters.setJql(f.jql, { scope: scopeInst?.id, savedName: f.name, baked: 'all' });
    void vscode.window.showInformationMessage(t('Jiraffe: filter “{0}” saved', f.name));
  }

  async function openByKey(arg?: unknown): Promise<void> {
    const ref = await pickIssueRef(store, meta, arg);
    if (ref) await vscode.commands.executeCommand('jiraffe.openIssue', ref);
  }

  return [
    vscode.commands.registerCommand('jiraffe.setMode', async (arg?: unknown) => {
      let mode: Mode | undefined = arg === 'mine' || arg === 'project' || arg === 'jql' ? arg : undefined;
      if (!mode) {
        const cur = filters.snapshot.mode;
        const picked = await vscode.window.showQuickPick(
          (['mine', 'project', 'jql'] as Mode[]).map((m) => ({ label: modeLabel(m), description: m === cur ? t('current') : undefined, mode: m })),
          { placeHolder: t('Issue list mode') },
        );
        mode = picked?.mode;
      }
      if (!mode) return;
      if (mode === 'project' && !filters.snapshot.project) {
        await pickProject();
        return;
      }
      if (mode === 'jql' && !filters.snapshot.jql.trim()) {
        await editJql();
        return;
      }
      filters.setMode(mode);
    }),
    vscode.commands.registerCommand('jiraffe.pickProject', () => pickProject()),
    vscode.commands.registerCommand('jiraffe.quickFilters', () => quickFilters()),
    vscode.commands.registerCommand('jiraffe.editJql', () => editJql()),
    vscode.commands.registerCommand('jiraffe.search', () => search()),
    vscode.commands.registerCommand('jiraffe.resetFilters', () => filters.reset(store.list().map((i) => i.id))),
    vscode.commands.registerCommand('jiraffe.applyFilter', (arg?: ApplyFilterArg) => {
      if (!arg || typeof arg.jql !== 'string') return;
      filters.setJql(arg.jql, { scope: arg.instanceId, savedName: arg.name });
    }),
    vscode.commands.registerCommand('jiraffe.saveFilter', () => saveFilter()),
    vscode.commands.registerCommand('jiraffe.deleteFilter', async (node?: unknown) => {
      const id = savedFilterIdOf(node);
      if (!id) return;
      const f = filters.listSaved().find((x) => x.id === id);
      if (!f) return;
      const ok = await vscode.window.showWarningMessage(t('Delete filter “{0}”?', f.name), { modal: true }, t('Delete'));
      if (ok === t('Delete')) await filters.deleteFilter(id);
    }),
    vscode.commands.registerCommand('jiraffe.sortIssues', () => sortIssues()),
    vscode.commands.registerCommand('jiraffe.groupIssues', () => issues.setGrouped(true)),
    vscode.commands.registerCommand('jiraffe.ungroupIssues', () => issues.setGrouped(false)),
    vscode.commands.registerCommand('jiraffe.loadMore', (instanceId: unknown) => (typeof instanceId === 'string' ? issues.loadMore(instanceId) : undefined)),
    vscode.commands.registerCommand('jiraffe.openIssueByKey', (key?: unknown) => openByKey(key)),
    vscode.commands.registerCommand('jiraffe.openIssue', (ref?: unknown) => {
      if (isIssueRef(ref) && isCardKey(ref.key)) panels.open({ instanceId: ref.instanceId, key: ref.key });
    }),
    vscode.commands.registerCommand('jiraffe.refresh', () => {
      meta.invalidate();
      issues.refresh();
      refreshFilters();
      onRefresh();
    }),
  ];
}
