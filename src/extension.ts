import * as vscode from 'vscode';
import { createApi, type JiraffeApi } from './api';
import { API_ENABLED, API_SECTION } from './apiAccess';
import { apiAccess } from './apiAccessHost';
import { setL10n } from './l10n';
import { readScope, registerInstanceCommands } from './commands/instances';
import { registerFilterCommands } from './commands/filters';
import { registerIssueCommands } from './commands/issue';
import { registerSectionCommands } from './commands/sections';
import { registerLogWorkCommand, WorklogService } from './commands/logWork';
import { registerTransitionCommand } from './commands/transition';
import { AttachmentService } from './panels/attachments';
import { IssuePanelManager } from './panels/issuePanel';
import { ListPanelManager } from './panels/listPanel';
import { SettingsPanel } from './panels/settingsPanel';
import { isSectionId } from './panels/settingsModel';
import { ApiActivity } from './state/apiActivity';
import { FilterState } from './state/filters';
import { InstanceStore } from './state/instances';
import { forgetInstance, watchRemovedInstances } from './state/instanceCleanup';
import { InstanceMeta } from './state/meta';
import { EPIC_PROJECT_KEY, RELEASE_PROJECT_KEY, SectionProject, SectionProjects } from './state/sectionProject';
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

export function activate(context: vscode.ExtensionContext): JiraffeApi {
  setL10n(vscode.l10n.bundle, vscode.l10n.bundle ? vscode.env.language : 'en');
  const instances = new InstanceStore(context.globalState, context.secrets);
  instances.setScope(readScope);
  const filters = new FilterState(context.globalState, context.workspaceState);
  const meta = new InstanceMeta(instances);
  const attachments = new AttachmentService();
  void attachments.cleanupTmp();
  const worklog = new WorklogService(instances, meta);
  const today = new TodayService(instances, meta);
  const panels = new IssuePanelManager(context.extensionUri, instances, meta, attachments, worklog);
  const lists = new ListPanelManager(context.extensionUri, instances, meta, filters);
  const epicProject = new SectionProject(context.workspaceState, EPIC_PROJECT_KEY, context.globalState);
  const releaseProject = new SectionProjects(context.workspaceState, RELEASE_PROJECT_KEY, context.globalState);
  const epicsTree = new EpicsTree(instances, epicProject, meta, context.globalState);
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
  const issuesTree = new IssuesTree(instances, filters, meta, context.globalState);
  const filtersTree = new FiltersTree(instances, filters, meta);
  const issuesView = vscode.window.createTreeView('jiraffe.issues', { treeDataProvider: issuesTree });
  issuesTree.attach(issuesView);
  const apiActivity = new ApiActivity();
  // Инстанс отключён (команда или вкладка настроек): убираем его фильтры и выбранные проекты.
  const cleanup = watchRemovedInstances(instances, (id) => void forgetInstance(id, [filters, epicProject, releaseProject]));
  const settings = new SettingsPanel(context.extensionUri, issuesTree, instances, apiActivity);
  context.subscriptions.push(
    cleanup,
    meta,
    attachments,
    panels,
    issuesTree,
    filtersTree,
    issuesView,
    lists,
    settings,
    vscode.commands.registerCommand('jiraffe.openSettings', (section?: unknown) => settings.open(isSectionId(section) ? section : undefined)),
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
    ...registerTransitionCommand(panels, instances, meta, (ref) => {
      panels.reload(ref);
      issuesTree.refresh();
      epicsTree.refresh();
      releasesTree.refresh();
      lists.reloadAll();
    }),
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
  const instancesChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    instancesChanged,
    instances.onDidChange(() => instancesChanged.fire()),
    // Доступ включили или выключили: `instances()` стал полным или пустым — потребители перечитают список.
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${API_SECTION}.${API_ENABLED}`)) instancesChanged.fire(); }),
  );
  return createApi({
    access: apiAccess,
    list: () => instances.list(),
    visible: (id) => (instances.visible(id) ? instances.get(id) : undefined),
    client: (inst) => meta.client(inst),
    open: (instanceId, key, beside) => panels.open({ instanceId, key }, beside),
    onDidChangeInstances: instancesChanged.event,
    logForm: (inst) => worklog.form(inst),
    changed: (kind, instanceId, key) => {
      apiActivity.record(kind, key); // первым: сбой обновления видов не должен потерять запись
      panels.reload({ instanceId, key });
      if (kind === 'worklog') void today.refresh();
      if (kind === 'transition') {
        issuesTree.refresh();
        epicsTree.refresh();
        releasesTree.refresh();
        lists.reloadAll();
      }
    },
  });
}

export function deactivate(): void {}
