import * as vscode from 'vscode';
import { JiraError } from '../jira/http';
import type { IssueSummary, SearchPage } from '../jira/types';
import { t } from '../l10n';
import { isIssueKey } from '../jql';
import { describeFilters, type FilterState } from '../state/filters';
import type { InstanceMeta } from '../state/meta';
import type { InstanceStore } from '../state/instances';
import { jqlForInstance } from '../state/query';
import { CATEGORY_ICON, countLabel, hostOf, tooltipMarkdown } from './format';

export interface IssueRef { instanceId: string; key: string }

type Node =
  | { kind: 'instance'; id: string }
  | { kind: 'issue'; instanceId: string; issue: IssueSummary }
  | { kind: 'more'; instanceId: string }
  | { kind: 'error'; instanceId: string; message: string; query: boolean }
  | { kind: 'hint'; id: string; text: string }
  | { kind: 'byKey'; key: string };

interface InstState {
  loading: boolean;
  loadingMore: boolean;
  jql?: string;
  issues: IssueSummary[];
  next?: SearchPage['next'];
  total?: number;
  error?: string;
  /** Ошибка в запросе (400), а не в подключении — «Проверить подключение» не предлагаем. */
  queryError?: boolean;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const pageSize = (): number => vscode.workspace.getConfiguration('jiraffe').get<number>('maxResults', 50);

export class IssuesTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly states = new Map<string, InstState>();
  private readonly instNodes = new Map<string, Node>();
  private view?: vscode.TreeView<Node>;
  private gen = 0;
  private readonly subs: vscode.Disposable[];

  constructor(
    private readonly store: InstanceStore,
    private readonly filters: FilterState,
    private readonly meta: InstanceMeta,
  ) {
    this.subs = [
      this.emitter,
      store.onDidChange(() => this.refresh()),
      filters.onDidChange(() => this.refresh()),
    ];
  }

  attach(view: vscode.TreeView<Node>): void {
    this.view = view;
    this.updateHeader();
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
  }

  refresh(): void {
    this.gen++;
    this.states.clear();
    this.updateHeader();
    this.emitter.fire(undefined);
  }

