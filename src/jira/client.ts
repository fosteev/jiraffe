import { HttpClient, JiraError, type BinaryResult, type HttpOptions } from './http';
import { epicFieldOf, mapIssueDetail, mapIssueSummary, mapUser, mapVersion, mapWorklog } from './mappers';
import type { Instance, InstanceKind, IssueDetail, SearchPage, StatusCategory, UserRef, Version, Worklog } from './types';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const mapNamed = (x: Raw): NamedRef => ({
  id: String(x.id), name: String(x.name), ...(x.iconUrl ? { iconUrl: String(x.iconUrl) } : {}),
  ...(typeof x.hierarchyLevel === 'number' ? { hierarchyLevel: x.hierarchyLevel } : {}),
});
const asArray = (r: unknown): Raw[] => (Array.isArray(r) ? (r as Raw[]) : []);

export const SUMMARY_FIELDS = ['summary', 'issuetype', 'status', 'priority', 'assignee', 'updated'];

export interface MyselfInfo { id: string; name: string; displayName: string; email?: string }
export interface ProjectRef { id: string; key: string; name: string }
export interface NamedRef { id: string; name: string; iconUrl?: string; hierarchyLevel?: number }
export interface FilterRef { id: string; name: string; jql: string }
export interface FieldInfo { id: string; name: string; custom: boolean; schemaCustom?: string }
export interface PageRequest { startAt?: number; nextPageToken?: string; maxResults?: number }
/** Поле экрана перехода, которое надо заполнить: обязательное и без значения по умолчанию. */
export interface TransitionField { id: string; name: string; array: boolean; allowedValues?: NamedRef[] }
export interface Transition { id: string; name: string; to: { name: string; category: StatusCategory }; fields: TransitionField[] }

const CATEGORY: Record<string, StatusCategory> = { new: 'new', indeterminate: 'indeterminate', done: 'done' };

/** Ответ `GET /issue/{key}/transitions?expand=transitions.fields`. */
export function mapTransitions(r: unknown): Transition[] {
  return asArray((r as Raw | undefined)?.transitions).map((t) => {
    const fields = Object.entries((t.fields ?? {}) as Record<string, Raw>)
      .filter(([, f]) => f && f.required === true && f.hasDefaultValue !== true)
      .map(([id, f]): TransitionField => ({
        id, name: String(f.name ?? id), array: f.schema?.type === 'array',
        ...(Array.isArray(f.allowedValues)
          ? { allowedValues: asArray(f.allowedValues).map((v) => ({ id: String(v.id), name: String(v.name ?? v.value ?? v.id) })) }
          : {}),
      }));
    return {
      id: String(t.id), name: String(t.name ?? ''),
      to: { name: String(t.to?.name ?? ''), category: CATEGORY[String(t.to?.statusCategory?.key)] ?? 'indeterminate' },
      fields,
    };
  });
}

export class JiraClient {
  constructor(
    public readonly instanceId: string,
    public readonly kind: InstanceKind,
    public readonly http: HttpClient,
  ) {}

  async myself(): Promise<MyselfInfo> {
    const r = await this.http.getJson<Raw>('/rest/api/2/myself');
    const id = String(this.kind === 'cloud' ? r.accountId : r.name);
    return { id, name: String(r.name ?? id), displayName: String(r.displayName ?? id), ...(r.emailAddress ? { email: String(r.emailAddress) } : {}) };
  }

  /** DC: startAt/total; Cloud: nextPageToken (курсор). */
  async search(jql: string, fields: string[] = SUMMARY_FIELDS, page: PageRequest = {}): Promise<SearchPage> {
    const r = await this.searchRaw(jql, fields, page);
    return { issues: r.raw.map((i) => mapIssueSummary(this.instanceId, this.kind, i)), ...(r.total !== undefined ? { total: r.total } : {}), ...(r.next ? { next: r.next } : {}) };
  }

