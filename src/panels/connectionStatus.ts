// Статусы подключений для вкладки настроек: в памяти хоста, не персистятся. Без vscode — тестируется напрямую.
import { JiraError } from '../jira/http';
import type { Instance } from '../jira/types';
import { inScope } from '../state/instances';
import type { ConnStatusInput } from './settingsModel';
import { t } from '../l10n';

const MAX_ERROR = 300;

/** Текст ошибки проверки для карточки: 401 — «токен не принят», остальное — как есть, но не длиннее MAX_ERROR. */
export function connectionErrorText(e: unknown): string {
  if (e instanceof JiraError && e.status === 401) return t('Token was rejected (401). Update the token.');
  const m = e instanceof Error ? e.message : String(e);
  return m.length > MAX_ERROR ? `${m.slice(0, MAX_ERROR)}…` : m;
}

/** «displayName · name» (на Cloud name может совпасть с displayName — тогда одно). */
export function accountLabel(me: { displayName: string; name: string }): string {
  return me.name && me.name !== me.displayName ? `${me.displayName} · ${me.name}` : me.displayName;
}

/**
 * Последний известный результат `myself()` по инстансам. Гонки: у каждого инстанса свой номер запуска;
 * ответ, пришедший после более нового запуска, и ответ для уже удалённого инстанса выбрасываются.
 */
export class ConnectionStatus {
  private readonly map = new Map<string, ConnStatusInput>();
  private readonly seq = new Map<string, number>();

  constructor(
    /** Есть ли инстанс сейчас (после `await` его могли отключить). */
    private readonly exists: (id: string) => boolean,
    private readonly onChange: () => void,
  ) {}

  get(id: string): ConnStatusInput | undefined {
    return this.map.get(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  /** Забыть статусы инстансов, которых больше нет; идущие проверки для них закончатся впустую. */
  prune(): void {
    for (const id of [...this.map.keys()]) if (!this.exists(id)) this.forget(id);
  }

  forget(id: string): void {
    this.map.delete(id);
    this.seq.set(id, (this.seq.get(id) ?? 0) + 1);
  }

  /** Запустить проверку: «проверяется» сразу, итог — если этот запуск остался последним и инстанс жив. */
  async check(id: string, run: () => Promise<{ displayName: string; name: string }>): Promise<void> {
    const n = (this.seq.get(id) ?? 0) + 1;
    this.seq.set(id, n);
    this.map.set(id, { state: 'checking' });
    this.onChange();
    let res: ConnStatusInput;
    try {
      res = { state: 'ok', account: accountLabel(await run()) };
    } catch (e) {
      res = { state: 'error', message: connectionErrorText(e) };
    }
    if (this.seq.get(id) !== n || !this.exists(id)) return;
    this.map.set(id, res);
    this.onChange();
  }
}

/** Снимок того, от чего зависит результат проверки: другой адрес/тип/email/caps под тем же id — это уже другое подключение. */
export const instanceSnapshot = (i: Instance): string => JSON.stringify([i.baseUrl, i.kind, i.email ?? '', i.caps ?? null]);
/** Куда и как ходит клиент (без caps): проверенный на этой записи токен/caps годятся, пока это не изменилось. */
export const instanceIdentity = (i: Instance): string => JSON.stringify([i.baseUrl, i.kind, i.email ?? '']);

export type ScopeIntent = { type: 'scopeMode'; mode: 'all' | 'some' } | { type: 'scopeToggle'; id: string; on: boolean };
/** `skip` — писать нечего; `empty` — снят последний флажок (отказ); `write` — новое значение уровня Workspace (`undefined` = снять). */
export type ScopeWrite = { kind: 'skip' } | { kind: 'empty' } | { kind: 'write'; value: string[] | undefined };

/**
 * Что записать в `jiraffe.instances` (уровень Workspace) по действию на вкладке.
 * `cur` — действующий набор (`readScope`), `globalValue` — значение из пользовательских настроек.
 * «Все»: снять workspace-значение; если набор задан в пользовательских — `[]` (массив уровня Workspace целиком
 * перекрывает пользовательский, `readScope` читает `[]` как «все»). «Отмеченные» — всегда явный список id.
 */
export function planScopeWrite(m: ScopeIntent, cur: readonly string[] | undefined, globalValue: unknown, all: readonly Instance[]): ScopeWrite {
  const visible = all.filter((i) => inScope(i, cur)).map((i) => i.id);
  if (m.type === 'scopeMode') {
    if (m.mode === 'some') return cur !== undefined || !all.length ? { kind: 'skip' } : { kind: 'write', value: visible };
    if (cur === undefined) return { kind: 'skip' };
    const fromUser = Array.isArray(globalValue) && globalValue.some((x) => typeof x === 'string' && x.trim());
    return { kind: 'write', value: fromUser ? [] : undefined };
  }
  if (cur === undefined || !all.some((i) => i.id === m.id)) return { kind: 'skip' };
  const next = m.on ? [...new Set([...visible, m.id])] : visible.filter((x) => x !== m.id);
  return next.length ? { kind: 'write', value: next } : { kind: 'empty' };
}
