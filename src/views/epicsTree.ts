import * as vscode from 'vscode';
import { loadEpics, type EpicItem } from '../jira/epics';
import type { PageRequest } from '../jira/client';
import type { InstanceMeta } from '../state/meta';
import type { InstanceStore } from '../state/instances';
import type { SectionProject } from '../state/sectionProject';
import { CATEGORY_LABEL, hostOf, mdEscape, progressLabel, projectErrorText } from './format';

type Node =
  | { kind: 'epic'; epic: EpicItem }
  | { kind: 'more' }
  | { kind: 'error'; message: string; project: boolean; instanceId: string }
  | { kind: 'hint'; id: string; text: string; command?: string };

interface State { loading: boolean; loadingMore: boolean; epics: EpicItem[]; next?: PageRequest; error?: string; errorIsProject?: boolean; jql?: string }

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const pageSize = (): number => vscode.workspace.getConfiguration('jiraffe').get<number>('maxResults', 50);

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
      case 'epic': {
        const e = n.epic;
        const sel = this.project.get();
        const item = new vscode.TreeItem(e.summary || e.key, vscode.TreeItemCollapsibleState.None);
        item.id = `epic:${sel?.instanceId}:${e.key}`;
        const prog = progressLabel(e);
        item.description = prog ? `${e.key} · ${prog}` : e.key;
        item.iconPath = new vscode.ThemeIcon('zap', new vscode.ThemeColor('charts.purple'));
        const lines = [`**${mdEscape(e.key)}** · ${mdEscape(e.summary)}`, '', `${mdEscape(e.status)} (${CATEGORY_LABEL[e.statusCategory]})`];
        if (e.progress) lines.push(`Готово ${e.progress.done} из ${e.progress.total}, в работе ${e.progress.prog}, не начато ${e.progress.todo}${e.partial ? ' (задач больше лимита запроса — цифры приблизительные)' : ''}`);
        else lines.push('Прогресс недоступен');
        item.tooltip = new vscode.MarkdownString(lines.join('  \n'));
        item.contextValue = 'epic';
        if (sel) item.command = { command: 'jiraffe.openEpic', title: 'Открыть эпик', arguments: [{ instanceId: sel.instanceId, key: e.key }] };
        return item;
      }
      case 'more': {
        const st = this.state;
        const item = new vscode.TreeItem(st?.loadingMore ? 'Загружаю…' : 'Загрузить ещё', vscode.TreeItemCollapsibleState.None);
        item.id = 'epics-more';
        item.iconPath = new vscode.ThemeIcon(st?.loadingMore ? 'loading~spin' : 'ellipsis');
        item.description = st ? `показано ${st.epics.length}` : undefined;
        item.command = { command: 'jiraffe.loadMoreEpics', title: 'Загрузить ещё' };
        return item;
      }
      case 'error': {
        const item = new vscode.TreeItem(n.message, vscode.TreeItemCollapsibleState.None);
        item.id = 'epics-err';
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        if (n.project) {
          item.tooltip = `${n.message}\n\nНажмите — выбрать другой проект`;
          item.command = { command: 'jiraffe.pickEpicProject', title: 'Выбрать проект' };
        } else {
          item.tooltip = `${n.message}\n\nНажмите — проверить подключение; «Обновить» в заголовке раздела — повторить запрос`;
          item.command = { command: 'jiraffe.testConnection', title: 'Проверить подключение', arguments: [n.instanceId] };
        }
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
    if (!sel) return [{ kind: 'hint', id: 'no-project', text: 'Выберите проект (кнопка в заголовке)', command: 'jiraffe.pickEpicProject' }];
    if (!this.store.get(sel.instanceId)) return [{ kind: 'hint', id: 'no-inst', text: 'Инстанс проекта удалён — выберите проект', command: 'jiraffe.pickEpicProject' }];
    if (!this.store.visible(sel.instanceId)) return [{ kind: 'hint', id: 'out-of-scope', text: 'Инстанс проекта не входит в этот workspace — выберите проект', command: 'jiraffe.pickEpicProject' }];
    const st = this.state;
    if (!st) {
      void this.load();
      return [{ kind: 'hint', id: 'loading', text: 'Загрузка…' }];
    }
    if (st.loading) return [{ kind: 'hint', id: 'loading', text: 'Загрузка…' }];
    if (st.error) return [{ kind: 'error', message: st.error, project: !!st.errorIsProject, instanceId: sel.instanceId }];
    if (!st.epics.length) return [{ kind: 'hint', id: 'empty', text: `В ${sel.key} нет нерешённых эпиков` }];
    return [...st.epics.map((epic): Node => ({ kind: 'epic', epic })), ...(st.next ? [{ kind: 'more' } as Node] : [])];
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
      const r = await loadEpics(client, inst, sel.key, { maxResults: pageSize() });
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
      void vscode.window.showErrorMessage(`Jiraffe: «${inst.name}» — не удалось догрузить эпики: ${errText(e)}`);
    }
    st.loadingMore = false;
    this.emitter.fire(undefined);
  }

  private updateHeader(): void {
    if (!this.view) return;
    const sel = this.project.get();
    const inst = sel && this.store.get(sel.instanceId);
    this.view.description = sel && inst ? `${sel.key} · ${this.store.list().length > 1 ? inst.name : hostOf(inst.baseUrl)}` : undefined;
  }
}
