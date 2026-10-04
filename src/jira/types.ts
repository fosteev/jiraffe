export type InstanceKind = 'dc' | 'cloud';
export interface Instance { id: string; name: string; baseUrl: string; kind: InstanceKind; email?: string;
  epicLinkField?: string; caps?: Capabilities }            // токен — только в SecretStorage под ключом `jiraffe.token.<id>`
export interface Capabilities { tempo: boolean; epicLinkField: string | null; checkedAt: string; serverVersion?: string }
export interface UserRef { id: string; name: string; avatarUrl?: string }   // id = name (DC) | accountId (Cloud)
export type StatusCategory = 'new' | 'indeterminate' | 'done';
export interface IssueSummary { instanceId: string; key: string; summary: string; type: string; typeIconUrl?: string;
  status: string; statusCategory: StatusCategory; priority?: string; assignee?: UserRef; updated: string }
export interface IssueDetail extends IssueSummary { reporter?: UserRef; watchers: UserRef[]; descriptionHtml: string;
  epic?: { key: string; summary?: string }; fixVersions: { id: string; name: string }[]; labels: string[]; components: string[];
  created: string; due?: string; timetracking: { originalSec?: number; remainingSec?: number; spentSec?: number };
  attachments: Attachment[]; comments: Comment[]; history: HistoryEntry[] }
export interface Attachment { id: string; filename: string; size: number; mimeType: string; author?: UserRef; created: string;
  contentUrl: string; thumbnailUrl?: string }
export interface Comment { id: string; author?: UserRef; created: string; bodyHtml: string }
export interface HistoryEntry { author?: UserRef; created: string; items: { field: string; from: string | null; to: string | null }[] }
export interface Worklog { id: string; author?: UserRef; started: string; timeSpentSec: number; comment: string;
  attributes?: Record<string, string> }
export interface SearchPage { issues: IssueSummary[]; next?: { startAt?: number; nextPageToken?: string }; total?: number }
/** Версия (релиз) проекта: `/rest/api/2/project/{key}/versions` и `/version/{id}`. Даты — `YYYY-MM-DD`. */
export interface Version { id: string; name: string; description?: string; released: boolean; archived: boolean;
  startDate?: string; releaseDate?: string; overdue: boolean; projectId?: string }
/** Прогресс набора задач по `statusCategory`: готово / в работе / не начато (отдельной категории «ревью» в Jira нет). */
export interface Progress { total: number; done: number; prog: number; todo: number }
