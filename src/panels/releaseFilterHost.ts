// Хостовая часть «Копировать JQL» / «Сохранить как фильтр» вкладки релиза: чистые функции без vscode (тестируются в vitest).
import type { Instance } from '../jira/types';
import { epicFieldJql } from '../jira/epics';
import { releaseFilterJql } from '../jira/releaseFilterJql';
import { t } from '../l10n';
import { applyFilter, sanitizeFilter } from '../../webview/releaseFilter';
import { typeKind } from '../../webview/render';
import type { ListPage, ReleaseFilter } from './protocol';

type FilterInstance = Pick<Instance, 'kind' | 'epicLinkField' | 'caps'>;

export interface FilterRequest {
  filter: ReleaseFilter;
  jql: string;
  /** Дополнения к уведомлению: чего в JQL нет по сравнению с тем, что видно во вкладке. */
  notes: string[];
}

/**
 * Недоверенное сообщение `filterJql` → фильтр, JQL и пометки. `undefined` — игнорировать (не объект вместо фильтра, неверный id релиза).
 * `data` — страница вкладки: по её строкам решается, есть ли задача с ключом из поиска (`key =`), и считаются подзадачи без эпика.
 */
export function releaseFilterRequest(inst: FilterInstance, versionId: string, rawFilter: unknown, data: ListPage | undefined): FilterRequest | undefined {
  if (!rawFilter || typeof rawFilter !== 'object' || Array.isArray(rawFilter)) return undefined;
  const filter = sanitizeFilter(rawFilter);
  const rows = data?.type === 'release' ? data.rows : undefined;
  const { jql, epicSkipped } = releaseFilterJql(inst, versionId, filter, rows ? { keyExists: (k) => rows.some((r) => r.key === k) } : {});
  if (!jql) return undefined;
  const notes: string[] = [];
  // Условие по эпику выпало: поля Epic Link нет — или поле есть, но ни один выбранный ключ эпика не прошёл формат.
  if (epicSkipped) {
    notes.push(epicFieldJql(inst)
      ? t('The epic condition was left out: none of the selected epic keys is valid.')
      : t('The epic condition was left out: Epic Link field is unknown on this instance.'));
  }
  // Cloud: «Без эпика» = `parent is EMPTY`; подзадачи имеют родителя-не-эпика, вкладка их показывает, JQL — нет.
  if (inst.kind === 'cloud' && filter.epic.includes('') && rows) {
    const shown = applyFilter(rows, filter, data?.type === 'release' ? data.meId : undefined);
    if (shown.some((r) => !r.epicKey && typeKind(r.type) === 'subtask')) notes.push(t('Sub-tasks without an epic are not included in the JQL.'));
  }
  return { filter, jql, notes };
}

/** Имя сохраняемого фильтра по умолчанию: «ABC: 2.14.0 (filtered)»; без ключа проекта — без префикса. */
export const defaultFilterName = (project: string, versionName: string): string =>
  t('{0} (filtered)', project ? `${project}: ${versionName}` : versionName);

const withNotes = (text: string, notes: readonly string[]): string => [text, ...notes].join(' ');
export const copiedMessage = (jql: string, notes: readonly string[]): string => withNotes(t('JQL copied: {0}', jql), notes);
export const savedMessage = (name: string, notes: readonly string[]): string => withNotes(t('Saved filter {0}.', name), notes);
