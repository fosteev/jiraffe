// Эпики и релизы: JQL, прогресс и загрузка списков. Без vscode — тестируется в vitest.
// Контракт эпика (решение этапа 2): DC — поле Epic Link, `cf[<id>] = KEY`; Cloud — `parent = KEY`, эпик = уровень иерархии 1.
import { epicFieldOf, mapEpic, mapStatusCategory, mapUser } from './mappers';
import { JiraError } from './http';
import type { JiraClient, PageRequest } from './client';
import type { Instance, IssueSummary, Progress, StatusCategory, UserRef, Version } from './types';
import { luceneEscape, projectRef, quoteJql } from '../jql';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type EpicInstance = Pick<Instance, 'kind' | 'epicLinkField' | 'caps'>;

const asArray = (r: unknown): Raw[] => (Array.isArray(r) ? (r as Raw[]) : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const isId = (v: string): boolean => /^\d{1,18}$/.test(v);

/** Название типа эпика на инстансах без английской локали (`Epic` / `Эпик`). */
export const EPIC_NAME_RE = /^(epic|эпик)$/i;

const ORDER_EPICS = 'ORDER BY created DESC';

/** Фильтр раздела «Эпики»: только мои (исполнитель — я) и поиск по названию. */
export interface EpicFilter { mine?: boolean; text?: string }

/**
 * Нерешённые эпики проекта. Без `typeIds` — `issuetype = Epic`; с ними (тип называется иначе, либо Cloud: типы
 * уровня иерархии 1 проекта) — `issuetype in (id…)`. Поиск — `summary ~` (операторы Lucene экранированы, как в «Задачах»).
 */
export function epicsJql(projectKey: string, typeIds?: readonly string[], filter: EpicFilter = {}): string {
  const ids = (typeIds ?? []).filter(isId);
  const type = ids.length ? `issuetype in (${ids.join(', ')})` : 'issuetype = Epic';
  const clauses = [`project = ${projectRef(projectKey)}`, type, 'resolution = Unresolved'];
  if (filter.mine) clauses.push('assignee = currentUser()');
  const text = (filter.text ?? '').replace(/\s+/g, ' ').trim();
  if (text) clauses.push(`summary ~ ${quoteJql(luceneEscape(text))}`);
  return `${clauses.join(' AND ')} ${ORDER_EPICS}`;
}

/** Номер поля из id (`customfield_10100` → `10100`); не похоже на id — `null` (в JQL такое подставлять нельзя). */
export function epicFieldNumber(field: string | null): string | null {
  const m = field ? /^customfield_(\d{1,9})$/.exec(field) : null;
  return m ? m[1] : null;
}

/**
 * Условие «задачи эпиков»: DC — `cf[<id>] = KEY` / `in (…)`, Cloud — `parent = KEY` / `in (…)`. DC без поля Epic Link — `null`
 * (эпиков у задач нет, спрашивать нечего). Ключи — только по формату (в JQL они идут без кавычек).
 */
export function epicChildrenJql(instance: EpicInstance, keys: readonly string[]): string | null {
  const ks = keys.filter((k) => /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(k));
  if (!ks.length) return null;
  let lhs: string;
  if (instance.kind === 'cloud') lhs = 'parent';
  else {
    const n = epicFieldNumber(epicFieldOf(instance));
    if (!n) return null;
    lhs = `cf[${n}]`;
  }
  return ks.length === 1 ? `${lhs} = ${ks[0]}` : `${lhs} in (${ks.join(', ')})`;
}

/** Задачи релиза: `fixVersion = <id>`; id — только число. */
export function releaseIssuesJql(versionId: string): string | null {
  return isId(versionId) ? `fixVersion = ${versionId}` : null;
}

export function progressOf(cats: readonly StatusCategory[]): Progress {
  const p: Progress = { total: cats.length, done: 0, prog: 0, todo: 0 };
  for (const c of cats) p[c === 'done' ? 'done' : c === 'indeterminate' ? 'prog' : 'todo']++;
  return p;
}

/** Процент готовых; 100 — только когда готово всё (199 из 200 — 99, а не округлённые 100). */
export const percent = (p: Progress): number => (!p.total ? 0 : p.done >= p.total ? 100 : Math.min(99, Math.round((p.done / p.total) * 100)));

// ----- версии -----

/**
 * Не выпущенные — первыми (ближайшая дата сверху, без даты — в конце), затем выпущенные (свежие сверху). При равных датах и без
 * дат — порядок версий в проекте (как их отдал API: `sequence`): у не выпущенных прямой, у выпущенных обратный (свежие выше).
 * Архивные не показываем.
 */
export function sortVersions(list: readonly Version[]): Version[] {
  const pos = new Map(list.map((v, i) => [v, i]));
  const seq = (a: Version, b: Version): number => (pos.get(a) ?? 0) - (pos.get(b) ?? 0);
  const byDate = (a: Version, b: Version, dir: 1 | -1): number => {
    if (a.releaseDate && b.releaseDate) return a.releaseDate < b.releaseDate ? -dir : a.releaseDate > b.releaseDate ? dir : 0;
    return a.releaseDate ? -1 : b.releaseDate ? 1 : 0;
  };
  const live = list.filter((v) => !v.archived);
  return [
    ...live.filter((v) => !v.released).sort((a, b) => byDate(a, b, 1) || seq(a, b)),
    ...live.filter((v) => v.released).sort((a, b) => byDate(a, b, -1) || seq(b, a)),
  ];
}

/** Сколько дней от `from` до `to` (оба `YYYY-MM-DD`, без часовых поясов). */
export function daysBetween(from: string, to: string): number {
  const t = (s: string): number => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(to) - t(from)) / 864e5);
}

