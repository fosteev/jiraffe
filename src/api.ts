// Публичный API Jiraffe для других расширений: возвращается из `activate()` (`vscode.extensions.getExtension('fosteev.jiraffe').exports`).
// Контракт зафиксирован в Agentura (roadmap 19, решение 6): v1 только читает и открывает карточки, v2 добавляет запись
// (комментарий, переход, ворклог) от имени пользователя. Без vscode (только типы) — тестируется в vitest.
import type { Event } from 'vscode';
import type { JiraClient } from './jira/client';
import { maybeSaved } from './jira/http';
import { sanitizeDetail } from './jira/sanitize';
import type { IssueDetail, Instance, InstanceKind, StatusCategory, Worklog } from './jira/types';
import { isIsoDate, localDate, MAX_COMMENT, MAX_LOG_SEC, submitWorklog, type LogForm } from './jira/worklog';

/** Комментарий к задаче: у Jira лимит текстового поля 32 767 символов. */
export const MAX_ISSUE_COMMENT = 32_000;
/** Переход, доступный текущему пользователю. `requiresFields` — экран перехода просит поля, которые API не заполняет: `transition()` такой отклонит. */
export interface TransitionInfo { id: string; name: string; to: { name: string; category: StatusCategory }; requiresFields: boolean }
export interface LogWorkInput {
  /** Целое число секунд, 1…86 400. */
  seconds: number;
  /**
   * `YYYY-MM-DD` (как есть) или ISO-дата-время (берётся его дата в локальном поясе); в запись идёт только дата —
   * локальный полдень этого дня. По умолчанию — сегодня; будущая дата — reject.
   */
  started?: string;
  /** До 30 000 символов. */
  comment?: string;
  /** Целое ≥ 0; Tempo — атрибут AI Tokens, иначе дописывается в комментарий «(AI Tokens: N)». */
  aiTokens?: number;
}
export type WriteKind = 'comment' | 'transition' | 'worklog';

export interface JiraffeApi {
  apiVersion: 2;
  /** Инстансы в scope воркспейса (`jiraffe.instances`). */
  instances(): { id: string; name: string; baseUrl: string; kind: InstanceKind }[];
  /**
   * Задача с ворклогами. `descriptionHtml` и `bodyHtml` комментариев санитизированы (http/https/mailto; картинки — плейсхолдер
   * `span.img-ph`); остальные строки — plain text. Токенов в URL нет: вложения и аватары — адреса Jira, нужна своя авторизация.
   */
  issue(instanceId: string, key: string): Promise<{ issue: IssueDetail; worklogs: Worklog[] }>;
  /** Текущий пользователь: Cloud — `accountId`, DC — `name` (логин). Email не отдаётся. */
  myself(instanceId: string): Promise<{ accountId?: string; name?: string; displayName: string }>;
  /** Открыть карточку задачи инстанса; `beside` — в соседней колонке. */
  openIssue(instanceId: string, key: string, beside?: boolean): Promise<void>;
  onDidChangeInstances: Event<void>;
  // ---- v2: запись от имени пользователя. Инстанс — только из scope воркспейса, ключ нормализуется, как в v1; без диалогов, ошибки — reject. ----
  /** Добавить комментарий (wiki-разметка Jira). Строка до 32 000 символов, непустая после trim. */
  addComment(instanceId: string, key: string, body: string): Promise<{ id?: string }>;
  /** Переходы, доступные пользователю сейчас. */
  transitions(instanceId: string, key: string): Promise<TransitionInfo[]>;
  /** Выполнить переход. Только `id` из `transitions()` этой задачи и только без обязательных полей экрана; иначе reject. */
  transition(instanceId: string, key: string, transitionId: string): Promise<void>;
  /** Записать время (Tempo, если инстанс с Tempo, иначе Jira worklog). Tempo с обязательными атрибутами, которые API не заполняет, — reject. */
  logWork(instanceId: string, key: string, work: LogWorkInput): Promise<{ via: 'tempo' | 'jira'; id?: string }>;
}

