import * as vscode from 'vscode';
import { isIssueRef, type IssuePanelManager } from '../panels/issuePanel';

/**
 * Команды карточки. `logWork`, `openEpic`, `openRelease` — заглушки: карточка вызывает их командами,
 * этапы 6 и 7 заменяют только тело (сигнатура аргументов уже та).
 */
export function registerIssueCommands(panels: IssuePanelManager): vscode.Disposable[] {
  const noCard = (): void => void vscode.window.showInformationMessage('Jiraffe: нет открытой карточки задачи');
  return [
    vscode.commands.registerCommand('jiraffe.pinIssue', (ref?: unknown) => { if (!panels.pin(isIssueRef(ref) ? ref : undefined)) noCard(); }),
    vscode.commands.registerCommand('jiraffe.copyKey', (ref?: unknown) => { if (!panels.copyKey(isIssueRef(ref) ? ref : undefined)) noCard(); }),
    vscode.commands.registerCommand('jiraffe.openInBrowser', (ref?: unknown) => { if (!panels.openInBrowser(isIssueRef(ref) ? ref : undefined)) noCard(); }),
    vscode.commands.registerCommand('jiraffe.logWork', (ref?: unknown) => {
      void vscode.window.showInformationMessage(`Jiraffe: запись времени${isIssueRef(ref) ? ` в ${ref.key}` : ''} появится в этапе 6`);
    }),
    vscode.commands.registerCommand('jiraffe.openEpic', (arg?: unknown) => {
      const key = arg && typeof arg === 'object' ? (arg as { key?: unknown }).key : undefined;
      void vscode.window.showInformationMessage(`Jiraffe: страница эпика${typeof key === 'string' ? ` ${key}` : ''} появится в этапе 7`);
    }),
    vscode.commands.registerCommand('jiraffe.openRelease', () => {
      void vscode.window.showInformationMessage('Jiraffe: страница релиза появится в этапе 7');
    }),
  ];
}
