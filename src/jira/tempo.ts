// Tempo Timesheets Server (REST v3) — атрибуты, чтение и запись ворклогов. Без vscode — тестируется в vitest.
// Форматы проверены GET-запросами на живом DC (см. «Допущения» в roadmap-mvp.md); запись — по скрипту northwind-jira `cmd_worklog`.
import type { HttpClient } from './http';
import { JiraError } from './http';
import type { Worklog } from './types';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Как поле атрибута рисуется в форме. `unsupported` (ACCOUNT, DYNAMIC_DROPDOWN, BILLABLE_SECONDS …) — в форму не попадает. */
export type WorkAttributeKind = 'text' | 'number' | 'list' | 'checkbox' | 'unsupported';

export interface WorkAttribute {
  key: string;
  name: string;
  /** `type.value` из Tempo: `INPUT_FIELD`, `INPUT_NUMERIC`, `STATIC_LIST`, `CHECKBOX`, … */
  type: string;
  kind: WorkAttributeKind;
  required: boolean;
  /** Только для `list`: значения без удалённых, в порядке `sequence`. */
  values?: { value: string; name: string }[];
}

/** Ворклог из Tempo: стандартный `Worklog` + задача (у Tempo `dateStarted` — без часового пояса). */
export interface TempoWorklog extends Worklog {
  issueKey: string;
  issueSummary?: string;
}

export interface TempoWorklogInput {
  issueKey: string;
  /** Логин автора (DC `/myself` → `name`). */
  author: string;
  /** День записи `YYYY-MM-DD`; время — 12:00 (как в скрипте): так дата не съезжает при любом поясе сервера. */
  date: string;
  timeSpentSec: number;
  comment: string;
  /** key → value; пустые значения не отправляются. */
  attributes: Record<string, string>;
  /** Новый остаток оценки задачи (Tempo v3 требует поле). */
  remainingEstimateSec: number;
}

/** Ключ атрибута AI Tokens на Northwind (`JIRA_PILOT_AI_TOKENS_ATTR` в скрипте, по умолчанию `_AITokensUsed_`). */
export const AI_TOKENS_ATTR = '_AITokensUsed_';

const KIND: Record<string, WorkAttributeKind> = {
  INPUT_FIELD: 'text',
  INPUT_NUMERIC: 'number',
  STATIC_LIST: 'list',
  CHECKBOX: 'checkbox',
};

export function mapWorkAttribute(a: Raw): WorkAttribute | undefined {
  if (!a || typeof a.key !== 'string' || !a.key) return undefined;
  const type = String((a.type && typeof a.type === 'object' ? a.type.value : a.type) ?? '');
  const kind = KIND[type] ?? 'unsupported';
  const values = kind === 'list' && Array.isArray(a.staticListValues)
    ? (a.staticListValues as Raw[])
      .filter((v) => v && !v.removed && (typeof v.value === 'string' || typeof v.name === 'string'))
      .sort((x, y) => (Number(x.sequence) || 0) - (Number(y.sequence) || 0))
      .map((v) => ({ value: String(v.value ?? v.name), name: String(v.name ?? v.value) }))
    : undefined;
  return { key: a.key, name: String(a.name ?? a.key), type, kind, required: a.required === true, ...(values ? { values } : {}) };
}

/** Атрибут AI Tokens: по ключу, иначе по имени («AI Tokens», без учёта регистра и пробелов). */
export function findAiTokensAttr(attrs: readonly WorkAttribute[]): WorkAttribute | undefined {
  return attrs.find((a) => a.key === AI_TOKENS_ATTR) ?? attrs.find((a) => /^ai\s*tokens?$/i.test(a.name.trim()));
}

export function mapTempoWorklog(w: Raw): TempoWorklog {
  const attributes: Record<string, string> = {};
  if (Array.isArray(w.worklogAttributes)) {
    for (const a of w.worklogAttributes as Raw[]) if (a && typeof a.key === 'string' && a.value !== undefined && a.value !== null) attributes[a.key] = String(a.value);
  }
  const author = w.author?.name ? { id: String(w.author.name), name: String(w.author.displayName ?? w.author.name) } : undefined;
  return {
    id: String(w.id),
    ...(author ? { author } : {}),
    started: String(w.dateStarted ?? ''),
    timeSpentSec: typeof w.timeSpentSeconds === 'number' ? w.timeSpentSeconds : 0,
    comment: typeof w.comment === 'string' ? w.comment : '',
    attributes,
    issueKey: String(w.issue?.key ?? ''),
    ...(typeof w.issue?.summary === 'string' ? { issueSummary: w.issue.summary } : {}),
  };
}