// ----- строки таблицы -----

/** Задача в таблице эпика/релиза: сводка + релиз (для эпика) или название эпика (для релиза). */
export interface ListIssue extends IssueSummary {
  fixVersion?: string;
  epicKey?: string;
  epicName?: string;
}

export const LIST_FIELDS = ['summary', 'issuetype', 'status', 'priority', 'assignee', 'updated', 'fixVersions'];

const CAT_ORDER: Record<StatusCategory, number> = { indeterminate: 0, new: 1, done: 2 };
export function priorityRank(name: string | undefined): number {
  const n = (name ?? '').toLowerCase();
  if (/blocker|highest|наивысш|блокер|критич|critical/.test(n)) return 0;
  if (/high|major|высок|серьёз|серьез|основн/.test(n)) return 1;
  if (/lowest|low|minor|trivial|низк|незнач|минор/.test(n)) return 3;
  return 2;
}
const keyNum = (k: string): number => Number(/-(\d+)$/.exec(k)?.[1] ?? 0);

/** Как `sortI` в прототипе: в работе → не начато → готово, внутри — по приоритету и номеру ключа. */
export function sortIssues<T extends IssueSummary>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => CAT_ORDER[a.statusCategory] - CAT_ORDER[b.statusCategory]
    || priorityRank(a.priority) - priorityRank(b.priority) || keyNum(a.key) - keyNum(b.key));
}

/** Ключ эпика из сырой задачи: DC — значение Epic Link, Cloud — `parent` (только эпик, уровень иерархии 1). */
export const epicRefOf = (instance: EpicInstance, raw: Raw): { key: string; summary?: string } | undefined =>
  mapEpic(instance.kind, epicFieldOf(instance), raw.fields ?? {});

export function mapListIssue(instanceId: string, instance: EpicInstance, raw: Raw): ListIssue {
  const f: Raw = raw.fields ?? {};
  const assignee: UserRef | undefined = mapUser(f.assignee, instance.kind);
  const fix = asArray(f.fixVersions).map((v) => str(v.name)).filter((x): x is string => !!x).join(', ');
  const epic = epicRefOf(instance, raw);
  return {
    instanceId, key: String(raw.key), summary: String(f.summary ?? ''), type: String(f.issuetype?.name ?? ''),
    status: String(f.status?.name ?? ''), statusCategory: mapStatusCategory(f.status),
    ...(f.priority?.name ? { priority: String(f.priority.name) } : {}),
    ...(assignee ? { assignee } : {}), updated: String(f.updated ?? ''),
    ...(fix ? { fixVersion: fix } : {}),
    ...(epic ? { epicKey: epic.key, ...(epic.summary ? { epicName: epic.summary } : {}) } : {}),
  };
}

// ----- загрузка -----

/** Не больше страниц по 100 задач в одном запросе «всё про эпик/релиз» (1000 задач). */
export const MAX_PAGES = 10;
/** Эпиков в одном запросе прогресса. */
const EPIC_CHUNK = 10;

/** Все страницы поиска (до `MAX_PAGES`); `truncated` — задач больше, чем прочитано. */
export async function searchAll(c: JiraClient, jql: string, fields: string[]): Promise<{ raw: Raw[]; truncated: boolean }> {
  const raw: Raw[] = [];
  let page: PageRequest = { maxResults: 100 };
  for (let n = 0; n < MAX_PAGES; n++) {
    const r = await c.searchRaw(jql, fields, page);
    raw.push(...r.raw);
    if (!r.next) return { raw, truncated: false };
    page = { ...r.next, maxResults: 100 };
  }
  return { raw, truncated: true };
}

/** Id типов эпика проекта на Cloud: типы уровня иерархии 1 из самого проекта (team-managed типы есть только там), иначе глобальные. */
export async function cloudEpicTypeIds(c: JiraClient, projectKey: string): Promise<string[]> {
  let types = (await c.projectIssueTypes(projectKey)).filter((t) => t.hierarchyLevel === 1);
  if (!types.length) types = (await c.issueTypes()).filter((t) => t.hierarchyLevel === 1);
  return types.map((t) => t.id);
}

