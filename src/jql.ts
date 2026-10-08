import type { StatusCategory } from './jira/types';

export type Mode = 'mine' | 'project' | 'jql';

export interface QuickFilters {
  statusCategory: StatusCategory[];
  types: string[];
  priorities: string[];
  /** Ключи проектов; в режиме «проект» не действуют. */
  projects: string[];
}

export interface JqlInput {
  mode: Mode;
  projectKey?: string;
  jql?: string;
  quick?: Partial<QuickFilters>;
  text?: string;
  /**
   * Текст вида `ABC-123` искать как ключ: `(key = ABC-123 OR text ~ "…")`. По умолчанию — если похож на ключ.
   * `false` — только текстовый поиск (проекта с таким префиксом на инстансе нет: `UTF-8`, `ISO-9001`).
   */
  textAsKey?: boolean;
  /** Явная сортировка: заменяет и порядок по умолчанию, и `ORDER BY` из пользовательского JQL. */
  order?: string;
}

export const DEFAULT_ORDER = 'ORDER BY updated DESC';
export type SortField = 'key' | 'priority' | 'created' | 'updated';
export interface IssueSort { field: SortField; desc: boolean }
export const SORT_FIELDS: SortField[] = ['key', 'priority', 'created', 'updated'];

export const isIssueSort = (v: unknown): v is IssueSort =>
  !!v && typeof v === 'object' && SORT_FIELDS.includes((v as IssueSort).field) && typeof (v as IssueSort).desc === 'boolean';

/** `ORDER BY` для сортировки списка. У приоритета много равных — внутри одного приоритета свежие сверху. */
export function orderBy(s: IssueSort): string {
  const dir = s.desc ? 'DESC' : 'ASC';
  return s.field === 'priority' ? `ORDER BY priority ${dir}, updated DESC` : `ORDER BY ${s.field} ${dir}`;
}

export const MINE_JQL = 'assignee = currentUser() AND resolution = Unresolved';

/** Id категорий статусов в JQL: не зависят от локализации имён («To Do»/«К выполнению»). */
// id 1 — «без категории» (undefined): маппер показывает такие статусы как «Открыта», значит и фильтр «Открыта» их берёт.
const CATEGORY_IDS: Record<StatusCategory, number[]> = { new: [1, 2], done: [3], indeterminate: [4] };
const CATEGORY_ORDER: StatusCategory[] = ['new', 'indeterminate', 'done'];

/** Нормализованный ключ задачи (как его отдаёт Jira). Ввод пользователя сверяется без учёта регистра и приводится к верхнему. */
export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const KEY_RE = new RegExp(ISSUE_KEY_RE.source, 'i');
export const isIssueKey = (s: string): boolean => KEY_RE.test(s.trim());

/** Строка в двойных кавычках JQL: экранируем `\` и `"`, переводы строк — в пробел. */
export function quoteJql(s: string): string {
  return `"${s.replace(/\s+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Текст для `text ~`: значение разбирает Lucene, поэтому его операторы экранируются (`[UI]`, `C++`, `foo!`, `5"` иначе дают 400
 * или меняют смысл: `-bar`, `title:foo`). `*` и `?` остаются подстановочными. Отдельные AND/OR/NOT — в нижний регистр
 * (в верхнем это операторы Lucene; анализатор всё равно приводит регистр). Проверено на живых DC и Cloud.
 */
export function luceneEscape(s: string): string {
  return s
    .replace(/[+\-&|!(){}[\]^"~:\\/]/g, '\\$&')
    .replace(/(^|\s)(AND|OR|NOT)(?=\s|$)/g, (_, sp: string, w: string) => sp + w.toLowerCase());
}

export const projectRef = (key: string): string => (/^[A-Z][A-Z0-9_]*$/.test(key) ? key : quoteJql(key));

/** Отделяет верхнеуровневый `ORDER BY …` (вне кавычек) от условий. */
export function splitOrderBy(jql: string): { where: string; order: string } {
  let quote: string | null = null;
  for (let i = 0; i < jql.length; i++) {
    const c = jql[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if ((i === 0 || /[\s)"']/.test(jql[i - 1])) && /^order\s+by\b/i.test(jql.slice(i))) {
      return { where: jql.slice(0, i).trim(), order: jql.slice(i).trim() };
    }
  }
  return { where: jql.trim(), order: '' };
}

export function buildJql(input: JqlInput): string {
  const quick = input.quick ?? {};
  const cats = CATEGORY_ORDER.filter((c) => quick.statusCategory?.includes(c));
  const types = (quick.types ?? []).filter(Boolean);
  const prios = (quick.priorities ?? []).filter(Boolean);
  const projects = input.mode === 'project' ? [] : (quick.projects ?? []).filter(Boolean);
  const text = (input.text ?? '').replace(/\s+/g, ' ').trim();

  const clauses: string[] = [];
  let order = DEFAULT_ORDER;

  if (input.mode === 'mine') {
    clauses.push('assignee = currentUser()');
    // «Готово» в быстром фильтре снимает ограничение по resolution, иначе выдача всегда пустая.
    if (!cats.includes('done')) clauses.push('resolution = Unresolved');
  } else if (input.mode === 'project') {
    if (input.projectKey) clauses.push(`project = ${projectRef(input.projectKey)}`);
  } else {
    const { where, order: o } = splitOrderBy(input.jql ?? '');
    if (o) order = o;
    if (where) clauses.push(where);
  }

  const extra: string[] = [];
  if (projects.length) extra.push(`project in (${projects.map(projectRef).join(', ')})`);
  if (cats.length) extra.push(`statusCategory in (${cats.flatMap((c) => CATEGORY_IDS[c]).join(', ')})`);
  if (types.length) extra.push(`issuetype in (${types.map(quoteJql).join(', ')})`);
  if (prios.length) extra.push(`priority in (${prios.map(quoteJql).join(', ')})`);
  if (text) {
    const search = `text ~ ${quoteJql(luceneEscape(text))}`;
    const asKey = input.textAsKey ?? isIssueKey(text);
    extra.push(asKey && isIssueKey(text) ? `(key = ${text.toUpperCase()} OR ${search})` : search);
  }

  if (input.order) order = input.order;
  // Пользовательский JQL может содержать OR — оборачиваем, когда есть что приклеить.
  if (input.mode === 'jql' && clauses.length && extra.length) clauses[0] = `(${clauses[0]})`;
  return [...clauses, ...extra].join(' AND ') + (clauses.length + extra.length ? ' ' : '') + order;
}
