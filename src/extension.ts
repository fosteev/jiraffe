import * as vscode from 'vscode';
import { registerInstanceCommands } from './commands/instances';
import { registerFilterCommands } from './commands/filters';
import { registerIssueCommands } from './commands/issue';
import { registerLogWorkCommand, WorklogService } from './commands/logWork';
import { AttachmentService } from './panels/attachments';
import { IssuePanelManager } from './panels/issuePanel';
import { FilterState } from './state/filters';
import { InstanceStore } from './state/instances';
import { InstanceMeta } from './state/meta';
import { TodayService } from './state/today';
import { localDate } from './jira/worklog';
import { FiltersTree } from './views/filtersTree';
import { IssuesTree } from './views/issuesTree';
import { TodayStatusBar } from './views/statusBar';
import { TempoViewProvider } from './views/tempoView';

class EmptyTree implements vscode.TreeDataProvider<never> {
  getTreeItem(): vscode.TreeItem {
    throw new Error('empty tree has no items');
  }
  getChildren(): never[] {
    return [];
  }
}

/** Сводку «сегодня» перечитываем, когда окно вернули в фокус (не чаще раза в 5 минут) и раз в 15 минут, пока окно в фокусе. */
const FOCUS_REFRESH_MS = 5 * 60_000;
const TIMER_REFRESH_MS = 15 * 60_000;

export function activate(context: vscode.ExtensionContext): void {
  for (const id of ['jiraffe.epics', 'jiraffe.releases']) {
    context.subscriptions.push(vscode.window.registerTreeDataProvider(id, new EmptyTree()));
  }
  const instances = new InstanceStore(context.globalState, context.secrets);
  const filters = new FilterState(context.globalState);
  const meta = new InstanceMeta(instances);
  const attachments = new AttachmentService();
  void attachments.cleanupTmp();
  const worklog = new WorklogService(instances, meta);
  const today = new TodayService(instances, meta);
  const panels = new IssuePanelManager(context.extensionUri, instances, meta, attachments, worklog);
  const tempoView = new TempoViewProvider(context.extensionUri, today, instances);
  let lastRefresh = 0;
  const refreshToday = (): void => {
    lastRefresh = Date.now();
    void today.refresh();
  };
  today.onDidChange((s) => { if (!s.loading) lastRefresh = Date.now(); });
  // Без фокуса — только если наступил новый день (иначе в строке состояния висела бы вчерашняя сумма).
  const timer = setInterval(() => { if (vscode.window.state.focused || today.get().date !== localDate()) refreshToday(); }, TIMER_REFRESH_MS);
  const issuesTree = new IssuesTree(instances, filters, meta);
  const filtersTree = new FiltersTree(instances, filters, meta);
  const issuesView = vscode.window.createTreeView('jiraffe.issues', { treeDataProvider: issuesTree });
  issuesTree.attach(issuesView);
  context.subscriptions.push(
    meta,
    attachments,
    panels,
    issuesTree,
    filtersTree,
    issuesView,
    vscode.window.createTreeView('jiraffe.filters', { treeDataProvider: filtersTree }),
    ...registerInstanceCommands(instances),
    ...registerFilterCommands(instances, filters, meta, issuesTree, () => filtersTree.refresh(), panels, () => void today.refresh()),
    ...registerIssueCommands(panels),
    ...registerLogWorkCommand(worklog, panels, instances, meta),
    today,
    new TodayStatusBar(today, instances),
    tempoView,
    vscode.window.registerWebviewViewProvider('jiraffe.tempo', tempoView),
    worklog.onDidLog((ref) => {
      panels.reload(ref);
      void today.refresh();
    }),
    vscode.window.onDidChangeWindowState((st) => {
      if (st.focused && Date.now() - lastRefresh > FOCUS_REFRESH_MS) refreshToday();
    }),
    { dispose: () => clearInterval(timer) },
  );
  refreshToday();
}

export function deactivate(): void {}
