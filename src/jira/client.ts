import { HttpClient, type HttpOptions } from './http';
import { mapIssueSummary } from './mappers';
import type { InstanceKind, SearchPage } from './types';

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

  /** Сырой ответ: маппинг в IssueDetail — этап 4. */
  issue(key: string, expand: string | string[] = []): Promise<Raw> {
    const e = Array.isArray(expand) ? expand.join(',') : expand;
    return this.http.getJson<Raw>(`/rest/api/2/issue/${encodeURIComponent(key)}`, e ? { expand: e } : undefined);
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