export interface EpicItem {
  key: string;
  summary: string;
  status: string;
  statusCategory: StatusCategory;
  /** Нет, если у инстанса нет поля Epic Link (DC) — задачи эпика не найти. */
  progress?: Progress;
  /** Задач больше лимита запроса: прогресс приблизительный. */
  partial?: boolean;
}

export interface EpicList { epics: EpicItem[]; next?: PageRequest; jql: string }

/**
 * Страница эпиков проекта + прогресс по `statusCategory` их задач. Прогресс всей страницы — несколькими запросами «эпики
 * `in (…)`» (по 10 эпиков), а не по запросу на каждый эпик: на Cloud счётчика `total` нет.
 */
export async function loadEpics(
  c: JiraClient, instance: EpicInstance, projectKey: string, page: PageRequest = {}, knownJql?: string, filter: EpicFilter = {},
): Promise<EpicList> {
  const fields = ['summary', 'status'];
  // «Загрузить ещё»: JQL первой страницы (курсор Cloud привязан к нему; типы и фолбэк локали заново не выясняем).
  if (knownJql) {
    const res = await c.searchRaw(knownJql, fields, page);
    return finishEpics(c, instance, res, knownJql, page);
  }
  let typeIds: string[] | undefined;
  if (instance.kind === 'cloud') {
    try {
      typeIds = await cloudEpicTypeIds(c, projectKey);
    } catch {
      typeIds = undefined; // не смогли узнать типы — пробуем `issuetype = Epic`
    }
  }
  let jql = epicsJql(projectKey, typeIds, filter);
  let res;
  try {
    res = await c.searchRaw(jql, fields, page);
  } catch (e) {
    // «The value 'Epic' does not exist for the field 'issuetype'» (русская локаль) — ищем тип эпика по названию и повторяем по id.
    if (!(e instanceof JiraError && e.status === 400) || instance.kind === 'cloud' || typeIds) throw e;
    const ids = await c.issueTypes().then((ts) => ts.filter((t) => EPIC_NAME_RE.test(t.name)).map((t) => t.id), () => [] as string[]);
    if (!ids.length) throw e; // наружу — исходная ошибка Jira, а не ошибка справочника типов
    jql = epicsJql(projectKey, ids, filter);
    try {
      res = await c.searchRaw(jql, fields, page);
    } catch (e2) {
      throw e2 instanceof JiraError && e2.status === 400 ? e : e2; // та же 400 (нет проекта/прав) — исходный текст
    }
  }
  return finishEpics(c, instance, res, jql, page);
}

async function finishEpics(
  c: JiraClient, instance: EpicInstance, res: Awaited<ReturnType<JiraClient['searchRaw']>>, jql: string, page: PageRequest,
): Promise<EpicList> {
  const epics: EpicItem[] = res.raw.map((r) => ({
    key: String(r.key), summary: String(r.fields?.summary ?? ''), status: String(r.fields?.status?.name ?? ''),
    statusCategory: mapStatusCategory(r.fields?.status),
  }));
  await fillProgress(c, instance, epics);
  return { epics, jql, ...(res.next ? { next: { ...res.next, maxResults: page.maxResults } } : {}) };
}

async function fillProgress(c: JiraClient, instance: EpicInstance, epics: EpicItem[]): Promise<void> {
  const cats = new Map<string, StatusCategory[]>(epics.map((e) => [e.key, []]));
  const field = instance.kind === 'cloud' ? 'parent' : epicFieldOf(instance);
  // DC без Epic Link (или поле не вида customfield_N — в JQL его не подставить): прогресса нет, а не «0/0».
  if (!field || (instance.kind !== 'cloud' && !epicFieldNumber(field))) return;
  const failed = new Set<string>();
  const chunks: EpicItem[][] = [];
  for (let i = 0; i < epics.length; i += EPIC_CHUNK) chunks.push(epics.slice(i, i + EPIC_CHUNK));
  await Promise.all(chunks.map(async (chunk) => {
    const jql = epicChildrenJql(instance, chunk.map((e) => e.key));
    if (!jql) return;
    let found;
    try {
      found = await searchAll(c, jql, ['status', field]);
    } catch {
      for (const e of chunk) failed.add(e.key);
      return; // прогресс — best effort: эпики без него остаются в списке
    }
    const { raw, truncated } = found;
    for (const r of raw) {
      const key = instance.kind === 'cloud' ? r.fields?.parent?.key : r.fields?.[field];
      if (typeof key === 'string') cats.get(key)?.push(mapStatusCategory(r.fields?.status));
    }
    if (truncated) for (const e of chunk) e.partial = true;
  }));
  for (const e of epics) {
    const got = cats.get(e.key) ?? [];
    // Пачка упала — прогресса нет; пачка усечена, а задач этого эпика в прочитанном нет — тоже нет (а не «0/0+»).
    if (!failed.has(e.key) && !(e.partial && !got.length)) e.progress = progressOf(got);
  }
}