  /** Тот же поиск, но задачи — как отдала Jira (эпики и релизы читают `fixVersions`, поле Epic Link, `parent`). */
  async searchRaw(jql: string, fields: string[], page: PageRequest = {}): Promise<{ raw: Raw[]; next?: SearchPage['next']; total?: number }> {
    const maxResults = Math.min(Math.max(Math.trunc(page.maxResults ?? 50), 1), 100); // Cloud режет до 100
    const fieldsParam = fields.join(',');
    if (this.kind === 'cloud') {
      const r = await this.http.getJson<Raw>('/rest/api/2/search/jql', {
        jql, fields: fieldsParam, maxResults, nextPageToken: page.nextPageToken,
      });
      const raw = asArray(r?.issues);
      // Защита от зацикливания: пустая страница или тот же курсор — дальше не листаем.
      const token = typeof r.nextPageToken === 'string' && r.nextPageToken !== page.nextPageToken && !r.isLast && raw.length > 0
        ? r.nextPageToken : undefined;
      return { raw, ...(token ? { next: { nextPageToken: token } } : {}) };
    }
    const startAt = page.startAt ?? 0;
    const r = await this.http.getJson<Raw>('/rest/api/2/search', { jql, fields: fieldsParam, maxResults, startAt });
    const raw = asArray(r?.issues);
    const total = typeof r.total === 'number' ? r.total : undefined;
    const nextStart = startAt + raw.length;
    const hasMore = raw.length > 0 && (total === undefined || nextStart < total);
    return { raw, ...(total !== undefined ? { total } : {}), ...(hasMore ? { next: { startAt: nextStart } } : {}) };
  }

  /** Сырой ответ; для карточки — `issueDetail`. */
  issue(key: string, expand: string | string[] = []): Promise<Raw> {
    const e = Array.isArray(expand) ? expand.join(',') : expand;
    return this.http.getJson<Raw>(`/rest/api/2/issue/${encodeURIComponent(key)}`, e ? { expand: e } : undefined);
  }

  /** Наблюдатели. Нет прав на просмотр (403/404) — пустой список, карточка от этого не падает. */
  async watchers(key: string): Promise<UserRef[]> {
    try {
      const r = await this.http.getJson<Raw>(`/rest/api/2/issue/${encodeURIComponent(key)}/watchers`);
      return asArray(r?.watchers).flatMap((w) => mapUser(w, this.kind) ?? []);
    } catch (e) {
      if (e instanceof JiraError && (e.status === 403 || e.status === 404)) return [];
      throw e;
    }
  }

  /** Стандартный журнал работ (Tempo-атрибуты — этап 6). Старые записи — как отдал Jira, без догрузки страниц. */
  async worklogs(key: string): Promise<Worklog[]> {
    try {
      const path = `/rest/api/2/issue/${encodeURIComponent(key)}/worklog`;
      const r = await this.http.getJson<Raw>(path);
      const all = asArray(r?.worklogs);
      // DC обычно отдаёт весь журнал, Cloud — до 5000; если ответ всё же постраничный — дочитываем (не больше 10 страниц).
      const total = typeof r?.total === 'number' ? r.total : all.length;
      for (let page = 0; page < 10 && all.length < total; page++) {
        const more = asArray((await this.http.getJson<Raw>(path, { startAt: all.length }))?.worklogs);
        if (!more.length) break;
        all.push(...more);
      }
      return all.map((w) => mapWorklog(this.kind, w));
    } catch (e) {
      if (e instanceof JiraError && (e.status === 403 || e.status === 404)) return [];
      throw e;
    }
  }

  /**
   * Стандартная запись ворклога: `POST /rest/api/2/issue/{key}/worklog?adjustEstimate=…` (по умолчанию `leave` — как в
   * скриптах: остаток оценки не трогаем). `started` — с локальным смещением (`startedWithOffset`), комментарий — строкой (API v2).
   */
  async addWorklog(
    key: string,
    w: { started: string; timeSpentSec: number; comment: string },
    adjustEstimate: 'leave' | 'auto' = 'leave',
  ): Promise<{ id?: string }> {
    const body = { started: w.started, timeSpentSeconds: w.timeSpentSec, ...(w.comment ? { comment: w.comment } : {}) };
    const r = await this.http.postJson<Raw>(`/rest/api/2/issue/${encodeURIComponent(key)}/worklog`, body, { adjustEstimate });
    return r && r.id !== undefined ? { id: String(r.id) } : {};
  }

