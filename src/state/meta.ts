// Кэш справочников инстансов (проекты, типы, приоритеты) и фабрика клиентов.
// vscode не импортирует — тестируется в vitest.
import { createJiraClient, type JiraClient, type MyselfInfo, type NamedRef, type ProjectRef } from '../jira/client';
import { TempoClient, type WorkAttribute } from '../jira/tempo';
import type { Instance } from '../jira/types';
import type { InstanceStore } from './instances';

type Factory = typeof createJiraClient;

export class InstanceMeta {
  private readonly sub: { dispose(): void };
  private projectsC = new Map<string, Promise<ProjectRef[]>>();
  private typesC = new Map<string, Promise<NamedRef[]>>();
  private prioritiesC = new Map<string, Promise<NamedRef[]>>();
  private myselfC = new Map<string, Promise<MyselfInfo>>();
  private attrsC = new Map<string, Promise<WorkAttribute[]>>();

  constructor(
    private readonly store: InstanceStore,
    private readonly factory: Factory = createJiraClient,
  ) {
    this.sub = store.onDidChange(() => this.invalidate());
  }

  dispose(): void {
    this.sub.dispose();
  }

  async client(inst: Instance): Promise<JiraClient> {
    const token = await this.store.getToken(inst.id);
    if (!token) throw new Error('токен не найден в SecretStorage — добавьте инстанс заново');
    return this.factory(inst, token);
  }

  projects(inst: Instance): Promise<ProjectRef[]> {
    return this.cached(this.projectsC, inst, (c) => c.projects());
  }

  types(inst: Instance): Promise<NamedRef[]> {
    return this.cached(this.typesC, inst, (c) => c.issueTypes());
  }

  priorities(inst: Instance): Promise<NamedRef[]> {
    return this.cached(this.prioritiesC, inst, (c) => c.priorities());
  }

  /** Текущий пользователь инстанса (логин на DC — автор ворклога Tempo, id — фильтр «мои ворклоги»). */
  myself(inst: Instance): Promise<MyselfInfo> {
    return this.cached(this.myselfC, inst, (c) => c.myself());
  }

  /** Рабочие атрибуты Tempo (`/rest/tempo-core/1/work-attribute`); без Tempo — пусто, без запроса. */
  workAttributes(inst: Instance): Promise<WorkAttribute[]> {
    if (!inst.caps?.tempo) return Promise.resolve([]);
    return this.cached(this.attrsC, inst, (c) => new TempoClient(c.http).attributes());
  }

  invalidate(): void {
    this.projectsC.clear();
    this.typesC.clear();
    this.prioritiesC.clear();
    this.myselfC.clear();
    this.attrsC.clear();
  }

  /** Успешный ответ кэшируется, ошибка — нет (следующий вызов пойдёт в сеть заново). */
  private cached<T>(cache: Map<string, Promise<T>>, inst: Instance, load: (c: JiraClient) => Promise<T>): Promise<T> {
    let p = cache.get(inst.id);
    if (!p) {
      p = this.client(inst).then(load);
      cache.set(inst.id, p);
      p.catch(() => {
        if (cache.get(inst.id) === p) cache.delete(inst.id);
      });
    }
    return p;
  }
}

/** Префикс ключа задачи (`ABC-123` → `ABC`) или undefined. */
export function keyPrefix(key: string): string | undefined {
  const m = /^([A-Za-z][A-Za-z0-9_]+)-\d+$/.exec(key.trim());
  return m ? m[1].toUpperCase() : undefined;
}

/** Инстансы, где есть проект с префиксом ключа. */
export function matchInstancesByKey(key: string, projects: ReadonlyMap<string, readonly { key: string }[]>): string[] {
  const prefix = keyPrefix(key);
  if (!prefix) return [];
  return [...projects].filter(([, ps]) => ps.some((p) => p.key.toUpperCase() === prefix)).map(([id]) => id);
}

/** Типы/приоритеты, которые реально есть на инстансе (имена без учёта регистра). Неизвестное на инстансе JQL не принимает. */
export function intersectNames(wanted: readonly string[], available: readonly { name: string }[]): string[] {
  const byLower = new Map(available.map((a) => [a.name.toLowerCase(), a.name]));
  return wanted.map((w) => byLower.get(w.toLowerCase())).filter((x): x is string => x !== undefined);
}

/** Объединение имён по инстансам без дублей (регистр не важен), порядок — по первому появлению. */
export function unionNames(lists: readonly (readonly { name: string }[])[]): string[] {
  const seen = new Map<string, string>();
  for (const l of lists) for (const x of l) if (!seen.has(x.name.toLowerCase())) seen.set(x.name.toLowerCase(), x.name);
  return [...seen.values()];
}
