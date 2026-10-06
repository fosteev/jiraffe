import * as vscode from 'vscode';
import { loadEpics, type EpicFilter, type EpicItem } from '../jira/epics';
import type { PageRequest } from '../jira/client';
import type { InstanceMeta } from '../state/meta';
import type { InstanceStore } from '../state/instances';
import type { SectionProject } from '../state/sectionProject';
import { t } from '../l10n';
import { isIssueKey } from '../jql';
import { CATEGORY_LABEL, hostOf, mdEscape, progressLabel, projectErrorText } from './format';

type Node =
  | { kind: 'epic'; epic: EpicItem }
  | { kind: 'more' }
  | { kind: 'error'; message: string; project: boolean; instanceId: string }
  | { kind: 'hint'; id: string; text: string; command?: string }
  | { kind: 'byKey'; instanceId: string; key: string };

interface State { loading: boolean; loadingMore: boolean; epics: EpicItem[]; next?: PageRequest; error?: string; errorIsProject?: boolean; jql?: string }

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const pageSize = (): number => vscode.workspace.getConfiguration('jiraffe').get<number>('maxResults', 50);

/** «Мои / все» и строка поиска раздела «Эпики»; `jiraffe.epicsMine` — контекст для кнопки в заголовке. */
export const EPIC_FILTER_KEY = 'jiraffe.epicFilter';
const MINE_CTX = 'jiraffe.epicsMine';

function sanitizeEpicFilter(v: unknown): EpicFilter {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { mine: o.mine === true, text: typeof o.text === 'string' ? o.text : '' };
}

