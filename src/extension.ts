import * as vscode from 'vscode';
import { readScope, registerInstanceCommands } from './commands/instances';
import { registerFilterCommands } from './commands/filters';
import { registerIssueCommands } from './commands/issue';
import { registerSectionCommands } from './commands/sections';
import { registerLogWorkCommand, WorklogService } from './commands/logWork';
import { AttachmentService } from './panels/attachments';
import { IssuePanelManager } from './panels/issuePanel';
import { ListPanelManager } from './panels/listPanel';
import { FilterState } from './state/filters';
import { InstanceStore } from './state/instances';
import { InstanceMeta } from './state/meta';
import { EPIC_PROJECT_KEY, RELEASE_PROJECT_KEY, SectionProject } from './state/sectionProject';
import { TodayService } from './state/today';
import { localDate } from './jira/worklog';
import { EpicsTree } from './views/epicsTree';
import { FiltersTree } from './views/filtersTree';
import { IssuesTree } from './views/issuesTree';
import { ReleasesTree } from './views/releasesTree';
import { TodayStatusBar } from './views/statusBar';
import { TempoViewProvider } from './views/tempoView';

/** Сводку «сегодня» перечитываем, когда окно вернули в фокус (не чаще раза в 5 минут) и раз в 15 минут, пока окно в фокусе. */
const FOCUS_REFRESH_MS = 5 * 60_000;
const TIMER_REFRESH_MS = 15 * 60_000;

export function activate(context: vscode.ExtensionContext): void {
  const instances = new InstanceStore(context.globalState, context.secrets);
  instances.setScope(readScope);
  const filters = new FilterState(context.globalState, context.workspaceState);
  const meta = new InstanceMeta(instances);
  const attachments = new AttachmentService();
  void attachments.cleanupTmp();
  const worklog = new WorklogService(instances, meta);
  const today = new TodayService(instances, meta);
  const panels = new IssuePanelManager(context.extensionUri, instances, meta, attachments, worklog);
  const lists = new ListPanelManager(context.extensionUri, instances, meta);
  const epicProject = new SectionProject(context.workspaceState, EPIC_PROJECT_KEY, context.globalState);
  const releaseProject = new SectionProject(context.workspaceState, RELEASE_PROJECT_KEY, context.globalState);
  const epicsTree = new EpicsTree(instances, epicProject, meta);
  const releasesTree = new ReleasesTree(instances, releaseProject, meta);
  const epicsView = vscode.window.createTreeView('jiraffe.epics', { treeDataProvider: epicsTree });
  const releasesView = vscode.window.createTreeView('jiraffe.releases', { treeDataProvider: releasesTree });
  epicsTree.attach(epicsView);
  releasesTree.attach(releasesView);
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
    lists,
    epicsTree,
    releasesTree,
    epicsView,
    releasesView,
    vscode.window.createTreeView('jiraffe.filters', { treeDataProvider: filtersTree }),
    ...registerInstanceCommands(instances),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('jiraffe.instances')) instances.scopeChanged(); }),
    ...registerFilterCommands(instances, filters, meta, issuesTree, () => filtersTree.refresh(), panels, () => {
      void today.refresh();
      epicsTree.refresh();
      releasesTree.refresh();
      lists.reloadAll();
    }),
    ...registerIssueCommands(panels, lists),
    ...registerSectionCommands(instances, meta, epicProject, releaseProject, epicsTree),
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
