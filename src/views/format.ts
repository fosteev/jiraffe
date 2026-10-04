// Чистые функции для деревьев (без vscode — тестируются в vitest).
import type { IssueSummary, StatusCategory } from '../jira/types';

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
