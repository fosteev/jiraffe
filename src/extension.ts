import * as vscode from 'vscode';
import { registerInstanceCommands } from './commands/instances';
import { registerFilterCommands } from './commands/filters';
import { registerIssueCommands } from './commands/issue';
import { IssuePanelManager } from './panels/issuePanel';
import { FilterState } from './state/filters';
import { InstanceStore } from './state/instances';
import { InstanceMeta } from './state/meta';
import { FiltersTree } from './views/filtersTree';
import { IssuesTree } from './views/issuesTree';

class EmptyTree implements vscode.TreeDataProvider<never> {
  getTreeItem(): vscode.TreeItem {
    throw new Error('empty tree has no items');
  }
  getChildren(): never[] {
    return [];
  }
}

class TempoViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.html =
      '<!doctype html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground)">Tempo: скоро</body></html>';
  }
}

export function activate(context: vscode.ExtensionContext): void {
  for (const id of ['jiraffe.epics', 'jiraffe.releases']) {
    context.subscriptions.push(vscode.window.registerTreeDataProvider(id, new EmptyTree()));
  }
  const instances = new InstanceStore(context.globalState, context.secrets);
  const filters = new FilterState(context.globalState);
  const meta = new InstanceMeta(instances);
  const panels = new IssuePanelManager(context.extensionUri, instances, meta);
  const issuesTree = new IssuesTree(instances, filters, meta);
  const filtersTree = new FiltersTree(instances, filters, meta);
  const issuesView = vscode.window.createTreeView('jiraffe.issues', { treeDataProvider: issuesTree });
  issuesTree.attach(issuesView);
  context.subscriptions.push(
    meta,
    panels,
    issuesTree,
    filtersTree,
    issuesView,
    vscode.window.createTreeView('jiraffe.filters', { treeDataProvider: filtersTree }),
    ...registerInstanceCommands(instances),
    ...registerFilterCommands(instances, filters, meta, issuesTree, () => filtersTree.refresh(), panels),
    ...registerIssueCommands(panels),
    vscode.window.registerWebviewViewProvider('jiraffe.tempo', new TempoViewProvider()),
  );
}

export function deactivate(): void {}
