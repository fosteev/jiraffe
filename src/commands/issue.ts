import * as vscode from 'vscode';
import { isIssueRef, type IssuePanelManager } from '../panels/issuePanel';
import type { ListPanelManager } from '../panels/listPanel';
import { isIssueKey, isVersionId } from '../panels/protocol';

/**
 * Команды карточки и вкладок эпика/релиза: `openEpic({instanceId, key})`, `openRelease({instanceId, id})` — карточка и деревья
 * вызывают их командами; аргументы недоверенные (проверяются по формату). `jiraffe.logWork` — в `commands/logWork.ts` (этап 6).
 */
export function registerIssueCommands(panels: IssuePanelManager, lists: ListPanelManager): vscode.Disposable[] {
  const noCard = (): void => void vscode.window.showInformationMessage('Jiraffe: нет открытой карточки задачи');
  return [
    vscode.commands.registerCommand('jiraffe.pinIssue', (ref?: unknown) => { if (!panels.pin(isIssueRef(ref) ? ref : undefined)) noCard(); }),
    vscode.commands.registerCommand('jiraffe.copyKey', (ref?: unknown) => { if (!panels.copyKey(isIssueRef(ref) ? ref : undefined)) noCard(); }),
    vscode.commands.registerCommand('jiraffe.openInBrowser', (ref?: unknown) => { if (!panels.openInBrowser(isIssueRef(ref) ? ref : undefined)) noCard(); }),
    vscode.commands.registerCommand('jiraffe.openEpic', (arg?: unknown) => {
      const a = (arg && typeof arg === 'object' ? arg : {}) as { instanceId?: unknown; key?: unknown };
      if (typeof a.instanceId === 'string' && isIssueKey(a.key)) lists.open({ kind: 'epic', instanceId: a.instanceId, id: a.key });
    }),
    // Аргумент — {instanceId, key, id}: вложение задачи, открытой в карточке (метаданные и адреса — из неё).
    vscode.commands.registerCommand('jiraffe.downloadAttachment', (arg?: unknown) => {
      const a = (arg && typeof arg === 'object' ? arg : {}) as { instanceId?: unknown; key?: unknown; id?: unknown };
      const ref = { instanceId: a.instanceId, key: a.key };
      if (!isIssueRef(ref) || typeof a.id !== 'string' || !panels.downloadAttachment(ref, a.id)) {
        void vscode.window.showInformationMessage('Jiraffe: откройте карточку задачи и скачайте вложение на вкладке «Вложения»');
      }
    }),
    vscode.commands.registerCommand('jiraffe.openRelease', (arg?: unknown) => {
      const a = (arg && typeof arg === 'object' ? arg : {}) as { instanceId?: unknown; id?: unknown };
      if (typeof a.instanceId === 'string' && isVersionId(a.id)) lists.open({ kind: 'release', instanceId: a.instanceId, id: a.id });
    }),
  ];
}
