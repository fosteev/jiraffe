import * as vscode from 'vscode';
import { registerInstanceCommands } from './commands/instances';
import { InstanceStore } from './state/instances';

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
  for (const id of ['jiraffe.issues', 'jiraffe.filters', 'jiraffe.epics', 'jiraffe.releases']) {
    context.subscriptions.push(vscode.window.registerTreeDataProvider(id, new EmptyTree()));
  }
  const instances = new InstanceStore(context.globalState, context.secrets);
  context.subscriptions.push(...registerInstanceCommands(instances));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('jiraffe.tempo', new TempoViewProvider()),
    vscode.commands.registerCommand('jiraffe.refresh', () => {
      void vscode.window.showInformationMessage('Jiraffe: пока нечего обновлять');
    }),
  );
}

export function deactivate(): void {}
