// Сборка данных вкладок эпика и релиза: запросы в Jira → типы протокола. Без vscode — тестируется в vitest.
import type { JiraClient } from '../jira/client';
import {
  daysBetween, epicChildrenJql, epicFieldNumber, LIST_FIELDS, mapListIssue, progressOf, releaseIssuesJql, searchAll, sortIssues, type ListIssue,
} from '../jira/epics';
import { epicFieldOf, mapStatusCategory } from '../jira/mappers';
import type { Instance } from '../jira/types';
import type { EpicPage, ListRow, ReleasePage } from './protocol';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type PageInstance = Pick<Instance, 'id' | 'name' | 'kind' | 'epicLinkField' | 'caps'>;

export const listRow = (i: ListIssue, extra: string | undefined): ListRow => ({
  key: i.key, summary: i.summary, type: i.type, status: i.status, statusCategory: i.statusCategory,
  ...(i.priority ? { priority: i.priority } : {}),
  // Без avatarUrl: адреса Jira в webview не уходят (аватар — инициалы).
  ...(i.assignee ? { assignee: { id: i.assignee.id, name: i.assignee.name } } : {}), ...(extra ? { extra } : {}),
});

/** Эпик: заголовок + все задачи (до лимита `MAX_PAGES`). Название эпика/статус — обязательны, задачи — тоже (ошибка — ошибка вкладки). */
export async function loadEpicPage(c: JiraClient, inst: PageInstance, key: string): Promise<EpicPage> {
  const head = await c.issueHead(key);
  const f: Raw = head?.fields ?? {};
  const jql = epicChildrenJql(inst, [key]);
  let issues: ListIssue[] = [];
  let truncated = false;
  if (jql) {
    const r = await searchAll(c, `${jql} ORDER BY updated DESC`, LIST_FIELDS);
    issues = r.raw.map((x) => mapListIssue(inst.id, inst, x));
    truncated = r.truncated;
  }
  const rows = sortIssues(issues).map((i) => listRow(i, i.fixVersion));
  return {
    type: 'epic', instanceId: inst.id, instanceName: inst.name, project: String(f.project?.key ?? key.split('-')[0]),
    key, summary: String(f.summary ?? ''), status: String(f.status?.name ?? ''), statusCategory: mapStatusCategory(f.status),
    link: inst.kind === 'cloud' ? 'parent' : (epicFieldNumber(epicFieldOf(inst)) ? epicFieldOf(inst) : null), kind: inst.kind,
    progress: progressOf(issues.map((i) => i.statusCategory)), rows, truncated,
  };
}

/**
 * Названия эпиков по ключам (DC: в задаче только ключ из Epic Link). Best effort: не нашли — в таблице будет ключ. Пачка `key in (…)`
 * падает целиком (400), если хоть один эпик удалён или недоступен, — тогда делим её пополам, пока не останутся одиночные ключи.
 */
export async function epicNames(c: JiraClient, keys: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const uniq = [...new Set(keys.filter((k) => /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(k)))];
  const fetchPart = async (part: string[]): Promise<void> => {
    try {
      const r = await c.searchRaw(`key in (${part.join(', ')})`, ['summary'], { maxResults: 100 });
      for (const x of r.raw) if (typeof x.fields?.summary === 'string') names.set(String(x.key), x.fields.summary);
    } catch {
      if (part.length < 2) return; // названия — украшение
      const mid = Math.ceil(part.length / 2);
      await fetchPart(part.slice(0, mid));
      await fetchPart(part.slice(mid));
    }
  };
  for (let i = 0; i < uniq.length; i += 50) await fetchPart(uniq.slice(i, i + 50));
  return names;
}

/**
 * Релиз: версия + её задачи (`fixVersion = <id>`). `projectKeyOf` — ключ проекта по `projectId` версии (из кэша проектов);
 * не определился — пусто (крошки без проекта). `today` — `YYYY-MM-DD` (для «осталось N дн.»).
 */
export async function loadReleasePage(
  c: JiraClient, inst: PageInstance, id: string, projectKeyOf: (projectId: string | undefined) => string | undefined, today: string,
): Promise<ReleasePage> {
  const v = await c.version(id);
  const jql = releaseIssuesJql(id);
  let issues: ListIssue[] = [];
  let truncated = false;
  if (jql) {
    const fields = [...LIST_FIELDS];
    if (inst.kind === 'cloud') fields.push('parent');
    else {
      const f = epicFieldOf(inst);
      if (f && epicFieldNumber(f)) fields.push(f);
    }
    const r = await searchAll(c, `${jql} ORDER BY updated DESC`, fields);
    issues = r.raw.map((x) => mapListIssue(inst.id, inst, x));
    truncated = r.truncated;
    const unnamed = issues.filter((i) => i.epicKey && !i.epicName).map((i) => i.epicKey as string);
    if (unnamed.length) {
      const names = await epicNames(c, unnamed);
      for (const i of issues) if (i.epicKey && !i.epicName) i.epicName = names.get(i.epicKey);
    }
  }
  const rows = sortIssues(issues).map((i) => listRow(i, i.epicName ?? i.epicKey));
  // Ключ проекта: из кэша проектов, иначе `GET /project/{id}` (нужен для крошек и «Открыть в Jira»).
  const project = projectKeyOf(v.projectId) ?? (v.projectId ? await c.projectKey(v.projectId).catch(() => undefined) : undefined) ?? '';
  return {
    type: 'release', instanceId: inst.id, instanceName: inst.name, project,
    id: v.id, name: v.name, released: v.released,
    ...(v.description ? { description: v.description } : {}),
    ...(v.startDate ? { startDate: v.startDate } : {}), ...(v.releaseDate ? { releaseDate: v.releaseDate } : {}),
    ...(v.releaseDate && !v.released ? { daysLeft: daysBetween(today, v.releaseDate) } : {}),
    progress: progressOf(issues.map((i) => i.statusCategory)), rows, truncated,
  };
}

/** Адрес «Открыть в Jira» для релиза: страница версии `/projects/KEY/versions/ID` (DC 7+ и Cloud); проект неизвестен — `undefined`. */
export function releaseUrl(baseUrl: string, project: string, id: string): string | undefined {
  const base = baseUrl.replace(/\/+$/, '');
  if (!project) return undefined;
  const p = encodeURIComponent(project);
  return `${base}/projects/${p}/versions/${encodeURIComponent(id)}`;
}
