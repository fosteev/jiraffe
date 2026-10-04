// Чистые функции для деревьев (без vscode — тестируются в vitest).
import type { EpicItem } from '../jira/epics';
import { sortVersions } from '../jira/epics';
import { JiraError } from '../jira/http';
import type { IssueSummary, StatusCategory, Version } from '../jira/types';

export const CATEGORY_LABEL: Record<StatusCategory, string> = { new: 'Открыта', indeterminate: 'В работе', done: 'Готово' };

/** Иконка codicon и id цвета темы по категории статуса. */
export const CATEGORY_ICON: Record<StatusCategory, { icon: string; color: string }> = {
  new: { icon: 'circle-large-outline', color: 'charts.blue' },
  indeterminate: { icon: 'play-circle', color: 'charts.yellow' },
  done: { icon: 'pass', color: 'charts.green' },
};

/** Экранирование текста, вставляемого в MarkdownString. */
export function mdEscape(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>~&]/g, '\\$&').replace(/\r?\n/g, ' ');
}

export function tooltipMarkdown(i: IssueSummary, instanceName: string): string {
  const lines = [
    `**${mdEscape(i.key)}** · ${mdEscape(i.summary)}`,
    '',
    `${mdEscape(i.type)} · ${mdEscape(i.status)} (${CATEGORY_LABEL[i.statusCategory]})`,
    ...(i.priority ? [`Приоритет: ${mdEscape(i.priority)}`] : []),
    `Исполнитель: ${i.assignee ? mdEscape(i.assignee.name) : 'не назначен'}`,
    `Обновлена: ${mdEscape(i.updated.replace('T', ' ').slice(0, 16))}`,
    `Инстанс: ${mdEscape(instanceName)}`,
  ];
  return lines.join('  \n');
}

/** Сводка для инстансного узла: DC — total, Cloud — «N+», пока есть следующая страница. */
export function countLabel(loaded: number, total: number | undefined, hasNext: boolean): string {
  if (total !== undefined) return String(total);
  return hasNext ? `${loaded}+` : String(loaded);
}

export function hostOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return u.host + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return baseUrl;
  }
}

/** Подпись прогресса эпика: `3/10` (`+` — задач больше лимита запроса, цифры приблизительные). */
export const progressLabel = (e: EpicItem): string | undefined =>
  e.progress ? `${e.progress.done}/${e.progress.total}${e.partial ? '+' : ''}` : undefined;

/** Выпущенных версий показываем не больше (остальные — строкой «скрыто»): на каждую версию уходит GET со счётчиком. */
export const MAX_RELEASED = 20;

/** Версии к показу: все не выпущенные + последние выпущенные; `hidden` — сколько выпущенных не вошло. */
export function visibleVersions(all: readonly Version[]): { versions: Version[]; hidden: number } {
  const sorted = sortVersions(all);
  const open = sorted.filter((v) => !v.released);
  const done = sorted.filter((v) => v.released);
  return { versions: [...open, ...done.slice(0, MAX_RELEASED)], hidden: Math.max(0, done.length - MAX_RELEASED) };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Текст ошибки раздела проекта («Эпики», «Релизы») и признак «это про проект, а не про подключение».
 * Несуществующий или недоступный проект: Cloud и DC (версии) отвечают 404, DC на JQL с таким проектом — 400
 * (`The value 'X' does not exist for the field 'project'`; в русской локали текст другой, но ключ в нём есть).
 * Прочие 400 (нет типа «Эпик», неверное поле) ключа проекта как отдельного слова не содержат — показываем текст Jira.
 */
export function projectErrorText(e: unknown, projectKey: string): { text: string; project: boolean } {
  if (e instanceof JiraError && e.code === 'http') {
    const mentionsKey = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(projectKey)}([^A-Za-z0-9_-]|$)`, 'i').test(e.message);
    if (e.status === 404 || (e.status === 400 && mentionsKey)) {
      return { text: `Проект ${projectKey} не найден или нет доступа`, project: true };
    }
  }
  return { text: e instanceof Error ? e.message : String(e), project: false };
}
