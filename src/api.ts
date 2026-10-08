// Публичный API Jiraffe для других расширений: возвращается из `activate()` (`vscode.extensions.getExtension('fosteev.jiraffe').exports`).
// Контракт зафиксирован в Agentura (roadmap 19, решение 6): v1 только читает и открывает карточки. Без vscode (только типы) — тестируется в vitest.
import type { Event } from 'vscode';
import type { JiraClient } from './jira/client';
import { sanitizeDetail } from './jira/sanitize';
import type { IssueDetail, Instance, InstanceKind, Worklog } from './jira/types';

export interface JiraffeApi {
  apiVersion: 1;
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
}

export interface ApiDeps {
  /** Инстансы воркспейса. */
  list(): Instance[];
  /** Инстанс по id, только из scope воркспейса. */
  visible(id: string): Instance | undefined;
  client(inst: Instance): Promise<JiraClient>;
  open(instanceId: string, key: string, beside: boolean): void;
  onDidChangeInstances: Event<void>;
}

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

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
  return {
    apiVersion: 1,
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
    onDidChangeInstances: d.onDidChangeInstances,
  };
}
