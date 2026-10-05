import { t } from '../l10n';
// Запись времени и сводка «сегодня»: проверка формы, payload'ы, маршрут Tempo / стандартный журнал.
// Без vscode — тестируется в vitest (запись — только на моке fetch).
import { parseDuration } from '../duration';
import type { JiraClient, MyselfInfo } from './client';
import { findAiTokensAttr, TempoClient, type WorkAttribute } from './tempo';
import type { Instance, Worklog } from './types';

/** Одна запись — не больше суток (как в прототипе). */
export const MAX_LOG_SEC = 24 * 3600;
/** Комментарий ворклога: у Jira лимит текстового поля 32 767 символов, оставляем запас под «(AI Tokens: N)». */
export const MAX_COMMENT = 30_000;
const MAX_ATTR_VALUE = 255;

/** Что нужно форме (webview-диалогу и QuickInput): поля атрибутов строятся по ответу `work-attribute`. */
export interface LogForm {
  tempo: boolean;
  /** Поддержанные атрибуты (без `unsupported`), в порядке Tempo. AI Tokens среди них, если есть на инстансе. */
  attributes: WorkAttribute[];
  /** Ключ атрибута AI Tokens; нет — значение AI Tokens уходит в комментарий «(AI Tokens: N)». */
  aiTokensAttr?: string;
  /** Обязательные атрибуты, которые форма не умеет заполнить (тип ACCOUNT и т. п.) — Tempo, скорее всего, отклонит запись. */
  unsupportedRequired: string[];
}

export function logFormFor(tempo: boolean, attrs: readonly WorkAttribute[]): LogForm {
  if (!tempo) return { tempo: false, attributes: [], unsupportedRequired: [] };
  const ai = findAiTokensAttr(attrs.filter((a) => a.kind === 'number' || a.kind === 'text'));
  return {
    tempo: true,
    attributes: attrs.filter((a) => a.kind !== 'unsupported'),
    ...(ai ? { aiTokensAttr: ai.key } : {}),
    unsupportedRequired: attrs.filter((a) => a.kind === 'unsupported' && a.required).map((a) => a.name),
  };
}

/** Сырые значения формы (из webview — недоверенные). */
export interface LogDraft {
  duration: string;
  date: string;
  comment: string;
  aiTokens: string;
  attributes: Record<string, string>;
}

/** Проверенный запрос на запись. */
export interface LogRequest {
  timeSpentSec: number;
  /** `YYYY-MM-DD` */
  date: string;
  comment: string;
  aiTokens?: number;
  /** Атрибуты Tempo, кроме AI Tokens (тот — в `aiTokens`). Пустые не включаются. */
  attributes: Record<string, string>;
}

export type DraftResult = { ok: true; req: LogRequest } | { ok: false; field: string; error: string };

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);

/** Дата `YYYY-MM-DD`, существующая в календаре (без 31 февраля), годы 2000–2100. */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

/** AI Tokens: цифры, пробелы-разделители тысяч допустимы (`120 000`). Пусто — `null`, мусор — `undefined`. */
export function parseTokens(v: string): number | null | undefined {
  const s = v.replace(/[\s  ]/g, '');
  if (!s) return null;
  if (!/^\d{1,15}$/.test(s)) return undefined;
  return Number(s);
}