  // ----- TreeDataProvider -----

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'instance': {
        const inst = this.store.get(n.id);
        const st = this.states.get(n.id);
        const item = new vscode.TreeItem(inst?.name ?? n.id, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `inst:${n.id}`;
        item.iconPath = new vscode.ThemeIcon(st?.error ? 'error' : 'server');
        const host = inst ? hostOf(inst.baseUrl) : '';
        item.description = !st || st.loading ? `${host} · ${t('loading…')}` : st.error ? host : `${host} · ${countLabel(st.issues.length, st.total, !!st.next)}`;
        item.tooltip = st?.jql ? new vscode.MarkdownString(`\`${st.jql.replace(/`/g, "'")}\``) : host;
        item.contextValue = 'instance';
        return item;
      }
      case 'issue': {
        const i = n.issue;
        const item = new vscode.TreeItem(`${i.key} ${i.summary}`, vscode.TreeItemCollapsibleState.None);
        item.id = `issue:${n.instanceId}:${i.key}`;
        item.description = i.status;
        const { icon, color } = CATEGORY_ICON[i.statusCategory];
        item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
        item.tooltip = new vscode.MarkdownString(tooltipMarkdown(i, this.store.get(n.instanceId)?.name ?? n.instanceId));
        item.contextValue = 'issue';
        item.command = { command: 'jiraffe.openIssue', title: t('Open Issue'), arguments: [{ instanceId: n.instanceId, key: i.key } satisfies IssueRef] };
        return item;
      }
      case 'more': {
        const st = this.states.get(n.instanceId);
        const item = new vscode.TreeItem(st?.loadingMore ? t('Loading more…') : t('Load More'), vscode.TreeItemCollapsibleState.None);
        item.id = `more:${n.instanceId}`;
        item.iconPath = new vscode.ThemeIcon(st?.loadingMore ? 'loading~spin' : 'ellipsis');
        item.description = st ? st.total !== undefined ? t('shown {0} of {1}', st.issues.length, st.total) : t('shown {0}', st.issues.length) : undefined;
        item.command = { command: 'jiraffe.loadMore', title: t('Load More'), arguments: [n.instanceId] };
        return item;
      }
      case 'error': {
        const item = new vscode.TreeItem(n.message, vscode.TreeItemCollapsibleState.None);
        item.id = `err:${n.instanceId}`;
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        if (n.query) {
          item.tooltip = `${n.message}\n\n${t('Query error — fix the JQL or filters')}`;
        } else {
          item.tooltip = `${n.message}\n\n${t('Click to test the connection')}`;
          item.command = { command: 'jiraffe.testConnection', title: t('Test Connection'), arguments: [n.instanceId] };
        }
        return item;
      }
      case 'hint': {
        const item = new vscode.TreeItem(n.text, vscode.TreeItemCollapsibleState.None);
        item.id = `hint:${n.id}`;
        return item;
      }
      case 'byKey': {
        const item = new vscode.TreeItem(t('Open {0} by key', n.key), vscode.TreeItemCollapsibleState.None);
        item.id = `bykey:${n.key}`;
        item.iconPath = new vscode.ThemeIcon('search');
        item.command = { command: 'jiraffe.openIssueByKey', title: t('Open by Key'), arguments: [n.key] };
        return item;
      }
    }
  }

  getChildren(n?: Node): Node[] {
    if (!n) return this.rootChildren();
    if (n.kind !== 'instance') return [];
    const st = this.states.get(n.id);
    if (!st || st.loading) return [{ kind: 'hint', id: `load:${n.id}`, text: t('Loading…') }];
    if (st.error) return [{ kind: 'error', instanceId: n.id, message: st.error, query: !!st.queryError }];
    if (!st.issues.length) return [{ kind: 'hint', id: `empty:${n.id}`, text: this.filters.snapshot.mode === 'jql' ? t('No issues for this query') : t('Nothing matches the filter') }];
    return [
      ...st.issues.map((issue): Node => ({ kind: 'issue', instanceId: n.id, issue })),
      ...(st.next ? [{ kind: 'more', instanceId: n.id } as Node] : []),
    ];
  }

  // ----- загрузка -----

  private rootChildren(): Node[] {
    const snap = this.filters.snapshot;
    const all = this.store.list();
    if (!all.length) return [];
    const out: Node[] = [];
    const text = snap.text.trim();
    if (isIssueKey(text)) out.push({ kind: 'byKey', key: text.toUpperCase() });
    if (snap.mode === 'project' && !snap.project) return [...out, { kind: 'hint', id: 'no-project', text: t('Select a project (“Select Project” command)') }];
    if (snap.mode === 'jql' && !snap.jql.trim()) return [...out, { kind: 'hint', id: 'no-jql', text: t('Enter JQL (“Edit JQL” command)') }];
    const ids = this.filters.activeInstanceIds(all.map((i) => i.id));
    if (!ids.length) {
      const text = snap.mode === 'project' ? t('The project’s instance was removed — select a project') : t('The filter’s instance was removed — select a filter or “Reset Filters”');
      return [...out, { kind: 'hint', id: 'no-inst', text }];
    }
    for (const id of ids) {
      let node = this.instNodes.get(id);
      if (!node) this.instNodes.set(id, (node = { kind: 'instance', id }));
      out.push(node);
      if (!this.states.has(id)) void this.load(id);
    }
    return out;
  }

  private async load(instanceId: string): Promise<void> {
    const inst = this.store.get(instanceId);
    if (!inst) return;
    const gen = this.gen;
    const st: InstState = { loading: true, loadingMore: false, issues: [] };
    this.states.set(instanceId, st);
    try {
      const snap = this.filters.snapshot;
      let jql = await jqlForInstance(snap, inst, this.meta);
      if (jql === null) {
        st.jql = undefined;
      } else {
        const client = await this.meta.client(inst);
        let page: SearchPage;
        try {
          page = await client.search(jql, undefined, { maxResults: pageSize() });
        } catch (e) {
          // DC отвечает 400 на `key = ABC-999`, если такой задачи нет (проект есть) — тогда ищем этот текст как текст
          if (!(e instanceof JiraError && e.status === 400 && isIssueKey(snap.text)) || gen !== this.gen) throw e;
          jql = (await jqlForInstance(snap, inst, this.meta, { textOnly: true })) ?? jql;
          page = await client.search(jql, undefined, { maxResults: pageSize() });
        }
        if (gen !== this.gen) return;
        st.jql = jql;
        st.issues = page.issues;
        st.next = page.next;
        st.total = page.total;
      }
    } catch (e) {
      if (gen !== this.gen) return;
      st.error = errText(e);
      st.queryError = e instanceof JiraError && e.status === 400;
    }
    if (gen !== this.gen) return;
    st.loading = false;
    this.afterChange(instanceId);
  }

  async loadMore(instanceId: string): Promise<void> {
    const st = this.states.get(instanceId);
    const inst = this.store.get(instanceId);
    if (!st || !inst || !st.next || !st.jql || st.loadingMore) return;
    const gen = this.gen;
    st.loadingMore = true;
    this.afterChange(instanceId);
    try {
      const client = await this.meta.client(inst);
      const page = await client.search(st.jql, undefined, { ...st.next, maxResults: pageSize() });
      if (gen !== this.gen) return;
      const have = new Set(st.issues.map((i) => i.key));
      st.issues = [...st.issues, ...page.issues.filter((i) => !have.has(i.key))]; // выдача могла сдвинуться между страницами
      st.next = page.next;
      st.total = page.total ?? st.total;
    } catch (e) {
      if (gen !== this.gen) return;
      void vscode.window.showErrorMessage(t('Jiraffe: "{0}" — failed to load more: {1}', inst.name, errText(e)));
    }
    st.loadingMore = false;
    this.afterChange(instanceId);
  }

  private afterChange(instanceId: string): void {
    this.updateBadge();
    this.emitter.fire(this.instNodes.get(instanceId));
  }

  private updateHeader(): void {
    if (!this.view) return;
    this.view.description = describeFilters(this.filters.snapshot);
    this.updateBadge();
  }

  private updateBadge(): void {
    if (!this.view) return;
    let n = 0;
    let more = false; // Cloud без total: известна только нижняя граница
    for (const st of this.states.values()) {
      if (st.loading || st.error) continue;
      n += st.total ?? st.issues.length;
      if (st.total === undefined && st.next) more = true;
    }
    this.view.badge = n ? { value: n, tooltip: more ? t('Issues found: at least {0}', n) : t('Issues found: {0}', n) } : undefined;
  }
}
