import * as vscode from 'vscode';
import { isIssueRef, type IssuePanelManager } from '../panels/issuePanel';

/**
 * Команды карточки. `openEpic`, `openRelease` — заглушки: карточка вызывает их командами, этап 7 заменяет только тело
 * (сигнатура аргументов уже та). `jiraffe.logWork` — в `commands/logWork.ts` (этап 6).
 */
export function registerIssueCommands(panels: IssuePanelManager): vscode.Disposable[] {
  const noCard = (): void => void vscode.window.showInformationMessage('Jiraffe: нет открытой карточки задачи');
  return [
    vscode.commands.registerCommand('jiraffe.pinIssue', (ref?: unknown) => { if (!panels.pin(isIssueRef(ref) ? ref : undefined)) noCard(); }),
    vscode.commands.registerCommand('jiraffe.copyKey', (ref?: unknown) => { if (!panels.copyKey(isIssueRef(ref) ? ref : undefined)) noCard(); }),
    vscode.commands.registerCommand('jiraffe.openInBrowser', (ref?: unknown) => { if (!panels.openInBrowser(isIssueRef(ref) ? ref : undefined)) noCard(); }),
    vscode.commands.registerCommand('jiraffe.openEpic', (arg?: unknown) => {
      const key = arg && typeof arg === 'object' ? (arg as { key?: unknown }).key : undefined;
      void vscode.window.showInformationMessage(`Jiraffe: страница эпика${typeof key === 'string' ? ` ${key}` : ''} появится в этапе 7`);
    }),
    // Аргумент — {instanceId, key, id}: вложение задачи, открытой в карточке (метаданные и адреса — из неё).
    vscode.commands.registerCommand('jiraffe.downloadAttachment', (arg?: unknown) => {
      const a = (arg && typeof arg === 'object' ? arg : {}) as { instanceId?: unknown; key?: unknown; id?: unknown };
      const ref = { instanceId: a.instanceId, key: a.key };
      if (!isIssueRef(ref) || typeof a.id !== 'string' || !panels.downloadAttachment(ref, a.id)) {
        void vscode.window.showInformationMessage('Jiraffe: откройте карточку задачи и скачайте вложение на вкладке «Вложения»');
      }
    }),
    vscode.commands.registerCommand('jiraffe.openRelease', () => {
      void vscode.window.showInformationMessage('Jiraffe: страница релиза появится в этапе 7');
    }),
  ];
}
