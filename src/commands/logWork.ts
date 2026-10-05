// «Залогать время»: сервис записи (общий для диалога карточки и QuickInput) и команда `jiraffe.logWork`.
import * as vscode from 'vscode';
import { formatDuration, parseDuration } from '../duration';
import { noticeText } from '../jira/attachments';
import { maybeSaved } from '../jira/http';
import type { WorkAttribute } from '../jira/tempo';
import type { Instance } from '../jira/types';
import {
  isIsoDate, localDate, logFormFor, MAX_LOG_SEC, parseTokens, submitWorklog, validateDraft, type LogDraft, type LogForm,
} from '../jira/worklog';
import { isIssueKey } from '../panels/protocol';
import type { InstanceStore } from '../state/instances';
import type { InstanceMeta } from '../state/meta';
import type { IssueRef } from '../views/issuesTree';
import { pickIssueRef } from './filters';
import { t } from '../l10n';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const idOf = (r: IssueRef): string => `${r.instanceId}\n${r.key}`;
/** Сколько после неоднозначной ошибки повтор требует подтверждения, и через сколько перечитать журнал второй раз. */
const UNSURE_MS = 10 * 60_000;
const RELOAD_AFTER_UNSURE_MS = 15_000;

export type SubmitResult = { ok: true } | { ok: false; field?: string; error: string };

/**
 * Запись времени. Форма строится по атрибутам инстанса (`work-attribute`, кэш `InstanceMeta`), значения из формы
 * проверяются `validateDraft` здесь, в хосте. Одновременно — не больше одной записи в одну задачу.
 * После записи (и после неоднозначной ошибки — сеть/таймаут, запись могла пройти) — `onDidLog`: карточка, «сегодня».
 */
export class WorklogService {
  private readonly inFlight = new Set<string>();
  /** Задачи, где последняя отправка закончилась неоднозначно (запись могла пройти): следующая отправка — только после предупреждения. */
  private readonly unsure = new Map<string, number>();
  private readonly listeners = new Set<(ref: IssueRef) => void>();

  constructor(
    private readonly store: InstanceStore,
    private readonly meta: InstanceMeta,
  ) {}

  onDidLog(fn: (ref: IssueRef) => void): vscode.Disposable {
    this.listeners.add(fn);
    return new vscode.Disposable(() => this.listeners.delete(fn));
  }

  /** Форма для инстанса. Tempo без атрибутов (ошибка `work-attribute`) — ошибка: молча слать AI Tokens в комментарий нельзя. */
  async form(inst: Instance): Promise<LogForm> {
    const tempo = inst.caps?.tempo === true;
    let attrs: WorkAttribute[] = [];
    if (tempo) {
      try {
        attrs = await this.meta.workAttributes(inst);
      } catch (e) {
        throw new Error(t('could not load Tempo work attributes: {0}', errText(e)));
      }
    }
    return logFormFor(tempo, attrs);
  }

