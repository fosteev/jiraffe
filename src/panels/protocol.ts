// Сообщения host ↔ webview: типы и пара чистых проверок. Импортируются и хостом, и webview.
import type { WorkAttribute } from '../jira/tempo';
import type { Attachment, IssueDetail, Progress, StatusCategory, UserRef, Worklog } from '../jira/types';
import type { LogDraft, LogForm, TodayInstance } from '../jira/worklog';
import { ISSUE_KEY_RE } from '../jql';
import { isSettingId, parseSetting, type SectionId, type SettingId, type SettingsState, type SettingValue } from './settingsModel';

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
  /** Установлена Agentura — показать кнопку «Спросить ИИ». */
  ai?: boolean;
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
  | { type: 'askAi'; key: string }
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

/** Строка таблицы эпика/релиза. `extra` — релиз (в эпике) или название эпика (в релизе); `epicKey` — ключ эпика (только релиз). Адресов Jira здесь нет. */
export interface ListRow {
  key: string;
  summary: string;
  type: string;
  status: string;
  statusCategory: StatusCategory;
  priority?: string;
  assignee?: UserRef;
  extra?: string;
  /** Релиз: ключ эпика задачи (по нему фасет «Эпик» и JQL); `extra` остаётся названием для показа. */
  epicKey?: string;
}

// ----- фильтры внутри релиза -----

export type FilterCat = 'new' | 'indeterminate' | 'done';
export type FilterGroup = 'none' | 'assignee' | 'epic' | 'status';

/**
 * Фильтр вкладки релиза. Пустая строка в фасете — «пустое значение»: не назначена / без эпика / без приоритета.
 * `assignee` — `UserRef.id`, `type`/`priority` — имена как в `ListRow`, `epic` — `epicKey`.
 */
export interface ReleaseFilter {
  q: string;
  cats: FilterCat[];
  assignee: string[];
  type: string[];
  priority: string[];
  epic: string[];
  mine: boolean;
  group: FilterGroup;
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
  /** Id текущего пользователя (`UserRef.id`); нет — «Только мои» не работает (`myself` не ответил). */
  meId?: string;
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
  | { type: 'refresh'; instanceId: string; kind: ListPage['type']; id: string }
  // Релиз: JQL из текущего фильтра — скопировать или сохранить. Хост сверяет вкладку и прогоняет `filter` через `sanitizeFilter`.
  | { type: 'filterJql'; instanceId: string; kind: 'release'; id: string; action: 'copy' | 'save'; filter: ReleaseFilter };

// ----- вкладка «Настройки Jiraffe» -----

export type HostToSettings =
  | { type: 'state'; state: SettingsState }
  /** Прокрутить к разделу (команда `jiraffe.openSettings(section)`). */
  | { type: 'scroll'; section: SectionId };

/** Id инстанса — slug из адреса (`instanceIdFromUrl`): латиница, цифры, дефис. Что именно за инстанс, хост сверяет со своим списком. */
export const isInstanceId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,199}$/.test(v);

/** Действия над карточкой инстанса: имя/токен вводятся в нативных окнах VS Code, через webview не проходят. */
export const INSTANCE_ACTIONS = ['check', 'refreshCaps', 'rename', 'setToken', 'remove'] as const;
export type InstanceAction = (typeof INSTANCE_ACTIONS)[number];

export type SettingsToHost =
  | { type: 'ready' }
  /** Новое значение настройки; проверяет хост (`parseSettingsMessage`). Значение зависит от `id`: число, строка, булево или `{field, desc}`. */
  | { type: 'set'; id: SettingId; value: unknown }
  | { type: 'reset'; id: SettingId }
  | { type: 'pickDir' }
  | { type: 'openJson' }
  /** Дописать папку вложений в .gitignore (путь хост берёт сам из настроек, не из сообщения). */
  | { type: 'addGitignore' }
  | { type: 'instance'; action: InstanceAction; id: string }
  | { type: 'addInstance' }
  /** Набор workspace: «все подключённые» / «только отмеченные». */
  | { type: 'scopeMode'; mode: 'all' | 'some' }
  | { type: 'scopeToggle'; id: string; on: boolean };

export type SettingsMessage =
  | { type: 'ready' }
  | { type: 'set'; setting: SettingValue }
  | { type: 'reset'; id: SettingId }
  | { type: 'pickDir' }
  | { type: 'openJson' }
  | { type: 'addGitignore' }
  | { type: 'instance'; action: InstanceAction; id: string }
  | { type: 'addInstance' }
  | { type: 'scopeMode'; mode: 'all' | 'some' }
  | { type: 'scopeToggle'; id: string; on: boolean }
  /** Сообщение неузнаваемо или значение не прошло проверку: хост покажет `error` и перерисует вкладку. */
  | { type: 'invalid'; error: string };

/** Разбор входящего от webview (недоверенного): тип, id и значение — по спискам и диапазонам из `package.json`. */
export function parseSettingsMessage(m: unknown): SettingsMessage | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const o = m as { type?: unknown; id?: unknown; value?: unknown; action?: unknown; mode?: unknown; on?: unknown };
  switch (o.type) {
    case 'ready':
    case 'pickDir':
    case 'addInstance':
    case 'addGitignore':
    case 'openJson': return { type: o.type };
    case 'instance':
      return isInstanceId(o.id) && (INSTANCE_ACTIONS as readonly unknown[]).includes(o.action)
        ? { type: 'instance', action: o.action as InstanceAction, id: o.id } : undefined;
    case 'scopeMode': return o.mode === 'all' || o.mode === 'some' ? { type: 'scopeMode', mode: o.mode } : undefined;
    case 'scopeToggle': return isInstanceId(o.id) && typeof o.on === 'boolean' ? { type: 'scopeToggle', id: o.id, on: o.on } : undefined;
    case 'reset': return isSettingId(o.id) ? { type: 'reset', id: o.id } : undefined;
    case 'set': {
      const r = parseSetting(o.id, o.value);
      return r.ok ? { type: 'set', setting: r.value } : { type: 'invalid', error: r.error };
    }
    default: return undefined;
  }
}
