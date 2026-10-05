// «Сменить статус»: команда `jiraffe.transition` — карточка (клик по статусу), контекстное меню дерева, палитра.
import * as vscode from 'vscode';
import { noticeText } from '../jira/attachments';
import type { Transition } from '../jira/client';
import { maybeSaved } from '../jira/http';
import { browseUrl } from '../panels/card';
import type { InstanceStore } from '../state/instances';
import type { InstanceMeta } from '../state/meta';
import type { IssueRef } from '../views/issuesTree';
import { pickIssueRef } from './filters';
import { refOf, type LogWorkPanels } from './logWork';
import { t } from '../l10n';

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
      const ref = refOf(arg) ?? panels.activeRef() ?? (await pickIssueRef(store, meta, undefined, t('Change Status: issue key')));
      if (!ref) return;
      const inst = store.get(ref.instanceId);
      if (!inst) return;
      const id = idOf(ref);
      if (inFlight.has(id)) return;
      inFlight.add(id);
      try {
        const client = await meta.client(inst);
        const list = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: t('Jiraffe: transitions for {0}…', ref.key) },
          () => client.transitions(ref.key),
        );
        if (!list.length) {
          void vscode.window.showInformationMessage(t('Jiraffe: {0} has no available transitions', ref.key));
          return;
        }
        const tr = await pickTransition(ref.key, list);
        if (!tr) return;
        const fields = await askFields(inst.baseUrl, ref, tr);
        if (!fields) return;
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Jiraffe: ${ref.key} → ${tr.to.name || tr.name}…` },
            () => client.transition(ref.key, tr.id, fields),
          );
        } catch (e) {
          if (e instanceof Error && e.message.includes(maybeSaved())) onDone(ref);
          throw e;
        }
        void vscode.window.showInformationMessage(noticeText(`Jiraffe: ${ref.key} → ${tr.to.name || tr.name}`, 200));
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
  const items = list.map((tr) => ({
    label: tr.name,
    // Имя перехода часто совпадает со статусом — тогда стрелку не дублируем.
    description: tr.to.name && tr.to.name !== tr.name ? `→ ${tr.to.name}` : '',
    detail: tr.fields.length ? t('Requires: {0}', tr.fields.map((f) => f.name).join(', ')) : undefined,
    tr,
  }));
  return (await vscode.window.showQuickPick(items, { title: t('Change Status · {0}', key), placeHolder: t('Transition'), ignoreFocusOut: true }))?.tr;
}

/** Значения обязательных полей перехода; undefined — отмена или поле, которое форма не умеет. */
async function askFields(baseUrl: string, ref: IssueRef, tr: Transition): Promise<Record<string, unknown> | undefined> {
  const unsupported = tr.fields.filter((f) => !f.allowedValues?.length);
  if (unsupported.length) {
    const act = await vscode.window.showWarningMessage(
      noticeText(t('Jiraffe: transition “{0}” needs fields that can’t be filled here ({1})', tr.name, unsupported.map((f) => f.name).join(', ')), 240),
      t('Open in Jira'),
    );
    if (act) void vscode.env.openExternal(vscode.Uri.parse(browseUrl(baseUrl, ref.key)));
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const f of tr.fields) {
    const picked = await vscode.window.showQuickPick(
      (f.allowedValues ?? []).map((v) => ({ label: v.name, id: v.id })),
      { title: `${tr.name} · ${ref.key}`, placeHolder: f.name, ignoreFocusOut: true },
    );
    if (!picked) return undefined;
    out[f.id] = f.array ? [{ id: picked.id }] : { id: picked.id };
  }
  return out;
}