/** Тело POST /rest/tempo-timesheets/3/worklogs/ — как в `cmd_worklog` скрипта northwind-jira. */
export function tempoPayload(i: TempoWorklogInput): Record<string, unknown> {
  const attrs = Object.entries(i.attributes).filter(([, v]) => v !== '');
  return {
    issue: { key: i.issueKey, remainingEstimateSeconds: Math.max(0, Math.round(i.remainingEstimateSec)) },
    author: { name: i.author },
    timeSpentSeconds: i.timeSpentSec,
    dateStarted: `${i.date}T12:00:00.000`,
    ...(i.comment ? { comment: i.comment } : {}),
    ...(attrs.length ? { worklogAttributes: attrs.map(([key, value]) => ({ key, value })) } : {}),
  };
}

export class TempoClient {
  constructor(private readonly http: HttpClient) {}

  async attributes(): Promise<WorkAttribute[]> {
    const r = await this.http.getJson<unknown>('/rest/tempo-core/1/work-attribute');
    const list = Array.isArray(r) ? (r as Raw[]) : [];
    return list
      .slice()
      .sort((a, b) => (Number(a?.sequence) || 0) - (Number(b?.sequence) || 0))
      .flatMap((a) => mapWorkAttribute(a) ?? []);
  }

  /**
   * Ворклоги за период. `username` — логин; без него Tempo отдаёт ворклоги текущего пользователя.
   * Фильтра по задаче в v3 нет (`issue`, `issueKey`, `issueId` сервер молча игнорирует — проверено), поэтому `issueKey` — на клиенте.
   */
  async worklogs(q: { dateFrom: string; dateTo: string; username?: string; issueKey?: string }): Promise<TempoWorklog[]> {
    const r = await this.http.getJson<unknown>('/rest/tempo-timesheets/3/worklogs', { dateFrom: q.dateFrom, dateTo: q.dateTo, username: q.username });
    const list = (Array.isArray(r) ? (r as Raw[]) : []).map(mapTempoWorklog);
    return q.issueKey ? list.filter((w) => w.issueKey === q.issueKey) : list;
  }

  /** Один ворклог по id (id Tempo = id ворклога Jira — проверено). Нет — `undefined`. */
  async worklog(id: string): Promise<TempoWorklog | undefined> {
    try {
      return mapTempoWorklog(await this.http.getJson<Raw>(`/rest/tempo-timesheets/3/worklogs/${encodeURIComponent(id)}`));
    } catch (e) {
      if (e instanceof JiraError && e.status === 404) return undefined;
      throw e;
    }
  }

  async addWorklog(i: TempoWorklogInput): Promise<{ id?: string }> {
    const r = await this.http.postJson<unknown>('/rest/tempo-timesheets/3/worklogs/', tempoPayload(i));
    const first = (Array.isArray(r) ? r[0] : r) as Raw | undefined;
    return first && first.id !== undefined ? { id: String(first.id) } : {};
  }
}

/**
 * Атрибуты Tempo для стандартного журнала задачи: по одному GET на ворклог (новые первыми, не больше `limit`,
 * параллельно `concurrency`). Ошибка по отдельному ворклогу — строка без атрибутов; 401/403 и сеть — прекращаем.
 */
export async function withTempoAttributes(tempo: TempoClient, worklogs: Worklog[], limit = 50, concurrency = 4): Promise<Worklog[]> {
  const order = [...worklogs].sort((a, b) => Date.parse(b.started) - Date.parse(a.started)).slice(0, limit);
  const found = new Map<string, Record<string, string>>();
  let stop = false;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!stop && next < order.length) {
      const w = order[next++];
      try {
        const t = await tempo.worklog(w.id);
        if (t?.attributes) found.set(w.id, t.attributes);
      } catch (e) {
        if (!(e instanceof JiraError) || e.status === 0 || e.status === 401 || e.status === 403) stop = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, order.length) }, worker));
  return worklogs.map((w) => (found.has(w.id) ? { ...w, attributes: found.get(w.id) } : w));
}