export interface ApiDeps {
  /** Инстансы воркспейса. */
  list(): Instance[];
  /** Инстанс по id, только из scope воркспейса. */
  visible(id: string): Instance | undefined;
  client(inst: Instance): Promise<JiraClient>;
  open(instanceId: string, key: string, beside: boolean): void;
  onDidChangeInstances: Event<void>;
  /** Форма ворклога инстанса (Tempo-атрибуты). */
  logForm(inst: Instance): Promise<LogForm>;
  /** После попытки записи (в том числе неуверенной; не после отказа самого API): обновить открытую карточку и сводки. */
  changed(kind: WriteKind, instanceId: string, key: string): void;
}

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
/** Как у формы ворклога (`commands/logWork.ts`). */
const UNSURE_MS = 10 * 60_000;

export function createApi(d: ApiDeps): JiraffeApi {
  const inst = (id: unknown): Instance => {
    const i = typeof id === 'string' ? d.visible(id) : undefined;
    if (!i) throw new Error(`Jiraffe: unknown instance "${String(id).slice(0, 50)}"`);
    return i;
  };
  const key = (k: unknown): string => {
    if (typeof k !== 'string' || !KEY_RE.test(k.trim())) throw new Error(`Jiraffe: invalid issue key "${String(k).slice(0, 50)}"`);
    return k.trim().toUpperCase();
  };
  const clip = (v: unknown, n = 50): string => String(v).slice(0, n);
  /** Отказ самого API (до записи в Jira): после него карточку не обновляем. */
  class Refused extends Error {}
  const fail = (msg: string): never => { throw new Refused(`Jiraffe: ${msg}`); };
  const inFlight = new Set<string>();
  /** Запись оборвалась без ответа («могла сохраниться»): время по ключу записи — первый повтор в течение `UNSURE_MS` отклоняется. */
  const unsure = new Map<string, number>();
  /**
   * Записи по одной задаче — под замком: повторный вызов, пока первый не ответил, — reject (защита от дублей).
   * Повтор сразу после обрыва/таймаута (Jira могла записать) — первый раз reject, второй проходит — как форма ворклога.
   */
  const guarded = async <T>(kind: WriteKind, i: Instance, k: string, run: () => Promise<T>): Promise<T> => {
    const id = `${kind}:${i.id}:${k}`;
    if (inFlight.has(id)) return fail(`a ${kind} for ${k} is already being sent`);
    const at = unsure.get(id);
    unsure.delete(id);
    if (at !== undefined && Date.now() - at < UNSURE_MS) {
      return fail(`the previous ${kind} for ${k} ended without a response and may have been saved; check the issue, then call again if it is not there`);
    }
    inFlight.add(id);
    let refused = false;
    try {
      return await run();
    } catch (e) {
      refused = e instanceof Refused;
      if (e instanceof Error && e.message.includes(maybeSaved())) unsure.set(id, Date.now());
      throw e;
    } finally {
      inFlight.delete(id);
      // И при ошибке после отправки: обрыв мог сохранить запись. Сбой обновления не должен подменить результат записи.
      if (!refused) {
        try { d.changed(kind, i.id, k); } catch { /* обновление вида — не часть записи */ }
      }
    }
  };
  return {
    apiVersion: 2,
    instances: () => d.list().map((i) => ({ id: i.id, name: i.name, baseUrl: i.baseUrl, kind: i.kind })),
    async issue(instanceId, k) {
      const i = inst(instanceId);
      const { issue, worklogs } = await (await d.client(i)).issueDetail(key(k), i);
      return { issue: sanitizeDetail(issue, i.baseUrl), worklogs };
    },
    async myself(instanceId) {
      const i = inst(instanceId);
      const me = await (await d.client(i)).myself();
      // id у MyselfInfo: accountId (Cloud) или имя пользователя (DC). У Cloud имени нет (клиент подставляет туда accountId) —
      // наружу только accountId; у DC — только name. Email не отдаём.
      return i.kind === 'cloud' ? { accountId: me.id, displayName: me.displayName } : { name: me.name, displayName: me.displayName };
    },
    async openIssue(instanceId, k, beside) {
      const i = inst(instanceId);
      d.open(i.id, key(k), beside === true);
    },
    async addComment(instanceId, k, body) {
      const i = inst(instanceId);
      const kk = key(k);
      if (typeof body !== 'string' || !body.trim()) return fail('comment body must be a non-empty string');
      if (body.length > MAX_ISSUE_COMMENT) return fail(`comment is too long (max ${MAX_ISSUE_COMMENT} characters)`);
      return guarded('comment', i, kk, async () => (await d.client(i)).addComment(kk, body));
    },
    async transitions(instanceId, k) {
      const i = inst(instanceId);
      const list = await (await d.client(i)).transitions(key(k));
      return list.map((t) => ({ id: t.id, name: t.name, to: t.to, requiresFields: t.fields.length > 0 }));
    },
    async transition(instanceId, k, transitionId) {
      const i = inst(instanceId);
      const kk = key(k);
      if (typeof transitionId !== 'string' || !transitionId.trim() || transitionId.length > 50) return fail(`invalid transition id "${clip(transitionId)}"`);
      return guarded('transition', i, kk, async () => {
        const c = await d.client(i);
        const t = (await c.transitions(kk)).find((x) => x.id === transitionId);
        if (!t) return fail(`transition "${clip(transitionId)}" is not available for ${kk}`);
        if (t.fields.length) return fail(`transition "${clip(t.name, 100)}" requires fields that the API cannot fill`);
        await c.transition(kk, t.id);
      });
    },
    async logWork(instanceId, k, work) {
      const i = inst(instanceId);
      const kk = key(k);
      const w: Partial<LogWorkInput> = typeof work === 'object' && work !== null ? work : {};
      const sec = w.seconds;
      if (typeof sec !== 'number' || !Number.isInteger(sec) || sec <= 0 || sec > MAX_LOG_SEC) return fail(`seconds must be an integer from 1 to ${MAX_LOG_SEC}`);
      let date: string;
      if (w.started === undefined) date = localDate();
      else {
        const st = w.started;
        if (typeof st !== 'string' || st.length > 40 || !isIsoDate(st.slice(0, 10)) || (st.length > 10 && (st[10] !== 'T' || Number.isNaN(Date.parse(st))))) return fail(`invalid started "${clip(st)}"`);
        // Дата-время — момент: его локальная дата (`toISOString()` в UTC около полуночи иначе ушёл бы в соседний день).
        date = st.length > 10 ? localDate(new Date(Date.parse(st))) : st;
      }
      if (date > localDate()) return fail(`started "${date}" is in the future`);
      if (w.comment !== undefined && (typeof w.comment !== 'string' || w.comment.length > MAX_COMMENT)) return fail(`comment must be a string up to ${MAX_COMMENT} characters`);
      if (w.aiTokens !== undefined && (typeof w.aiTokens !== 'number' || !Number.isSafeInteger(w.aiTokens) || w.aiTokens < 0)) return fail('aiTokens must be a non-negative integer');
      return guarded('worklog', i, kk, async () => {
        const form = await d.logForm(i);
        if (form.unsupportedRequired.length) return fail('Tempo requires work attributes that the API cannot fill');
        const attrs = form.attributes.filter((a) => a.key !== form.aiTokensAttr && a.required);
        if (attrs.length) return fail('Tempo requires work attributes that the API cannot fill');
        const ai = form.attributes.find((a) => a.key === form.aiTokensAttr);
        if (ai?.required && w.aiTokens === undefined) return fail('aiTokens is required by this Tempo instance');
        return submitWorklog(await d.client(i), kk, form, {
          timeSpentSec: sec, date, comment: (w.comment ?? '').trim(), ...(w.aiTokens !== undefined ? { aiTokens: w.aiTokens } : {}), attributes: {},
        });
      });
    },
    onDidChangeInstances: d.onDidChangeInstances,
  };
}
