import * as vscode from 'vscode';
import type { FilterRef } from '../jira/client';
import type { FilterState, SavedFilter } from '../state/filters';
import type { InstanceMeta } from '../state/meta';
import type { InstanceStore } from '../state/instances';
import { hostOf } from './format';

/** Аргумент команды `jiraffe.applyFilter`. */
export interface ApplyFilterArg { name: string; jql: string; instanceId?: string }

type Node =
  | { kind: 'group'; id: 'mine' | 'jira'; label: string }
  | { kind: 'local'; filter: SavedFilter }
  | { kind: 'instance'; instanceId: string }
  | { kind: 'remote'; instanceId: string; filter: FilterRef }
  | { kind: 'hint'; id: string; text: string; error?: boolean };

interface Remote { loading: boolean; filters: FilterRef[]; error?: string }

export class FiltersTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly remote = new Map<string, Remote>();
  private readonly instNodes = new Map<string, Node>();
  private readonly subs: vscode.Disposable[];

  constructor(
    private readonly store: InstanceStore,
    private readonly filters: FilterState,
    private readonly meta: InstanceMeta,
  ) {
    this.subs = [
      this.emitter,
      store.onDidChange(() => this.refresh()),
      // применение фильтра меняет подсветку — перерисовываем, но избранные из Jira заново не грузим
      filters.onDidChange(() => this.emitter.fire(undefined)),
      filters.onDidChangeSaved(() => this.emitter.fire(undefined)),
    ];
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
  }

  /** Сбрасывает кэш избранных фильтров Jira и перечитывает. */
  refresh(): void {
    this.remote.clear();
    this.emitter.fire(undefined);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const snap = this.filters.snapshot;
    switch (n.kind) {
      case 'group': {
        const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `group:${n.id}`;
        return item;
      }
      case 'local': {
        const f = n.filter;
        const item = new vscode.TreeItem(f.name, vscode.TreeItemCollapsibleState.None);
        item.id = `local:${f.id}`;
        item.iconPath = new vscode.ThemeIcon('filter');
        const inst = f.instanceId ? this.store.get(f.instanceId) : undefined;
        item.description = inst?.name;
        item.tooltip = new vscode.MarkdownString(`\`${f.jql.replace(/`/g, "'")}\``);
        item.contextValue = 'localFilter';
        item.command = applyCommand({ name: f.name, jql: f.jql, instanceId: f.instanceId });
        if (snap.mode === 'jql' && snap.jql === f.jql && snap.savedName === f.name) item.description = `${item.description ?? ''} ✓`.trim();
        return item;
      }
      case 'instance': {
        const inst = this.store.get(n.instanceId);
        const r = this.remote.get(n.instanceId);
        const item = new vscode.TreeItem(inst?.name ?? n.instanceId, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `finst:${n.instanceId}`;
        item.iconPath = new vscode.ThemeIcon('server');
        item.description = inst ? hostOf(inst.baseUrl) + (r?.loading ? ' · загрузка…' : '') : '';
        return item;
      }
      case 'remote': {
        const f = n.filter;
        const item = new vscode.TreeItem(f.name, vscode.TreeItemCollapsibleState.None);
        item.id = `remote:${n.instanceId}:${f.id}`;
        item.iconPath = new vscode.ThemeIcon('star-full');
        item.tooltip = new vscode.MarkdownString(`\`${f.jql.replace(/`/g, "'")}\``);
        item.contextValue = 'jiraFilter';
        item.command = applyCommand({ name: f.name, jql: f.jql, instanceId: n.instanceId });
        if (snap.mode === 'jql' && snap.jql === f.jql && snap.savedName === f.name) item.description = '✓';
        return item;
      }
      case 'hint': {
        const item = new vscode.TreeItem(n.text, vscode.TreeItemCollapsibleState.None);
        item.id = `fhint:${n.id}`;
        if (n.error) item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        return item;
      }
    }
  }

  getChildren(n?: Node): Node[] {
    if (!n) {
      return [
        { kind: 'group', id: 'mine', label: 'Мои' },
        { kind: 'group', id: 'jira', label: 'Избранные в Jira' },
      ];
    }
    if (n.kind === 'group' && n.id === 'mine') {
      const list = this.filters.listSaved();
      return list.length
        ? list.map((filter): Node => ({ kind: 'local', filter }))
        : [{ kind: 'hint', id: 'no-local', text: 'Нет сохранённых — «Сохранить как фильтр»' }];
    }
    if (n.kind === 'group') {
      const insts = this.store.list();
      if (!insts.length) return [{ kind: 'hint', id: 'no-inst', text: 'Нет инстансов' }];
      return insts.map((i): Node => {
        let node = this.instNodes.get(i.id);
        if (!node) this.instNodes.set(i.id, (node = { kind: 'instance', instanceId: i.id }));
        return node;
      });
    }
    if (n.kind === 'instance') {
      const r = this.remote.get(n.instanceId);
      if (!r) {
        void this.loadRemote(n.instanceId);
        return [{ kind: 'hint', id: `load:${n.instanceId}`, text: 'Загрузка…' }];
      }
      if (r.loading) return [{ kind: 'hint', id: `load:${n.instanceId}`, text: 'Загрузка…' }];
      if (r.error) return [{ kind: 'hint', id: `err:${n.instanceId}`, text: r.error, error: true }];
      if (!r.filters.length) return [{ kind: 'hint', id: `none:${n.instanceId}`, text: 'Нет избранных фильтров' }];
      return r.filters.map((filter): Node => ({ kind: 'remote', instanceId: n.instanceId, filter }));
    }
    return [];
  }

  private async loadRemote(instanceId: string): Promise<void> {
    const inst = this.store.get(instanceId);
    if (!inst || this.remote.has(instanceId)) return;
    const r: Remote = { loading: true, filters: [] };
    this.remote.set(instanceId, r);
    try {
      r.filters = (await (await this.meta.client(inst)).favouriteFilters()).filter((f) => f.jql.trim());
    } catch (e) {
      if (this.remote.get(instanceId) !== r) return;
      r.error = e instanceof Error ? e.message : String(e);
    }
    if (this.remote.get(instanceId) !== r) return; // refresh успел сбросить кэш
    r.loading = false;
    this.emitter.fire(this.instNodes.get(instanceId));
  }
}

function applyCommand(arg: ApplyFilterArg): vscode.Command {
  return { command: 'jiraffe.applyFilter', title: 'Применить фильтр', arguments: [arg] };
}

/** Фильтр из контекстного меню: аргумент — узел дерева. */
export function savedFilterIdOf(node: unknown): string | undefined {
  const n = node as { kind?: string; filter?: SavedFilter } | undefined;
  return n?.kind === 'local' ? n.filter?.id : undefined;
}
