// «Сменить статус»: команда `jiraffe.transition` — карточка (клик по статусу), контекстное меню дерева, палитра.
import * as vscode from 'vscode';
import { noticeText } from '../jira/attachments';
import type { Transition } from '../jira/client';
import { MAYBE_SAVED } from '../jira/http';
import { browseUrl } from '../panels/card';
import type { InstanceStore } from '../state/instances';
import type { InstanceMeta } from '../state/meta';
import type { IssueRef } from '../views/issuesTree';
import { pickIssueRef } from './filters';
import { refOf, type LogWorkPanels } from './logWork';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const idOf = (r: IssueRef): string => `${r.instanceId}\n${r.key}`;

/**
 * Переходы — из Jira (`/transitions`, только доступные пользователю). Обязательные поля экрана перехода со списком значений
 * (резолюция и т. п.) спрашиваются QuickPick'ом; остальные (текст, пользователь, дата) — не поддерживаются: предлагаем Jira в браузере.
 * После перехода (и после обрыва — переход мог пройти) — `onDone`: карточка, дерево, вкладки эпиков/релизов.
 */
export function registerTransitionCommand(
  panels: Pick<LogWorkPanels, 'activeRef'>,
  store: InstanceStore,
  meta: InstanceMeta,
  onDone: (ref: IssueRef) => void,
): vscode.Disposable[] {
  const inFlight = new Set<string>();
  return [
    vscode.commands.registerCommand('jiraffe.transition', async (arg?: unknown) => {
      const ref = refOf(arg) ?? panels.activeRef() ?? (await pickIssueRef(store, meta, undefined, 'Сменить статус: ключ задачи'));
      if (!ref) return;
      const inst = store.get(ref.instanceId);
      if (!inst) return;
      const id = idOf(ref);
      if (inFlight.has(id)) return;
      inFlight.add(id);
      try {
        const client = await meta.client(inst);
        const list = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: `Jiraffe: переходы ${ref.key}…` },
          () => client.transitions(ref.key),
        );
        if (!list.length) {
          void vscode.window.showInformationMessage(`Jiraffe: у ${ref.key} нет доступных переходов`);
          return;
        }
        const t = await pickTransition(ref.key, list);
        if (!t) return;
        const fields = await askFields(inst.baseUrl, ref, t);
        if (!fields) return;
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Jiraffe: ${ref.key} → ${t.to.name || t.name}…` },
            () => client.transition(ref.key, t.id, fields),
          );
        } catch (e) {
          if (e instanceof Error && e.message.includes(MAYBE_SAVED)) onDone(ref);
          throw e;
        }
        void vscode.window.showInformationMessage(noticeText(`Jiraffe: ${ref.key} → ${t.to.name || t.name}`, 200));
        onDone(ref);
      } catch (e) {
        void vscode.window.showErrorMessage(`Jiraffe: ${noticeText(errText(e), 240)}`);
      } finally {
        inFlight.delete(id);
      }
    }),
  ];
}

async function pickTransition(key: string, list: Transition[]): Promise<Transition | undefined> {
  const items = list.map((t) => ({
    label: t.name,
    // Имя перехода часто совпадает со статусом — тогда стрелку не дублируем.
    description: t.to.name && t.to.name !== t.name ? `→ ${t.to.name}` : '',
    detail: t.fields.length ? `Потребуется: ${t.fields.map((f) => f.name).join(', ')}` : undefined,
    t,
  }));
  return (await vscode.window.showQuickPick(items, { title: `Сменить статус · ${key}`, placeHolder: 'Переход', ignoreFocusOut: true }))?.t;
}

/** Значения обязательных полей перехода; undefined — отмена или поле, которое форма не умеет. */
async function askFields(baseUrl: string, ref: IssueRef, t: Transition): Promise<Record<string, unknown> | undefined> {
  const unsupported = t.fields.filter((f) => !f.allowedValues?.length);
  if (unsupported.length) {
    const act = await vscode.window.showWarningMessage(
      noticeText(`Jiraffe: переход «${t.name}» требует полей, которые здесь не заполнить (${unsupported.map((f) => f.name).join(', ')})`, 240),
      'Открыть в Jira',
    );
    if (act) void vscode.env.openExternal(vscode.Uri.parse(browseUrl(baseUrl, ref.key)));
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const f of t.fields) {
    const picked = await vscode.window.showQuickPick(
      (f.allowedValues ?? []).map((v) => ({ label: v.name, id: v.id })),
      { title: `${t.name} · ${ref.key}`, placeHolder: f.name, ignoreFocusOut: true },
    );
    if (!picked) return undefined;
    out[f.id] = f.array ? [{ id: picked.id }] : { id: picked.id };
  }
  return out;
}