export function validateDraft(raw: unknown, form: LogForm, today = localDate()): DraftResult {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const durationText = str(d.duration, 64);
  const sec = durationText === undefined ? null : parseDuration(durationText);
  if (!sec) return { ok: false, field: 'duration', error: t("Couldn't parse the duration. Try something like 1h 30m or 90m.") };
  if (sec > MAX_LOG_SEC) return { ok: false, field: 'duration', error: t('More than a day in one entry. Split it across days.') };
  if (!isIsoDate(d.date)) return { ok: false, field: 'date', error: t('Enter the date as YYYY-MM-DD.') };
  // Будущее — почти всегда опечатка в годе/месяце; локальная дата, сравнение строк `YYYY-MM-DD`.
  if (d.date > today) return { ok: false, field: 'date', error: t('The date is in the future. Log time for today or earlier.') };
  const comment = str(d.comment ?? '', MAX_COMMENT);
  if (comment === undefined) return { ok: false, field: 'comment', error: t('Comment is longer than {0} characters.', MAX_COMMENT) };
  const tokensText = str(d.aiTokens ?? '', 64);
  const tokens = tokensText === undefined ? undefined : parseTokens(tokensText);
  if (tokens === undefined) return { ok: false, field: 'aiTokens', error: t('AI Tokens must be a whole number, for example 120000.') };

  const given = (d.attributes && typeof d.attributes === 'object' ? d.attributes : {}) as Record<string, unknown>;
  const attributes: Record<string, string> = {};
  for (const a of form.attributes) {
    if (a.key === form.aiTokensAttr) {
      if (a.required && tokens === null) return { ok: false, field: 'aiTokens', error: t('Fill in "{0}".', a.name) };
      continue;
    }
    const rawV = str(Object.prototype.hasOwnProperty.call(given, a.key) ? given[a.key] : '', MAX_ATTR_VALUE);
    if (rawV === undefined) return { ok: false, field: `attr:${a.key}`, error: t('"{0}": value is too long.', a.name) };
    const v = rawV.trim();
    let value = v;
    if (a.kind === 'number' && v) {
      if (!/^-?\d{1,15}(?:[.,]\d{1,6})?$/.test(v)) return { ok: false, field: `attr:${a.key}`, error: t('"{0}" must be a number.', a.name) };
      value = v.replace(',', '.');
    } else if (a.kind === 'list' && v && !(a.values ?? []).some((x) => x.value === v)) {
      return { ok: false, field: `attr:${a.key}`, error: t('"{0}": choose a value from the list.', a.name) };
    } else if (a.kind === 'checkbox') {
      value = v === 'true' ? 'true' : '';
    }
    if (!value) {
      if (a.required) return { ok: false, field: `attr:${a.key}`, error: t('Fill in "{0}".', a.name) };
      continue;
    }
    attributes[a.key] = value;
  }
  return { ok: true, req: { timeSpentSec: sec, date: d.date, comment: comment.trim(), ...(tokens !== null ? { aiTokens: tokens } : {}), attributes } };
}

/** Без Tempo AI Tokens дописываются в конец комментария — как в скриптах globex/initech. */
export const appendAiTokens = (comment: string, tokens: number): string => `${comment ? `${comment} ` : ''}(AI Tokens: ${tokens})`;