/** Раздел «Эпики»: эпики выбранного проекта (свой выбор, отдельный от «Задач») со строкой `готово/всего`. */
export class EpicsTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private state: State | undefined;
  private view?: vscode.TreeView<Node>;
  private gen = 0;
  private readonly subs: vscode.Disposable[];

  constructor(
    private readonly store: InstanceStore,
    private readonly project: SectionProject,
    private readonly meta: InstanceMeta,
    private readonly memento: vscode.Memento,
  ) {
    void vscode.commands.executeCommand('setContext', MINE_CTX, this.filter.mine);
    this.subs = [this.emitter, store.onDidChange(() => this.refresh()), project.onDidChange(() => this.refresh())];
  }

  attach(view: vscode.TreeView<Node>): void {
    this.view = view;
    this.updateHeader();
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
  }

  get filter(): EpicFilter {
    return sanitizeEpicFilter(this.memento.get<unknown>(EPIC_FILTER_KEY));
  }

  setFilter(patch: EpicFilter): void {
    const f = { ...this.filter, ...patch };
    f.text = (f.text ?? '').replace(/\s+/g, ' ').trim();
    void this.memento.update(EPIC_FILTER_KEY, f);
    void vscode.commands.executeCommand('setContext', MINE_CTX, f.mine);
    this.refresh();
  }

  refresh(): void {
    this.gen++;
    this.state = undefined;
    this.updateHeader();
    this.emitter.fire(undefined);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'epic': {
        const e = n.epic;
        const sel = this.project.get();
        const item = new vscode.TreeItem(e.summary || e.key, vscode.TreeItemCollapsibleState.None);
        item.id = `epic:${sel?.instanceId}:${e.key}`;
        const prog = progressLabel(e);
        item.description = prog ? `${e.key} · ${prog}` : e.key;
        item.iconPath = new vscode.ThemeIcon('zap', new vscode.ThemeColor('charts.purple'));
        const lines = [`**${mdEscape(e.key)}** · ${mdEscape(e.summary)}`, '', `${mdEscape(e.status)} (${CATEGORY_LABEL[e.statusCategory]})`];
        if (e.progress) lines.push(t('Done {0} of {1}, in progress {2}, not started {3}{4}', e.progress.done, e.progress.total, e.progress.prog, e.progress.todo, e.partial ? ` ${t('(more issues than the query limit — figures are approximate)')}` : ''));
        else lines.push(t('Progress unavailable'));
        item.tooltip = new vscode.MarkdownString(lines.join('  \n'));
        item.contextValue = 'epic';
        if (sel) item.command = { command: 'jiraffe.openEpic', title: t('Open Epic'), arguments: [{ instanceId: sel.instanceId, key: e.key }] };
        return item;
      }
      case 'more': {
        const st = this.state;
        const item = new vscode.TreeItem(st?.loadingMore ? t('Loading more…') : t('Load More'), vscode.TreeItemCollapsibleState.None);
        item.id = 'epics-more';
        item.iconPath = new vscode.ThemeIcon(st?.loadingMore ? 'loading~spin' : 'ellipsis');
        item.description = st ? t('shown {0}', st.epics.length) : undefined;
        item.command = { command: 'jiraffe.loadMoreEpics', title: t('Load More') };
        return item;
      }
      case 'error': {
        const item = new vscode.TreeItem(n.message, vscode.TreeItemCollapsibleState.None);
        item.id = 'epics-err';
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        if (n.project) {
          item.tooltip = `${n.message}\n\n${t('Click to pick another project')}`;
          item.command = { command: 'jiraffe.pickEpicProject', title: t('Select Project') };
        } else {
          item.tooltip = `${n.message}\n\n${t('Click to test the connection; “Refresh” in the section header retries the request')}`;
          item.command = { command: 'jiraffe.testConnection', title: t('Test Connection'), arguments: [n.instanceId] };
        }
        return item;
      }
      case 'byKey': {
        const item = new vscode.TreeItem(t('Open {0} by key', n.key), vscode.TreeItemCollapsibleState.None);
        item.id = `epics-bykey:${n.key}`;
        item.iconPath = new vscode.ThemeIcon('search');
        item.command = { command: 'jiraffe.openEpic', title: t('Open Epic'), arguments: [{ instanceId: n.instanceId, key: n.key }] };
        return item;
      }
      case 'hint': {
        const item = new vscode.TreeItem(n.text, vscode.TreeItemCollapsibleState.None);
        item.id = `epics-hint:${n.id}`;
        if (n.command) item.command = { command: n.command, title: n.text };
        return item;
      }
    }
  }

  getChildren(n?: Node): Node[] {
    if (n) return [];
    if (!this.store.list().length) return [];
    const sel = this.project.get();
    if (!sel) return [{ kind: 'hint', id: 'no-project', text: t('Select a project (button in the header)'), command: 'jiraffe.pickEpicProject' }];
    if (!this.store.get(sel.instanceId)) return [{ kind: 'hint', id: 'no-inst', text: t('The project’s instance was removed — select a project'), command: 'jiraffe.pickEpicProject' }];
    if (!this.store.visible(sel.instanceId)) return [{ kind: 'hint', id: 'out-of-scope', text: t('The project’s instance is not in this workspace — select a project'), command: 'jiraffe.pickEpicProject' }];
    // Ключ эпика в поиске — `summary ~` его не найдёт, а `key = …` на DC даёт 400, если такого ключа нет: открываем отдельной строкой.
    const f = this.filter;
    const head: Node[] = f.text && isIssueKey(f.text) ? [{ kind: 'byKey', instanceId: sel.instanceId, key: f.text.toUpperCase() }] : [];
    const st = this.state;
    if (!st) {
      void this.load();
      return [...head, { kind: 'hint', id: 'loading', text: t('Loading…') }];
    }
    if (st.loading) return [...head, { kind: 'hint', id: 'loading', text: t('Loading…') }];
    if (st.error) return [...head, { kind: 'error', message: st.error, project: !!st.errorIsProject, instanceId: sel.instanceId }];
    if (!st.epics.length) {
      const text = f.mine || f.text ? t('No epics match the filter in {0}', sel.key) : t('No unresolved epics in {0}', sel.key);
      return [...head, { kind: 'hint', id: 'empty', text }];
    }
    return [...head, ...st.epics.map((epic): Node => ({ kind: 'epic', epic })), ...(st.next ? [{ kind: 'more' } as Node] : [])];
  }

  private async load(): Promise<void> {
    const sel = this.project.get();
    const inst = sel && this.store.get(sel.instanceId);
    if (!sel || !inst) return;
    const gen = this.gen;
    const st: State = { loading: true, loadingMore: false, epics: [] };
    this.state = st;
    try {
      const client = await this.meta.client(inst);
      const r = await loadEpics(client, inst, sel.key, { maxResults: pageSize() }, undefined, this.filter);
      if (gen !== this.gen) return;
      st.epics = r.epics;
      st.next = r.next;
      st.jql = r.jql;
    } catch (e) {
      if (gen !== this.gen) return;
      const pe = projectErrorText(e, sel.key);
      st.error = pe.text;
      st.errorIsProject = pe.project;
    }
    st.loading = false;
    this.updateHeader();
    this.emitter.fire(undefined);
  }

  async loadMore(): Promise<void> {
    const st = this.state;
    const sel = this.project.get();
    const inst = sel && this.store.get(sel.instanceId);
    if (!st || !sel || !inst || !st.next || st.loadingMore) return;
    const gen = this.gen;
    st.loadingMore = true;
    this.emitter.fire(undefined);
    try {
      const client = await this.meta.client(inst);
      const r = await loadEpics(client, inst, sel.key, { ...st.next, maxResults: pageSize() }, st.jql);
      if (gen !== this.gen) return;
      const have = new Set(st.epics.map((e) => e.key));
      st.epics = [...st.epics, ...r.epics.filter((e) => !have.has(e.key))];
      st.next = r.next;
    } catch (e) {
      if (gen !== this.gen) return;
      void vscode.window.showErrorMessage(t('Jiraffe: "{0}" — failed to load more epics: {1}', inst.name, errText(e)));
    }
    st.loadingMore = false;
    this.emitter.fire(undefined);
  }

  private updateHeader(): void {
    if (!this.view) return;
    const sel = this.project.get();
    const inst = sel && this.store.get(sel.instanceId);
    if (!sel || !inst) {
      this.view.description = undefined;
      return;
    }
    const f = this.filter;
    const parts = [sel.key, this.store.list().length > 1 ? inst.name : hostOf(inst.baseUrl)];
    if (f.mine) parts.push(t('mine'));
    if (f.text) parts.push(`“${f.text}”`);
    this.view.description = parts.join(' · ');
  }
}
