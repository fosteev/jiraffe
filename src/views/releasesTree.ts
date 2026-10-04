import * as vscode from 'vscode';
import type { Version } from '../jira/types';
import type { InstanceMeta } from '../state/meta';
import type { InstanceStore } from '../state/instances';
import type { SectionProject } from '../state/sectionProject';
import { plural } from '../state/filters';
import { hostOf, mdEscape, projectErrorText, visibleVersions } from './format';

type Node =
  | { kind: 'version'; v: Version }
  | { kind: 'error'; message: string; project: boolean; instanceId: string }
  | { kind: 'hint'; id: string; text: string; command?: string };

interface State { loading: boolean; versions: Version[]; hidden: number; counts: Map<string, number | 'err'>; error?: string; errorIsProject?: boolean }

const COUNT_CONCURRENCY = 4;

const ddmmyyyy = (s: string): string => s.split('-').reverse().join('.');

/** Раздел «Релизы»: версии выбранного проекта (свой выбор), в строке — дата и число задач (relatedIssueCounts). */
export class ReleasesTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
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
    this.state = undefined;
    this.updateHeader();
    this.emitter.fire(undefined);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'version': {
        const v = n.v;
        const sel = this.project.get();
        const item = new vscode.TreeItem(v.name, vscode.TreeItemCollapsibleState.None);
        item.id = `rel:${sel?.instanceId}:${v.id}`;
        const c = this.state?.counts.get(v.id);
        const date = v.releaseDate ? ddmmyyyy(v.releaseDate) : 'без даты';
        const count = typeof c === 'number' ? ` · ${c} ${plural(c, 'задача', 'задачи', 'задач')}` : '';
        item.description = `${date}${count}`;
        item.iconPath = v.released ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green')) : new vscode.ThemeIcon(v.overdue ? 'warning' : 'circle-large-outline');
        item.tooltip = new vscode.MarkdownString([`**${mdEscape(v.name)}** · ${v.released ? 'выпущен' : v.overdue ? 'не выпущен, просрочен' : 'не выпущен'}`, ...(v.description ? ['', mdEscape(v.description)] : [])].join('  \n'));
        item.contextValue = 'release';
        if (sel) item.command = { command: 'jiraffe.openRelease', title: 'Открыть релиз', arguments: [{ instanceId: sel.instanceId, id: v.id }] };
        return item;
      }
      case 'error': {
        const item = new vscode.TreeItem(n.message, vscode.TreeItemCollapsibleState.None);
        item.id = 'rel-err';
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        if (n.project) {
          item.tooltip = `${n.message}\n\nНажмите — выбрать другой проект`;
          item.command = { command: 'jiraffe.pickReleaseProject', title: 'Выбрать проект' };
        } else {
          item.tooltip = `${n.message}\n\nНажмите — проверить подключение; «Обновить» в заголовке раздела — повторить запрос`;
          item.command = { command: 'jiraffe.testConnection', title: 'Проверить подключение', arguments: [n.instanceId] };
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
    if (n) return [];
    if (!this.store.list().length) return [];
    const sel = this.project.get();
    if (!sel) return [{ kind: 'hint', id: 'no-project', text: 'Выберите проект (кнопка в заголовке)', command: 'jiraffe.pickReleaseProject' }];
    if (!this.store.get(sel.instanceId)) return [{ kind: 'hint', id: 'no-inst', text: 'Инстанс проекта удалён — выберите проект', command: 'jiraffe.pickReleaseProject' }];
    const st = this.state;
    if (!st) {
      void this.load();
      return [{ kind: 'hint', id: 'loading', text: 'Загрузка…' }];
    }
    if (st.loading) return [{ kind: 'hint', id: 'loading', text: 'Загрузка…' }];
    if (st.error) return [{ kind: 'error', message: st.error, project: !!st.errorIsProject, instanceId: sel.instanceId }];
    if (!st.versions.length) return [{ kind: 'hint', id: 'empty', text: `В ${sel.key} нет версий` }];
    return [
      ...st.versions.map((v): Node => ({ kind: 'version', v })),
      ...(st.hidden ? [{ kind: 'hint', id: 'hidden', text: `Ещё ${st.hidden} выпущенных скрыто` } as Node] : []),
    ];
  }

  private async load(): Promise<void> {
    const sel = this.project.get();
    const inst = sel && this.store.get(sel.instanceId);
    if (!sel || !inst) return;
    const gen = this.gen;
    const st: State = { loading: true, versions: [], hidden: 0, counts: new Map() };
    this.state = st;
    try {
      const client = await this.meta.client(inst);
      const { versions, hidden } = visibleVersions(await client.versions(sel.key));
      if (gen !== this.gen) return;
      st.versions = versions;
      st.hidden = hidden;
      st.loading = false;
      this.updateHeader();
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
    this.updateHeader();
    this.emitter.fire(undefined);
  }

  private updateHeader(): void {
    if (!this.view) return;
    const sel = this.project.get();
    const inst = sel && this.store.get(sel.instanceId);
    this.view.description = sel && inst ? `${sel.key} · ${this.store.list().length > 1 ? inst.name : hostOf(inst.baseUrl)}` : undefined;
  }
}
