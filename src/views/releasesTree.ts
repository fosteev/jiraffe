import * as vscode from 'vscode';
import type { Version } from '../jira/types';
import type { InstanceMeta } from '../state/meta';
import type { InstanceStore } from '../state/instances';
import type { ProjectSel } from '../state/filters';
import type { SectionProjects } from '../state/sectionProject';
import { t, tn } from '../l10n';
import { hostOf, mdEscape, projectErrorText, visibleVersions } from './format';

type Node =
  | { kind: 'project'; sel: ProjectSel }
  | { kind: 'version'; v: Version; sel: ProjectSel }
  | { kind: 'error'; message: string; project: boolean; sel: ProjectSel }
  | { kind: 'hint'; id: string; text: string; command?: string };

interface State { loading: boolean; versions: Version[]; hidden: number; counts: Map<string, number | 'err'>; error?: string; errorIsProject?: boolean }

const COUNT_CONCURRENCY = 4;

const selId = (s: ProjectSel): string => `${s.instanceId}:${s.key}`;

const ddmmyyyy = (s: string): string => s.split('-').reverse().join('.');

/**
 * Раздел «Релизы»: версии отслеживаемых проектов (свой выбор, несколько), в строке — дата и число задач (relatedIssueCounts).
 * Один проект — версии сразу в корне, как раньше; несколько — корень из проектов, версии внутри.
 */
