// Сообщения host ↔ webview: типы и пара чистых проверок. Импортируются и хостом, и webview.
import type { IssueDetail, Worklog } from '../jira/types';
import { ISSUE_KEY_RE } from '../jql';

export type IssueTab = 'desc' | 'com' | 'hist' | 'wl';
export const ISSUE_TABS: readonly IssueTab[] = ['desc', 'com', 'hist', 'wl'];

/** Данным из webview хост не доверяет: ключ задачи/эпика и id релиза — строго по формату Jira. */
export const isIssueKey = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && ISSUE_KEY_RE.test(v);
export const isVersionId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,18}$/.test(v);

/** Ссылка из webview наружу: только http(s) и mailto; `javascript:`, `file:`, `vscode:`, `command:` и мусор — `undefined`. */
export function safeExternalUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Всё, что нужно webview для отрисовки карточки. HTML внутри `issue` уже санитизирован. */
export interface IssueCard {
  instanceId: string;
  instanceName: string;
  /** Хост инстанса для крошек (`jira.example.com/jira`). */
  host: string;
  kind: 'dc' | 'cloud';
  tempo: boolean;
  issue: IssueDetail;
  worklogs: Worklog[];
  /** Журнал не загрузился (не 403/404 — те дают пустой список): текст ошибки для вкладки «Журнал работ». */
  worklogError?: string;
  pinned: boolean;
  tab: IssueTab;
}

export type HostToView =
  | { type: 'loading'; instanceId: string; key: string }
  | { type: 'error'; instanceId: string; key: string; message: string }
  | { type: 'issue'; data: IssueCard };

export type ViewToHost =
  | { type: 'ready' }
  | { type: 'openIssue'; key: string }
  | { type: 'openEpic'; key: string }
  | { type: 'openRelease'; id: string }
  // Действия над показанной задачей несут её ключ: хост игнорирует их, если вид устарел (preview уже грузит другую).
  | { type: 'openInBrowser'; key: string }
  | { type: 'copyKey'; key: string }
  | { type: 'logWork'; key: string }
  | { type: 'pin'; key: string }
  | { type: 'switchTab'; key: string; tab: IssueTab }
  | { type: 'openExternal'; url: string };
