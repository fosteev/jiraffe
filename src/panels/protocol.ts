// Сообщения host ↔ webview: типы и пара чистых проверок. Импортируются и хостом, и webview.
import type { Attachment, IssueDetail, Worklog } from '../jira/types';
import { ISSUE_KEY_RE } from '../jql';

export type IssueTab = 'desc' | 'att' | 'com' | 'hist' | 'wl';
export const ISSUE_TABS: readonly IssueTab[] = ['desc', 'att', 'com', 'hist', 'wl'];

/** Данным из webview хост не доверяет: ключ задачи/эпика и id релиза — строго по формату Jira. */
export const isIssueKey = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && ISSUE_KEY_RE.test(v);
export const isVersionId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,18}$/.test(v);
/** Id вложения Jira — число (DC и Cloud). */
export const isAttachmentId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,18}$/.test(v);
/** Id картинки: `iN` — картинка описания/комментария (номер в таблице хоста), `tID` — превью вложения, `fID` — вложение целиком. */
export const isImageId = (v: unknown): v is string => typeof v === 'string' && /^(?:i\d{1,5}|[tf]\d{1,18})$/.test(v);
/** Не больше стольких id в одном `loadImages`. */
export const MAX_IMAGE_IDS = 200;

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

/**
 * Вложение для webview — без адресов Jira (качает только хост). `image`/`text` — подсказки по метаданным Jira:
 * пробовать ли превью и показывать ли «Открыть в редакторе»; окончательная проверка — по содержимому, в хосте.
 */
export interface AttachmentView extends Omit<Attachment, 'contentUrl' | 'thumbnailUrl'> {
  image: boolean;
  text: boolean;
}

/**
 * Всё, что нужно webview для отрисовки карточки. HTML внутри `issue` уже санитизирован, картинки в нём —
 * `span.img-ph[data-img]` (адреса остаются в хосте). `issue.attachments` пустой: вложения — в `attachments`, без URL.
 */
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
  attachments: AttachmentView[];
  pinned: boolean;
  tab: IssueTab;
}

export type HostToView =
  | { type: 'loading'; instanceId: string; key: string }
  | { type: 'error'; instanceId: string; key: string; message: string }
  | { type: 'issue'; data: IssueCard }
  // Картинки приходят по одной (а не всё сразу в `issue`): dataUri — только `data:image/…;base64`, или текст ошибки.
  | { type: 'attachmentPreview'; instanceId: string; key: string; id: string; dataUri?: string; error?: string };

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
  | { type: 'openExternal'; url: string }
  // Вложения и картинки (этап 5): instanceId + key сверяются с показанной задачей, id — по формату и по таблице хоста.
  | { type: 'loadImages'; instanceId: string; key: string; ids: string[] }
  | { type: 'downloadAttachment'; instanceId: string; key: string; id: string }
  | { type: 'downloadAll'; instanceId: string; key: string }
  | { type: 'openAttachment'; instanceId: string; key: string; id: string };
