// Сообщения host ↔ webview: типы и пара чистых проверок. Импортируются и хостом, и webview.
import type { WorkAttribute } from '../jira/tempo';
import type { Attachment, IssueDetail, Progress, StatusCategory, UserRef, Worklog } from '../jira/types';
import type { LogDraft, LogForm, TodayInstance } from '../jira/worklog';
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
  /** Tempo-инстанс: рабочие атрибуты — колонки журнала (значения — в `worklogs[].attributes`). */
  workAttributes?: WorkAttribute[];
  pinned: boolean;
  tab: IssueTab;
}

/** Данные диалога «Залогать время» в карточке. */
export interface LogFormView extends LogForm {
  instanceName: string;
  summary: string;
  /** Сегодня (`YYYY-MM-DD`, локально) — дата по умолчанию. */
  today: string;
}

export type HostToView =
  | { type: 'loading'; instanceId: string; key: string }
  | { type: 'error'; instanceId: string; key: string; message: string }
  | { type: 'issue'; data: IssueCard }
  // Картинки приходят по одной (а не всё сразу в `issue`): dataUri — только `data:image/…;base64`, или текст ошибки.
  | { type: 'attachmentPreview'; instanceId: string; key: string; id: string; dataUri?: string; error?: string }
  // Журнал работ (этап 6): хост открывает диалог (по команде `jiraffe.logWork`) и отвечает на отправку.
  | { type: 'logForm'; instanceId: string; key: string; form: LogFormView }
  | { type: 'logResult'; instanceId: string; key: string; ok: boolean; field?: string; error?: string };

export type ViewToHost =
  | { type: 'ready' }
  | { type: 'openIssue'; key: string }
  | { type: 'openEpic'; key: string }
  | { type: 'openRelease'; id: string }
  // Действия над показанной задачей несут её ключ: хост игнорирует их, если вид устарел (preview уже грузит другую).
  | { type: 'openInBrowser'; key: string }
  | { type: 'copyKey'; key: string }
  | { type: 'logWork'; key: string }
  | { type: 'transition'; key: string }
  | { type: 'pin'; key: string }
  | { type: 'switchTab'; key: string; tab: IssueTab }
  | { type: 'openExternal'; url: string }
  // Вложения и картинки (этап 5): instanceId + key сверяются с показанной задачей, id — по формату и по таблице хоста.
  | { type: 'loadImages'; instanceId: string; key: string; ids: string[] }
  | { type: 'downloadAttachment'; instanceId: string; key: string; id: string }
  | { type: 'downloadAll'; instanceId: string; key: string }
  | { type: 'openAttachment'; instanceId: string; key: string; id: string }
  // Отправка формы «Залогать время»: значения недоверенные — хост проверяет `validateDraft` по атрибутам инстанса.
  | { type: 'submitWorklog'; instanceId: string; key: string; draft: LogDraft };

/** Раздел «Tempo» (WebviewView): сводка «сегодня». */
export interface TodayView {
  date: string;
  /** Идёт загрузка (первая или обновление). */
  loading: boolean;
  totalSec: number;
  workdaySec: number;
  /** Нет ни одного инстанса. */
  noInstances: boolean;
  instances: TodayInstance[];
}

export type HostToTempo = { type: 'today'; data: TodayView };

export type TempoToHost =
  | { type: 'ready' }
  | { type: 'openIssue'; instanceId: string; key: string }
  | { type: 'logWork' }
  | { type: 'refresh' }
  | { type: 'addInstance' };

// ----- вкладки эпика и релиза (этап 7) -----

/** Строка таблицы эпика/релиза. `extra` — релиз (в эпике) или название эпика (в релизе). Адресов Jira здесь нет. */
export interface ListRow {
  key: string;
  summary: string;
  type: string;
  status: string;
  statusCategory: StatusCategory;
  priority?: string;
  assignee?: UserRef;
  extra?: string;
}

interface ListPageBase {
  instanceId: string;
  instanceName: string;
  /** Ключ проекта (для крошек); пустой, если не удалось определить. */
  project: string;
  progress: Progress;
  rows: ListRow[];
  /** Задач больше лимита запроса: показаны первые, прогресс — по ним. */
  truncated: boolean;
}

export interface EpicPage extends ListPageBase {
  type: 'epic';
  key: string;
  summary: string;
  status: string;
  statusCategory: StatusCategory;
  /** DC: id поля Epic Link; Cloud: `parent`; `null` — поля нет, задач эпика не найти. */
  link: string | null;
  kind: 'dc' | 'cloud';
}

export interface ReleasePage extends ListPageBase {
  type: 'release';
  id: string;
  name: string;
  description?: string;
  released: boolean;
  startDate?: string;
  releaseDate?: string;
  /** Дней до выпуска (не выпущен, дата задана; отрицательное — просрочен). */
  daysLeft?: number;
}

export type ListPage = EpicPage | ReleasePage;

/** `kind` + `id` — какая вкладка запрашивала: эпик (`id` = ключ) или релиз (`id` = id версии). */
export type HostToList =
  | { type: 'loading'; kind: ListPage['type']; instanceId: string; id: string }
  | { type: 'error'; kind: ListPage['type']; instanceId: string; id: string; message: string }
  | { type: 'page'; data: ListPage };

export type ListToHost =
  | { type: 'ready' }
  | { type: 'openIssue'; instanceId: string; key: string }
  | { type: 'openInBrowser'; instanceId: string; kind: ListPage['type']; id: string }
  | { type: 'refresh'; instanceId: string; kind: ListPage['type']; id: string };
