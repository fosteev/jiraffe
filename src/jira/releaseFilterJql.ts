// JQL текущего фильтра вкладки релиза («Копировать JQL», «Сохранить как фильтр»). Чистая функция, без vscode.
import { CATEGORY_IDS, CATEGORY_ORDER, isIssueKey, luceneEscape, quoteJql } from '../jql';
import type { ReleaseFilter } from '../panels/protocol';
import type { Instance } from './types';
import { epicFieldJql, isEpicKey, releaseIssuesJql } from './epics';

type JqlInstance = Pick<Instance, 'kind' | 'epicLinkField' | 'caps'>;

export interface ReleaseFilterJql {
  jql: string;
  /** Эпик выбран, но условия по нему в JQL нет: на инстансе нет поля Epic Link (DC) или ни один ключ не прошёл проверку формата. */
  epicSkipped: boolean;
}

/**
 * `lhs in ("a", "b")`, а с пустым значением — `(lhs in (…) OR lhs is EMPTY)` / `lhs is EMPTY`.
 * Значение из одних пробелов — мусор (`quoteJql` сделал бы из него `""`, Jira ответит 400): выбрасывается.
 */
function listClause(lhs: string, values: readonly string[], quote: (v: string) => string): string | undefined {
  const empty = values.includes('');
  const vals = values.filter((v) => v.trim()).map(quote);
  if (!vals.length) return empty ? `${lhs} is EMPTY` : undefined;
  const inList = `${lhs} in (${vals.join(', ')})`;
  return empty ? `(${inList} OR ${lhs} is EMPTY)` : inList;
}

export interface ReleaseFilterJqlOpts {
  /**
   * Есть ли задача с таким ключом (обычно — среди строк вкладки). Поиск вида `ABC-1` идёт как `key = ABC-1` только при `true`:
   * DC отвечает 400 на `key =` несуществующей задачи (и чужого проекта). Без функции — только текстом.
   */
  keyExists?: (key: string) => boolean;
}

/**
 * Условия по порядку: релиз, статус (по id категорий), исполнитель, тип, приоритет, эпик, «Только мои», поиск, затем `ORDER BY status, priority`.
 * Значения — в кавычках (`quoteJql`), ключи эпиков — только по формату. Неверный `versionId` — пустой `jql`.
 */
export function releaseFilterJql(instance: JqlInstance, versionId: string, f: ReleaseFilter, opts: ReleaseFilterJqlOpts = {}): ReleaseFilterJql {
  const base = releaseIssuesJql(versionId);
  if (!base) return { jql: '', epicSkipped: false };
  const clauses = [base];
  const add = (c: string | undefined): void => {
    if (c) clauses.push(c);
  };

  const cats = CATEGORY_ORDER.filter((c) => f.cats.includes(c));
  if (cats.length) clauses.push(`statusCategory in (${cats.flatMap((c) => CATEGORY_IDS[c]).join(', ')})`);
  add(listClause('assignee', f.assignee, quoteJql));
  add(listClause('issuetype', f.type.filter(Boolean), quoteJql));
  add(listClause('priority', f.priority, quoteJql));

  let epicSkipped = false;
  if (f.epic.length) {
    const lhs = epicFieldJql(instance);
    const clause = lhs ? listClause(lhs, f.epic.filter((k) => !k || isEpicKey(k)), (k) => k) : undefined;
    // Поля нет или все ключи мусорные: условия по эпику нет — выдача шире выбранного, об этом скажет уведомление.
    if (clause) add(clause);
    else epicSkipped = true;
  }

  if (f.mine) clauses.push('assignee = currentUser()');

  const q = f.q.replace(/\s+/g, ' ').trim();
  if (q) {
    const text = `summary ~ ${quoteJql(luceneEscape(q))}`;
    const key = q.toUpperCase();
    clauses.push(isIssueKey(q) && opts.keyExists?.(key) ? `(key = ${key} OR ${text})` : text);
  }
  return { jql: `${clauses.join(' AND ')} ORDER BY status, priority`, epicSkipped };
}
