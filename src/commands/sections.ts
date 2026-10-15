import * as vscode from 'vscode';
import { perInstance, withProgress } from './filters';
import type { InstanceStore } from '../state/instances';
import type { InstanceMeta } from '../state/meta';
import type { ProjectSel } from '../state/filters';
import type { SectionProject, SectionProjects } from '../state/sectionProject';
import { hostOf } from '../views/format';
import type { EpicsTree } from '../views/epicsTree';
import { t } from '../l10n';

type ProjectItem = vscode.QuickPickItem & { sel?: ProjectSel };

/** Проекты всех инстансов для QuickPick (по инстансу — разделитель); `undefined` — выбирать не из чего, пользователю уже сказали. */
async function loadProjectItems(store: InstanceStore, meta: InstanceMeta): Promise<{ items: ProjectItem[]; loaded: Set<string> } | undefined> {
  const all = store.list();
  if (!all.length) {
    const act = await vscode.window.showInformationMessage(t('Jiraffe: no instances yet'), t('Add'));
    if (act) await vscode.commands.executeCommand('jiraffe.addInstance');
    return undefined;
  }
  const { ok, failed } = await withProgress(t('Jiraffe: loading projects…'), () => perInstance(all, (i) => meta.projects(i)));
  if (failed.length) void vscode.window.showWarningMessage(t('Jiraffe: projects failed to load — {0}', failed.join('; ')));
  const items: ProjectItem[] = [];
  for (const [inst, projects] of ok) {
    if (ok.length > 1) items.push({ label: inst.name, kind: vscode.QuickPickItemKind.Separator });
    for (const p of [...projects].sort((a, b) => a.key.localeCompare(b.key))) {
      items.push({ label: p.key, description: p.name, detail: ok.length > 1 ? hostOf(inst.baseUrl) : undefined, sel: { instanceId: inst.id, key: p.key } });
    }
  }
  if (!items.length) {
    void vscode.window.showInformationMessage(t('Jiraffe: no projects found'));
    return undefined;
  }
  return { items, loaded: new Set(ok.map(([inst]) => inst.id)) };
}

/** QuickPick проекта (по всем инстансам) для раздела «Эпики»; выбор пишется в `target`. */
async function pickSectionProject(store: InstanceStore, meta: InstanceMeta, target: SectionProject, title: string): Promise<void> {
  const loaded = await loadProjectItems(store, meta);
  if (!loaded) return;
  const picked = await vscode.window.showQuickPick(loaded.items, { title, placeHolder: t('Project'), matchOnDescription: true });
  if (picked?.sel) target.set(picked.sel);
}

/**
 * Галочки по проектам для раздела «Релизы». Проекты инстансов, чей список не загрузился или которые не в этом workspace,
 * в пикере не видны — они остаются в выборе как были (сбой сети не должен молча снять слежку).
 */
async function pickSectionProjects(store: InstanceStore, meta: InstanceMeta, target: SectionProjects, title: string): Promise<void> {
  const loaded = await loadProjectItems(store, meta);
  if (!loaded) return;
  const current = target.get();
  const on = new Set(current.map((s) => `${s.instanceId}\n${s.key}`));
  for (const it of loaded.items) if (it.sel) it.picked = on.has(`${it.sel.instanceId}\n${it.sel.key}`);
  const picked = await vscode.window.showQuickPick(loaded.items, { title, placeHolder: t('Projects to follow'), matchOnDescription: true, canPickMany: true });
  if (!picked) return;
  const kept = current.filter((s) => !loaded.loaded.has(s.instanceId));
  target.set([...kept, ...picked.flatMap((it) => (it.sel ? [it.sel] : []))]);
}

export function registerSectionCommands(
  store: InstanceStore, meta: InstanceMeta, epicProject: SectionProject, releaseProject: SectionProjects, epics: EpicsTree,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('jiraffe.pickEpicProject', () => pickSectionProject(store, meta, epicProject, t('Project for the Epics Section'))),
    vscode.commands.registerCommand('jiraffe.pickReleaseProject', () => pickSectionProjects(store, meta, releaseProject, t('Projects for the Releases Section'))),
    vscode.commands.registerCommand('jiraffe.unfollowReleaseProject', (n?: { sel?: ProjectSel }) => {
      if (n?.sel) releaseProject.remove(n.sel);
    }),
    vscode.commands.registerCommand('jiraffe.loadMoreEpics', () => epics.loadMore()),
    vscode.commands.registerCommand('jiraffe.myEpics', () => epics.setFilter({ mine: true })),
    vscode.commands.registerCommand('jiraffe.allEpics', () => epics.setFilter({ mine: false })),
    vscode.commands.registerCommand('jiraffe.searchEpics', async () => {
      const text = await vscode.window.showInputBox({
        title: t('Search Epics'), value: epics.filter.text, placeHolder: t('Epic name; empty — clear the search'),
      });
      if (text !== undefined) epics.setFilter({ text });
    }),
  ];
}
