import { HttpClient, JiraError, type HttpOptions } from './http';
import { epicFieldOf, mapIssueDetail, mapIssueSummary, mapUser, mapWorklog } from './mappers';
import type { Instance, InstanceKind, IssueDetail, SearchPage, UserRef, Worklog } from './types';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const asArray = (r: unknown): Raw[] => (Array.isArray(r) ? (r as Raw[]) : []);

export const SUMMARY_FIELDS = ['summary', 'issuetype', 'status', 'priority', 'assignee', 'updated'];

export interface MyselfInfo { id: string; name: string; displayName: string; email?: string }
export interface ProjectRef { id: string; key: string; name: string }
export interface NamedRef { id: string; name: string; iconUrl?: string }
export interface FilterRef { id: string; name: string; jql: string }
export interface FieldInfo { id: string; name: string; custom: boolean; schemaCustom?: string }
export interface PageRequest { startAt?: number; nextPageToken?: string; maxResults?: number }

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
    const maxResults = Math.min(Math.max(Math.trunc(page.maxResults ?? 50), 1), 100); // Cloud режет до 100
    const fieldsParam = fields.join(',');
    if (this.kind === 'cloud') {
      const r = await this.http.getJson<Raw>('/rest/api/2/search/jql', {
        jql, fields: fieldsParam, maxResults, nextPageToken: page.nextPageToken,
      });
      const issues = (r.issues as Raw[] | undefined ?? []).map((i) => mapIssueSummary(this.instanceId, this.kind, i));
      // Защита от зацикливания: пустая страница или тот же курсор — дальше не листаем.
      const token = typeof r.nextPageToken === 'string' && r.nextPageToken !== page.nextPageToken && !r.isLast && issues.length > 0
        ? r.nextPageToken : undefined;
      return { issues, ...(token ? { next: { nextPageToken: token } } : {}) };
    }
    const startAt = page.startAt ?? 0;
    const r = await this.http.getJson<Raw>('/rest/api/2/search', { jql, fields: fieldsParam, maxResults, startAt });
    const issues = (r.issues as Raw[] | undefined ?? []).map((i) => mapIssueSummary(this.instanceId, this.kind, i));
    const total = typeof r.total === 'number' ? r.total : undefined;
    const nextStart = startAt + issues.length;
    const hasMore = issues.length > 0 && (total === undefined || nextStart < total);
    return { issues, ...(total !== undefined ? { total } : {}), ...(hasMore ? { next: { startAt: nextStart } } : {}) };
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
      const r = await this.http.getJson<Raw>(`/rest/api/2/issue/${encodeURIComponent(key)}/worklog`);
      return asArray(r?.worklogs).map((w) => mapWorklog(this.kind, w));
    } catch (e) {
      if (e instanceof JiraError && (e.status === 403 || e.status === 404)) return [];
      throw e;
    }
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

  async favouriteFilters(): Promise<FilterRef[]> {
    const r = asArray(await this.http.getJson<unknown>('/rest/api/2/filter/favourite'));
    return r.map((f) => ({ id: String(f.id), name: String(f.name), jql: String(f.jql ?? '') }));
  }

  async serverVersion(): Promise<string | undefined> {
    const r = await this.http.getJson<Raw>('/rest/api/2/serverInfo');
    return r.version ? String(r.version) : undefined;
  }

  private async namedList(path: string): Promise<NamedRef[]> {
    const r = asArray(await this.http.getJson<unknown>(path));
    return r.map((x) => ({ id: String(x.id), name: String(x.name), ...(x.iconUrl ? { iconUrl: String(x.iconUrl) } : {}) }));
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