/** `started` стандартного ворклога: полдень выбранного дня с локальным смещением (`2026-10-04T12:00:00.000+0300`). */
export function startedWithOffset(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const off = -new Date(y, m - 1, d, 12).getTimezoneOffset();
  const abs = Math.abs(off);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date}T12:00:00.000${off >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/** Остаток оценки после записи в Tempo: `max(remaining − spent, 0)` (нет оценки — 0, как в скрипте). */
export const remainingAfter = (remainingSec: number | undefined, spentSec: number): number => Math.max((remainingSec ?? 0) - spentSec, 0);

/** Локальная дата `YYYY-MM-DD`. */
export function localDate(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Запись: Tempo-инстанс — POST Tempo v3 (автор — логин из `/myself`, остаток — по свежему `timetracking`),
 * иначе стандартный worklog с `adjustEstimate=leave`. AI Tokens — атрибут Tempo или «(AI Tokens: N)» в комментарии.
 */
export async function submitWorklog(client: JiraClient, key: string, form: LogForm, req: LogRequest): Promise<{ via: 'tempo' | 'jira'; id?: string }> {
  if (form.tempo) {
    const [me, tt] = await Promise.all([client.myself(), client.timetracking(key)]);
    const attributes = { ...req.attributes };
    let comment = req.comment;
    if (req.aiTokens !== undefined) {
      if (form.aiTokensAttr) attributes[form.aiTokensAttr] = String(req.aiTokens);
      else comment = appendAiTokens(comment, req.aiTokens);
    }
    const r = await new TempoClient(client.http).addWorklog({
      issueKey: key, author: me.name, date: req.date, timeSpentSec: req.timeSpentSec, comment, attributes,
      remainingEstimateSec: remainingAfter(tt.remainingSec, req.timeSpentSec),
    });
    return { via: 'tempo', ...r };
  }
  const comment = req.aiTokens !== undefined ? appendAiTokens(req.comment, req.aiTokens) : req.comment;
  const r = await client.addWorklog(key, { started: startedWithOffset(req.date), timeSpentSec: req.timeSpentSec, comment });
  return { via: 'jira', ...r };
}

// ---------- сводка «сегодня» ----------

export interface TodayEntry { key: string; summary?: string; comment: string; timeSpentSec: number; started: string }
export interface TodayInstance { instanceId: string; name: string; tempo: boolean; totalSec: number; entries: TodayEntry[]; error?: string }

/** Свои ворклоги за день: автор — я, дата — префикс `started` (в поясе, в котором его отдал Jira). */
export const mineOn = (worklogs: readonly Worklog[], meId: string, date: string): Worklog[] =>
  worklogs.filter((w) => w.author?.id === meId && w.started.slice(0, 10) === date);

export const sumToday = (list: readonly TodayInstance[]): number => list.reduce((s, i) => s + i.totalSec, 0);

const total = (entries: readonly TodayEntry[]): number => entries.reduce((s, e) => s + e.timeSpentSec, 0);

/**
 * «Сегодня» одного инстанса. Tempo — `GET tempo-timesheets/3/worklogs?dateFrom=dateTo=<date>&username=<login>`;
 * без Tempo — JQL `worklogAuthor = currentUser() AND worklogDate = "<date>"` (до 100 задач), затем журнал каждой
 * задачи и фильтр по автору и дате. Ошибка — исключение (вызывающий показывает её у инстанса).
 */
export async function loadToday(client: JiraClient, inst: Pick<Instance, 'id' | 'name' | 'caps'>, date: string, me: MyselfInfo, concurrency = 3): Promise<TodayInstance> {
  const base = { instanceId: inst.id, name: inst.name };
  if (inst.caps?.tempo) {
    const logs = await new TempoClient(client.http).worklogs({ dateFrom: date, dateTo: date, username: me.name });
    const entries = logs
      // Сервер уже отфильтровал по `username`; логины Jira регистронезависимы — сравниваем без учёта регистра.
      .filter((w) => (!w.author || w.author.id.toLowerCase() === me.name.toLowerCase()) && w.started.slice(0, 10) === date)
      .map((w) => ({ key: w.issueKey, ...(w.issueSummary ? { summary: w.issueSummary } : {}), comment: w.comment, timeSpentSec: w.timeSpentSec, started: w.started }));
    return { ...base, tempo: true, totalSec: total(entries), entries };
  }
  const page = await client.search(`worklogAuthor = currentUser() AND worklogDate = "${date}" ORDER BY updated DESC`, ['summary'], { maxResults: 100 });
  const entries: TodayEntry[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < page.issues.length) {
      const issue = page.issues[next++];
      for (const w of mineOn(await client.worklogs(issue.key), me.id, date)) {
        entries.push({ key: issue.key, summary: issue.summary, comment: w.comment, timeSpentSec: w.timeSpentSec, started: w.started });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, page.issues.length) }, worker));
  entries.sort((a, b) => Date.parse(a.started) - Date.parse(b.started) || a.key.localeCompare(b.key));
  return { ...base, tempo: false, totalSec: total(entries), entries };
}