export class ReleasesTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly states = new Map<string, State>();
  private view?: vscode.TreeView<Node>;
  private gen = 0;
  private readonly subs: vscode.Disposable[];

  constructor(
    private readonly store: InstanceStore,
    private readonly project: SectionProjects,
    private readonly meta: InstanceMeta,
  ) {
    this.subs = [this.emitter, store.onDidChange(() => this.refresh()), project.onDidChange(() => this.refresh())];
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

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'project': {
        const inst = this.store.get(n.sel.instanceId);
        const item = new vscode.TreeItem(n.sel.key, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `rel-proj:${selId(n.sel)}`;
        item.description = inst ? (this.store.list().length > 1 ? inst.name : hostOf(inst.baseUrl)) : undefined;
        item.iconPath = new vscode.ThemeIcon('project');
        item.contextValue = 'releaseProject';
        return item;
      }
      case 'version': {
        const v = n.v;
        const sel = n.sel;
        const item = new vscode.TreeItem(v.name, vscode.TreeItemCollapsibleState.None);
        item.id = `rel:${sel.instanceId}:${v.id}`;
        const c = this.states.get(selId(sel))?.counts.get(v.id);
        const date = v.releaseDate ? ddmmyyyy(v.releaseDate) : t('no date');
        const count = typeof c === 'number' ? ` · ${tn(c, '{0} issue|{0} issues')}` : '';
        item.description = `${date}${count}`;
        item.iconPath = v.released ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green')) : new vscode.ThemeIcon(v.overdue ? 'warning' : 'circle-large-outline');
        item.tooltip = new vscode.MarkdownString([`**${mdEscape(v.name)}** · ${v.released ? t('released') : v.overdue ? t('unreleased, overdue') : t('unreleased')}`, ...(v.description ? ['', mdEscape(v.description)] : [])].join('  \n'));
        item.contextValue = 'release';
        item.command = { command: 'jiraffe.openRelease', title: t('Open Release'), arguments: [{ instanceId: sel.instanceId, id: v.id }] };
        return item;
      }
      case 'error': {
        const item = new vscode.TreeItem(n.message, vscode.TreeItemCollapsibleState.None);
        item.id = `rel-err:${selId(n.sel)}`;
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        if (n.project) {
          item.tooltip = `${n.message}\n\n${t('Click to pick another project')}`;
          item.command = { command: 'jiraffe.pickReleaseProject', title: t('Select Project') };
        } else {
          item.tooltip = `${n.message}\n\n${t('Click to test the connection; “Refresh” in the section header retries the request')}`;
          item.command = { command: 'jiraffe.testConnection', title: t('Test Connection'), arguments: [n.sel.instanceId] };
        }
        return item;
      }
      case 'hint': {
        const item = new vscode.TreeItem(n.text, vscode.TreeItemCollapsibleState.None);
        item.id = `rel-hint:${n.id}`;
        if (n.command) item.command = { command: n.command, title: n.text };
        return item;
      }
    }
  }

  getChildren(n?: Node): Node[] {
    if (n) return n.kind === 'project' ? this.projectChildren(n.sel) : [];
    if (!this.store.list().length) return [];
    const sels = this.project.get();
    if (!sels.length) return [{ kind: 'hint', id: 'no-project', text: t('Select projects (button in the header)'), command: 'jiraffe.pickReleaseProject' }];
    if (sels.length === 1) return this.projectChildren(sels[0]!);
    return sels.map((sel): Node => ({ kind: 'project', sel }));
  }

  private projectChildren(sel: ProjectSel): Node[] {
    const hint = (id: string, text: string, command?: string): Node => ({ kind: 'hint', id: `${selId(sel)}:${id}`, text, command });
    if (!this.store.get(sel.instanceId)) return [hint('no-inst', t('The project’s instance was removed — select a project'), 'jiraffe.pickReleaseProject')];
    if (!this.store.visible(sel.instanceId)) return [hint('out-of-scope', t('The project’s instance is not in this workspace — select a project'), 'jiraffe.pickReleaseProject')];
    const st = this.states.get(selId(sel));
    if (!st) {
      void this.load(sel);
      return [hint('loading', t('Loading…'))];
    }
    if (st.loading) return [hint('loading', t('Loading…'))];
    if (st.error) return [{ kind: 'error', message: st.error, project: !!st.errorIsProject, sel }];
    if (!st.versions.length) return [hint('empty', t('No versions in {0}', sel.key))];
    return [
      ...st.versions.map((v): Node => ({ kind: 'version', v, sel })),
      ...(st.hidden ? [hint('hidden', t('Another {0} released hidden', st.hidden))] : []),
    ];
  }

  private async load(sel: ProjectSel): Promise<void> {
    const inst = this.store.get(sel.instanceId);
    if (!inst) return;
    const gen = this.gen;
    const st: State = { loading: true, versions: [], hidden: 0, counts: new Map() };
    this.states.set(selId(sel), st);
    try {
      const client = await this.meta.client(inst);
      const { versions, hidden } = visibleVersions(await client.versions(sel.key));
      if (gen !== this.gen) return;
      st.versions = versions;
      st.hidden = hidden;
      st.loading = false;
      this.emitter.fire(undefined);
      // Счётчики догружаются в фоне (по 4 параллельно), строка обновляется по мере ответов.
      const queue = [...versions];
      await Promise.all(Array.from({ length: COUNT_CONCURRENCY }, async () => {
        for (let v = queue.shift(); v; v = queue.shift()) {
          if (gen !== this.gen) return;
          try {
            st.counts.set(v.id, await client.versionIssueCount(v.id));
          } catch {
            st.counts.set(v.id, 'err');
          }
          if (gen === this.gen) this.emitter.fire(undefined); // узел-объект при обновлении не совпал бы по идентичности — обновляем целиком
        }
      }));
      return;
    } catch (e) {
      if (gen !== this.gen) return;
      const pe = projectErrorText(e, sel.key);
      st.error = pe.text;
      st.errorIsProject = pe.project;
    }
    st.loading = false;
    this.emitter.fire(undefined);
  }

  private updateHeader(): void {
    if (!this.view) return;
    const sels = this.project.get();
    const inst = sels.length === 1 ? this.store.get(sels[0]!.instanceId) : undefined;
    this.view.description = inst
      ? `${sels[0]!.key} · ${this.store.list().length > 1 ? inst.name : hostOf(inst.baseUrl)}`
      : sels.length > 1 ? sels.map((s) => s.key).join(', ') : undefined;
  }
}
