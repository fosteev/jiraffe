// Сборка JQL для конкретного инстанса из состояния фильтров. vscode не импортирует.
import type { Instance } from '../jira/types';
import { buildJql, isIssueKey } from '../jql';
import type { FilterSnapshot } from './filters';
import { intersectNames, keyPrefix, type InstanceMeta } from './meta';

/**
 * JQL для инстанса. Выбранные типы/приоритеты/проекты сужаются до существующих на инстансе:
 * неизвестное значение Jira отвергает с 400. Если из выбранного на инстансе нет ничего — `null`
 * (запрашивать нечего, выдача пуста). Не удалось получить справочник — берём выбор как есть.
 * Текст вида `ABC-123` ищется как ключ, только если проект `ABC` есть на инстансе (иначе `UTF-8` не найти);
 * `opts.textOnly` — принудительно текстом (повтор после 400 «задачи с таким ключом нет» на DC).
 */
export async function jqlForInstance(
  snap: FilterSnapshot,
  inst: Instance,
  meta: Pick<InstanceMeta, 'types' | 'priorities' | 'projects'>,
  opts: { textOnly?: boolean } = {},
): Promise<string | null> {
  const quick = { ...snap.quick };
  const narrow = async (wanted: string[], load: () => Promise<{ name: string }[]>): Promise<string[] | null> => {
    if (!wanted.length) return wanted;
    try {
      const have = intersectNames(wanted, await load());
      return have.length ? have : null;
    } catch {
      return wanted;
    }
  };
  const types = await narrow(quick.types, () => meta.types(inst));
  const prios = await narrow(quick.priorities, () => meta.priorities(inst));
  const projects = snap.mode === 'project' ? [] : await narrow(quick.projects, async () => (await meta.projects(inst)).map((p) => ({ name: p.key })));
  if (types === null || prios === null || projects === null) return null;
  let textAsKey = false;
  if (!opts.textOnly && isIssueKey(snap.text)) {
    const prefix = keyPrefix(snap.text);
    try {
      textAsKey = (await meta.projects(inst)).some((p) => p.key.toUpperCase() === prefix);
    } catch {
      textAsKey = false;
    }
  }
  return buildJql({
    mode: snap.mode,
    projectKey: snap.project?.key,
    jql: snap.jql,
    quick: { ...quick, types, priorities: prios, projects },
    text: snap.text,
    textAsKey,
  });
}
