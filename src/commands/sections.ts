import * as vscode from 'vscode';
import { perInstance, withProgress } from './filters';
import type { InstanceStore } from '../state/instances';
import type { InstanceMeta } from '../state/meta';
import type { SectionProject } from '../state/sectionProject';
import { hostOf } from '../views/format';
import type { EpicsTree } from '../views/epicsTree';

/** QuickPick проекта (по всем инстансам) для раздела «Эпики» / «Релизы»; выбор пишется в `target`. */
async function pickSectionProject(store: InstanceStore, meta: InstanceMeta, target: SectionProject, title: string): Promise<void> {
  const all = store.list();
  if (!all.length) {
    const act = await vscode.window.showInformationMessage('Jiraffe: нет ни одного инстанса', 'Добавить');
    if (act) await vscode.commands.executeCommand('jiraffe.addInstance');
    return;
  }
  const { ok, failed } = await withProgress('Jiraffe: загружаю проекты…', () => perInstance(all, (i) => meta.projects(i)));
  if (failed.length) void vscode.window.showWarningMessage(`Jiraffe: проекты не загрузились — ${failed.join('; ')}`);
  type Item = vscode.QuickPickItem & { sel?: { instanceId: string; key: string } };
  const items: Item[] = [];
  for (const [inst, projects] of ok) {
    if (ok.length > 1) items.push({ label: inst.name, kind: vscode.QuickPickItemKind.Separator });
    for (const p of [...projects].sort((a, b) => a.key.localeCompare(b.key))) {
      items.push({ label: p.key, description: p.name, detail: ok.length > 1 ? hostOf(inst.baseUrl) : undefined, sel: { instanceId: inst.id, key: p.key } });
    }
  }
  if (!items.length) {
    void vscode.window.showInformationMessage('Jiraffe: проектов не найдено');
    return;
  }
  const picked = await vscode.window.showQuickPick(items, { title, placeHolder: 'Проект', matchOnDescription: true });
  if (picked?.sel) target.set(picked.sel);
}

export function registerSectionCommands(
  store: InstanceStore, meta: InstanceMeta, epicProject: SectionProject, releaseProject: SectionProject, epics: EpicsTree,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('jiraffe.pickEpicProject', () => pickSectionProject(store, meta, epicProject, 'Проект для раздела «Эпики»')),
    vscode.commands.registerCommand('jiraffe.pickReleaseProject', () => pickSectionProject(store, meta, releaseProject, 'Проект для раздела «Релизы»')),
    vscode.commands.registerCommand('jiraffe.loadMoreEpics', () => epics.loadMore()),
  ];
}