  async submit(ref: IssueRef, draft: unknown): Promise<SubmitResult> {
    const inst = this.store.get(ref.instanceId);
    if (!inst) return { ok: false, error: t('The instance was removed — add it again') };
    if (!isIssueKey(ref.key)) return { ok: false, error: t('Invalid issue key') };
    const id = idOf(ref);
    if (this.inFlight.has(id)) return { ok: false, error: t('A worklog for this issue is already being sent — wait for Jira to respond') };
    const unsureAt = this.unsure.get(id);
    this.unsure.delete(id);
    if (unsureAt !== undefined && Date.now() - unsureAt < UNSURE_MS) {
      // Повтор сразу после таймаута/5xx — частый источник дублей: первый раз останавливаем, второй — отправляем.
      return { ok: false, error: t('The previous submission to this issue ended without a response — the worklog may have been saved. Check the issue’s Work Log; if it’s not there, submit again.') };
    }
    // Флаг ставится до первого await: два сообщения подряд (двойной клик, Enter + клик) не должны оба пройти проверку.
    this.inFlight.add(id);
    try {
      let form: LogForm;
      try {
        form = await this.form(inst);
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
      const v = validateDraft(draft, form);
      if (!v.ok) return v;
      const { req } = v;
      const client = await this.meta.client(inst);
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('Jiraffe: logging {0} to {1}…', formatDuration(req.timeSpentSec), ref.key) },
        () => submitWorklog(client, ref.key, form, req),
      );
      const when = req.date === localDate() ? '' : t(' for {0}', req.date);
      void vscode.window.showInformationMessage(noticeText(t('Jiraffe: Logged {0} to {1}{2} · {3}', formatDuration(req.timeSpentSec), ref.key, when, r.via === 'tempo' ? 'Tempo' : t('Jira worklog')), 200));
      this.fire(ref);
      return { ok: true };
    } catch (e) {
      // Обрыв/таймаут после отправки: запись могла пройти — обновим карточку и сводку, чтобы это было видно.
      // Сервер мог закоммитить позже нашего GET — перечитываем ещё раз с задержкой.
      if (e instanceof Error && e.message.includes(maybeSaved())) {
        this.unsure.set(id, Date.now());
        this.fire(ref);
        setTimeout(() => this.fire(ref), RELOAD_AFTER_UNSURE_MS);
      }
      return { ok: false, error: errText(e) };
    } finally {
      this.inFlight.delete(id);
    }
  }

  private fire(ref: IssueRef): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(ref);
      } catch { /* слушатель не ломает запись */ }
    }
  }
}

/** Аргумент команды: `IssueRef` (карточка, Tempo) или узел дерева «Задачи» (`{kind:'issue', instanceId, issue:{key}}`). */
export function refOf(arg: unknown): IssueRef | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const a = arg as { instanceId?: unknown; key?: unknown; kind?: unknown; issue?: { key?: unknown } };
  const key = a.kind === 'issue' ? a.issue?.key : a.key;
  return typeof a.instanceId === 'string' && isIssueKey(key) ? { instanceId: a.instanceId, key } : undefined;
}

/** Что команда умеет спросить у карточки: открыть диалог в ней, если она открыта. */
export interface LogWorkPanels {
  /** Карточка задачи открыта и загружена — показать диалог в ней (true), иначе false. */
  showLogForm(ref: IssueRef): Promise<boolean>;
  /** Задача активной (или preview) карточки. */
  activeRef(): IssueRef | undefined;
}

/**
 * `jiraffe.logWork(ref?)`: из карточки, контекстного меню дерева, раздела Tempo и палитры.
 * Карточка задачи открыта — диалог в ней (как `logHtml` прототипа); иначе — QuickInput: длительность → дата → комментарий → атрибуты.
 * Без аргумента — задача активной карточки, а нет её — ключ из InputBox.
 */
export function registerLogWorkCommand(service: WorklogService, panels: LogWorkPanels, store: InstanceStore, meta: InstanceMeta): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('jiraffe.logWork', async (arg?: unknown) => {
      const ref = refOf(arg) ?? panels.activeRef() ?? (await pickIssueRef(store, meta, undefined, t('Log Work: issue key')));
      if (!ref) return;
      if (await panels.showLogForm(ref)) return;
      await quickLog(service, store, ref);
    }),
  ];
}