  /** Комментарий: `POST /rest/api/2/issue/{key}/comment`, тело — wiki-текст строкой (API v2). */
  async addComment(key: string, body: string): Promise<{ id?: string }> {
    const r = await this.http.postJson<Raw>(`/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body });
    return r && r.id !== undefined ? { id: String(r.id) } : {};
  }

  /** Доступные текущему пользователю переходы задачи (с полями экрана перехода). */
  async transitions(key: string): Promise<Transition[]> {
    return mapTransitions(await this.http.getJson<Raw>(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, { expand: 'transitions.fields' }));
  }

  /** Перевести задачу: `POST /issue/{key}/transitions`; `fields` — значения обязательных полей экрана (`{id}` или `[{id}]`). */
  async transition(key: string, id: string, fields: Record<string, unknown> = {}): Promise<void> {
    const body = { transition: { id }, ...(Object.keys(fields).length ? { fields } : {}) };
    await this.http.postJson(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, body);
  }

  /** Учёт времени задачи (секунды) — свежий, прямо перед записью в Tempo. */
  async timetracking(key: string): Promise<{ originalSec?: number; remainingSec?: number; spentSec?: number }> {
    const r = await this.http.getJson<Raw>(`/rest/api/2/issue/${encodeURIComponent(key)}`, { fields: 'timetracking' });
    const t: Raw = r?.fields?.timetracking ?? {};
    const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const o = n(t.originalEstimateSeconds);
    const rem = n(t.remainingEstimateSeconds);
    const s = n(t.timeSpentSeconds);
    return { ...(o !== undefined ? { originalSec: o } : {}), ...(rem !== undefined ? { remainingSec: rem } : {}), ...(s !== undefined ? { spentSec: s } : {}) };
  }

  /**
   * Всё для карточки тремя параллельными GET + (DC) название эпика. HTML в результате не санитизирован.
   * Падение запроса самой задачи — ошибка; название эпика — best effort.
   */
  async issueDetail(
    key: string,
    instance: Pick<Instance, 'id' | 'kind' | 'epicLinkField' | 'caps'>,
  ): Promise<{ issue: IssueDetail; worklogs: Worklog[]; worklogError?: string }> {
    // Наблюдатели и журнал не должны ронять карточку: любая их ошибка (500, таймаут) — пустой список; для журнала ещё и текст.
    let worklogError: string | undefined;
    const [raw, watchers, worklogs] = await Promise.all([
      this.issue(key, ['renderedFields', 'changelog']),
      this.watchers(key).catch((): UserRef[] => []),
      this.worklogs(key).catch((e: unknown): Worklog[] => {
        worklogError = e instanceof Error ? e.message : String(e);
        return [];
      }),
    ]);
    const issue = mapIssueDetail(instance, raw, watchers);
    if (issue.epic && !issue.epic.summary && epicFieldOf(instance)) {
      try {
        const e = await this.http.getJson<Raw>(`/rest/api/2/issue/${encodeURIComponent(issue.epic.key)}`, { fields: 'summary' });
        if (typeof e?.fields?.summary === 'string') issue.epic = { key: issue.epic.key, summary: e.fields.summary };
      } catch { /* название эпика не критично */ }
    }
    return { issue, worklogs, ...(worklogError ? { worklogError } : {}) };
  }

  async fields(): Promise<FieldInfo[]> {
    const r = asArray(await this.http.getJson<unknown>('/rest/api/2/field'));
    return r.map((f) => ({
      id: String(f.id), name: String(f.name), custom: Boolean(f.custom),
      ...(f.schema?.custom ? { schemaCustom: String(f.schema.custom) } : {}),
    }));
  }

  async projects(): Promise<ProjectRef[]> {
    const r = asArray(await this.http.getJson<unknown>('/rest/api/2/project'));
    return r.map((p) => ({ id: String(p.id), key: String(p.key), name: String(p.name) }));
  }

  async issueTypes(): Promise<NamedRef[]> {
    return this.namedList('/rest/api/2/issuetype');
  }

  async priorities(): Promise<NamedRef[]> {
    return this.namedList('/rest/api/2/priority');
  }

  /** Типы задач проекта (`GET /project/{key}`): на Cloud у них есть `hierarchyLevel` (1 — эпик), в том числе у team-managed. */
  async projectIssueTypes(projectKey: string): Promise<NamedRef[]> {
    const r = await this.http.getJson<Raw>(`/rest/api/2/project/${encodeURIComponent(projectKey)}`);
    return asArray(r?.issueTypes).map(mapNamed);
  }

  /** Ключ проекта по id или ключу (`GET /project/{idOrKey}`). */
  async projectKey(idOrKey: string): Promise<string | undefined> {
    const r = await this.http.getJson<Raw>(`/rest/api/2/project/${encodeURIComponent(idOrKey)}`);
    return typeof r?.key === 'string' && r.key ? r.key : undefined;
  }

  /** Версии проекта (выпущенные и нет, с датами). Массив целиком, без постраничности. */
  async versions(projectKey: string): Promise<Version[]> {
    const r = await this.http.getJson<unknown>(`/rest/api/2/project/${encodeURIComponent(projectKey)}/versions`);
    return asArray(r).map(mapVersion);
  }

  async version(id: string): Promise<Version> {
    return mapVersion(await this.http.getJson<Raw>(`/rest/api/2/version/${encodeURIComponent(id)}`));
  }

  /** Сколько задач в релизе (`issuesFixedCount` из relatedIssueCounts). */
  async versionIssueCount(id: string): Promise<number> {
    const r = await this.http.getJson<Raw>(`/rest/api/2/version/${encodeURIComponent(id)}/relatedIssueCounts`);
    return typeof r?.issuesFixedCount === 'number' ? r.issuesFixedCount : 0;
  }

  /** Заголовок эпика для вкладки: название, тип, статус, проект. */
  async issueHead(key: string): Promise<Raw> {
    return this.http.getJson<Raw>(`/rest/api/2/issue/${encodeURIComponent(key)}`, { fields: 'summary,issuetype,status,project' });
  }

  async favouriteFilters(): Promise<FilterRef[]> {
    const r = asArray(await this.http.getJson<unknown>('/rest/api/2/filter/favourite'));
    return r.map((f) => ({ id: String(f.id), name: String(f.name), jql: String(f.jql ?? '') }));
  }

  async serverVersion(): Promise<string | undefined> {
    const r = await this.http.getJson<Raw>('/rest/api/2/serverInfo');
    return r.version ? String(r.version) : undefined;
  }

  /**
   * Содержимое вложения/превью/картинки описания с авторизацией. Адрес обязан быть адресом инстанса (иначе `blocked`),
   * ответ больше `maxBytes` обрывается (`limit`). `mime` — заголовок ответа, ему не доверяем (см. `sniffImage`).
   */
  downloadAttachment(url: string, maxBytes: number): Promise<BinaryResult> {
    return this.http.getBinary(url, { maxBytes });
  }

  private async namedList(path: string): Promise<NamedRef[]> {
    const r = asArray(await this.http.getJson<unknown>(path));
    return r.map(mapNamed);
  }
}

export function createJiraClient(
  instance: { id: string; kind: InstanceKind; baseUrl: string; email?: string },
  token: string,
  extra: Pick<HttpOptions, 'fetchImpl' | 'timeoutMs'> = {},
): JiraClient {
  const http = new HttpClient({ baseUrl: instance.baseUrl, kind: instance.kind, token, email: instance.email, ...extra });
  return new JiraClient(instance.id, instance.kind, http);
}
