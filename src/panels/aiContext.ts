// Контекст задачи для ИИ-чата (Agentura, `agentura.openWithContext`): markdown-текст карточки. Без vscode — тестируется в vitest.
import type { StatusCategory } from '../jira/types';
import type { IssueCard } from './protocol';

/** Последних комментариев в контексте. */
export const AI_COMMENTS = 20;
const MAX_FIELD_CHARS = 30_000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Санитизированный HTML Jira → текст: блоки — строки, пункты списков — `- `, ссылки — `текст (адрес)`, картинки — `[image]`. */
export function htmlToText(html: string): string {
  return html
    .replace(/<span[^>]*class="img-ph"[^>]*>[\s\S]*?<\/span>/gi, '[image]')
    .replace(/<img\b[^>]*>/gi, '[image]')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, '').trim();
      return !href || href === text || href.startsWith('#') ? inner : `${inner} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|pre|blockquote|table|tr)>/gi, '\n')
    .replace(/<(p|div|h[1-6]|ul|ol|pre|blockquote|table|tr)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const clip = (s: string): string => (s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS)}\n…(truncated)` : s);

/** Markdown задачи для модели: поля, описание, последние комментарии. Подписи — по-английски (это текст для модели, не UI). */
export function issueContext(c: Pick<IssueCard, 'instanceName' | 'issue'>, url: string): string {
  const i = c.issue;
  const line = (label: string, v: string | undefined): string => (v ? `- ${label}: ${v}\n` : '');
  const desc = htmlToText(i.descriptionHtml);
  const comments = i.comments.slice(-AI_COMMENTS);
  let s = `# ${i.key}: ${i.summary}\n\n`;
  s += line('URL', url);
  s += line('Jira', c.instanceName);
  s += line('Type', i.type);
  s += line('Status', i.status);
  s += line('Priority', i.priority);
  s += line('Assignee', i.assignee?.name);
  s += line('Reporter', i.reporter?.name);
  s += line('Epic', i.epic && (i.epic.summary ? `${i.epic.key} ${i.epic.summary}` : i.epic.key));
  s += line('Fix versions', i.fixVersions.map((v) => v.name).join(', '));
  s += line('Labels', i.labels.join(', '));
  s += line('Components', i.components.join(', '));
  s += line('Created', i.created);
  s += line('Updated', i.updated);
  s += line('Due', i.due);
  s += `\n## Description\n\n${desc ? clip(desc) : '(empty)'}\n`;
  if (comments.length) {
    const head = comments.length < i.comments.length ? `last ${comments.length} of ${i.comments.length}` : `${comments.length}`;
    s += `\n## Comments (${head})\n`;
    for (const cm of comments) s += `\n### ${cm.author?.name ?? 'unknown'}, ${cm.created}\n\n${clip(htmlToText(cm.bodyHtml))}\n`;
  }
  return s;
}

/** Задача для Agentura (`agentura.openWithContext`, поле `task`): по ней чаты собираются в группу. */
export interface TaskMeta {
  key: string;
  instanceId: string;
  title: string;
  status: string;
  statusCategory: StatusCategory;
  url: string;
}

export const taskMeta = (c: Pick<IssueCard, 'issue'>, instanceId: string, url: string): TaskMeta => ({
  key: c.issue.key,
  instanceId,
  title: c.issue.summary,
  status: c.issue.status,
  statusCategory: c.issue.statusCategory,
  url,
});

/** Чат задачи из команды Agentura `agentura.taskSessions({instanceId, key})`. */
export interface TaskSession {
  id: string;
  provider: string;
  title: string;
  updatedAt: number;
  live: boolean;
}

/** Ответ команды → список чатов, свежие первыми; не массив (старая/чужая Agentura) → undefined, битые элементы пропускаются. */
export function parseTaskSessions(raw: unknown): TaskSession[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
  const out: TaskSession[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || r.id.length > MAX_ID) continue;
    const updated = typeof r.updatedAt === 'number' ? r.updatedAt : typeof r.updatedAt === 'string' ? Date.parse(r.updatedAt) : NaN;
    out.push({
      id: r.id,
      provider: str(r.provider, 40),
      title: str(r.title, 200),
      updatedAt: Number.isFinite(updated) ? updated : 0,
      live: r.live === true,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);
}

/** Ответ чужого расширения: id обрезать нельзя (это ссылка на чат) — слишком длинный пропускаем; в меню — не больше 50 чатов. */
const MAX_ID = 200;
const MAX_SESSIONS = 50;

export type AskEntry = { kind: 'continue' | 'chat'; session: TaskSession } | { kind: 'new' };

/**
 * Пункты меню «Открыть в Agentura ▾»: «Продолжить» (самый свежий чат) первым, остальные чаты, затем «Новый чат по задаче».
 * Чатов нет — null: меню не нужно, сразу новый чат.
 */
export function askMenu(sessions: readonly TaskSession[]): AskEntry[] | null {
  if (!sessions.length) return null;
  const [first, ...rest] = sessions;
  return [{ kind: 'continue', session: first }, ...rest.map((session): AskEntry => ({ kind: 'chat', session })), { kind: 'new' }];
}