async function quickLog(service: WorklogService, store: InstanceStore, ref: IssueRef): Promise<void> {
  const inst = store.get(ref.instanceId);
  if (!inst) return;
  let form: LogForm;
  try {
    form = inst.caps?.tempo
      ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('Jiraffe: Tempo attributes…') }, () => service.form(inst))
      : await service.form(inst);
  } catch (e) {
    void vscode.window.showErrorMessage(`Jiraffe: ${noticeText(errText(e))}`);
    return;
  }
  const title = t('Log Work · {0}', ref.key) + (form.tempo ? ' · Tempo' : '');
  if (form.unsupportedRequired.length) {
    void vscode.window.showWarningMessage(noticeText(t('Jiraffe: required Tempo attributes are not supported by the form ({0}) — Tempo may reject the entry', form.unsupportedRequired.join(', ')), 240));
  }
  const duration = await vscode.window.showInputBox({
    title: `${title} (1/4)`,
    prompt: t('Spent: 1h 30m · 1h30m · 90m · 1.5h'),
    placeHolder: t('1h 30m'),
    ignoreFocusOut: true,
    validateInput: (v) => {
      const s = parseDuration(v);
      if (!s) return t('Can’t parse the duration. Example: 1h 30m or 90m');
      return s > MAX_LOG_SEC ? t('More than a day in one entry') : undefined;
    },
  });
  if (duration === undefined) return;
  const date = await pickDate(`${title} (2/4)`);
  if (!date) return;
  const comment = await vscode.window.showInputBox({ title: `${title} (3/4)`, prompt: t('Comment (optional)'), placeHolder: t('What was done'), ignoreFocusOut: true });
  if (comment === undefined) return;
  const attributes: Record<string, string> = {};
  let aiTokens = '';
  const aiAttr = form.attributes.find((a) => a.key === form.aiTokensAttr);
  const tokens = await vscode.window.showInputBox({
    title: `${title} (4/4)`,
    prompt: `${aiAttr?.name ?? 'AI Tokens'}${aiAttr?.required ? '' : t(' (optional)')}${form.aiTokensAttr ? t(' — Tempo attribute') : t(' — will be appended to the comment as “(AI Tokens: N)”')}`,
    placeHolder: t('e.g. 120000'),
    ignoreFocusOut: true,
    validateInput: (v) => (parseTokens(v) === undefined ? t('Whole number') : aiAttr?.required && parseTokens(v) === null ? t('Required field') : undefined),
  });
  if (tokens === undefined) return;
  aiTokens = tokens;
  for (const a of form.attributes) {
    if (a.key === form.aiTokensAttr) continue;
    const v = await askAttribute(a, t('{0} · attributes', title));
    if (v === undefined) return;
    if (v) attributes[a.key] = v;
  }
  const draft: LogDraft = { duration, date, comment, aiTokens, attributes };
  const r = await service.submit(ref, draft);
  if (!r.ok) void vscode.window.showErrorMessage(`Jiraffe: ${noticeText(r.error, 240)}`);
}

async function pickDate(title: string): Promise<string | undefined> {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const items = [
    { label: t('Today'), description: localDate(today), date: localDate(today) },
    { label: t('Yesterday'), description: localDate(yesterday), date: localDate(yesterday) },
    { label: t('Another date…'), date: '' },
  ];
  const picked = await vscode.window.showQuickPick(items, { title, placeHolder: t('Entry date'), ignoreFocusOut: true });
  if (!picked) return undefined;
  if (picked.date) return picked.date;
  return vscode.window.showInputBox({
    title, prompt: t('Date as YYYY-MM-DD'), value: localDate(today), ignoreFocusOut: true,
    validateInput: (v) => (!isIsoDate(v.trim()) ? t('Date like 2026-10-04') : v.trim() > localDate() ? t('Date in the future') : undefined),
  }).then((v) => v?.trim());
}

/** Значение атрибута: '' — не указан, undefined — отмена. */
async function askAttribute(a: WorkAttribute, title: string): Promise<string | undefined> {
  const opt = a.required ? '' : t(' (optional)');
  if (a.kind === 'list') {
    const items = [...(a.required ? [] : [{ label: t('— leave empty'), value: '' }]), ...(a.values ?? []).map((v) => ({ label: v.name, value: v.value }))];
    return (await vscode.window.showQuickPick(items, { title, placeHolder: `${a.name}${opt}`, ignoreFocusOut: true }))?.value;
  }
  if (a.kind === 'checkbox') {
    const items = [{ label: t('Yes'), value: 'true' }, { label: t('No'), value: '' }];
    return (await vscode.window.showQuickPick(items, { title, placeHolder: a.name, ignoreFocusOut: true }))?.value;
  }
  return vscode.window.showInputBox({
    title, prompt: `${a.name}${opt}`, ignoreFocusOut: true,
    validateInput: (v) => {
      if (a.required && !v.trim()) return t('Required field');
      if (a.kind === 'number' && v.trim() && !/^-?\d{1,15}(?:[.,]\d{1,6})?$/.test(v.trim())) return t('Number');
      return undefined;
    },
  });
}
