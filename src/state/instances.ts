// vscode — только типы (import type стирается), поэтому модуль грузится и в vitest.
import type { Memento, SecretStorage } from 'vscode';
import { normalizeBaseUrl } from '../jira/http';
import type { Capabilities, Instance } from '../jira/types';

export const INSTANCES_KEY = 'jiraffe.instances';
export const tokenKey = (id: string): string => `jiraffe.token.${id}`;

/** slug хоста (+context path): `https://atlassian.tatikoma.ru/jira` → `atlassian-tatikoma-ru-jira`. */
export function instanceIdFromUrl(url: string): string {
  const u = new URL(normalizeBaseUrl(url));
  return (u.host + u.pathname)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Входит ли инстанс в набор workspace (`jiraffe.instances`): элемент — id инстанса или его адрес.
 * Набор не задан (undefined) — видны все.
 */
export function inScope(inst: Instance, scope: readonly string[] | undefined): boolean {
  if (!scope) return true;
  return scope.some((s) => {
    if (s === inst.id) return true;
    try {
      return instanceIdFromUrl(s) === inst.id;
    } catch {
      return false;
    }
  });
}

export class InstanceStore {
  private listeners = new Set<() => void>();
  private scope: () => readonly string[] | undefined = () => undefined;

  constructor(
    private readonly state: Memento,
    private readonly secrets: SecretStorage,
  ) {}

  onDidChange(fn: () => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => void this.listeners.delete(fn) };
  }

  /** Откуда брать набор инстансов workspace; после смены набора — `scopeChanged()`. */
  setScope(fn: () => readonly string[] | undefined): void {
    this.scope = fn;
  }

  scopeChanged(): void {
    this.fire();
  }

  /** Инстансы этого workspace (всё, что показываем и опрашиваем). */
  list(): Instance[] {
    const scope = this.scope();
    return this.all().filter((i) => inScope(i, scope));
  }

  /** Все подключённые инстансы, без фильтра workspace (управление подключениями). */
  all(): Instance[] {
    const v = this.state.get<unknown>(INSTANCES_KEY, []);
    return Array.isArray(v) ? (v as Instance[]).filter((i) => i && typeof i.id === 'string' && typeof i.baseUrl === 'string') : [];
  }

  /** По id — среди всех: открытые карточки и сохранённые ссылки не ломаются от смены набора. */
  get(id: string): Instance | undefined {
    return this.all().find((i) => i.id === id);
  }

  /** Инстанс есть и входит в набор этого workspace. */
  visible(id: string): boolean {
    const inst = this.get(id);
    return !!inst && inScope(inst, this.scope());
  }

  getToken(id: string): Thenable<string | undefined> {
    return this.secrets.get(tokenKey(id));
  }

  /** Новый инстанс (или замена с тем же id) вместе с токеном. */
  async add(instance: Instance, token: string): Promise<void> {
    await this.secrets.store(tokenKey(instance.id), token);
    await this.state.update(INSTANCES_KEY, [...this.all().filter((i) => i.id !== instance.id), instance]);
    this.fire();
  }

  async updateCaps(id: string, caps: Capabilities): Promise<void> {
    await this.state.update(INSTANCES_KEY, this.all().map((i) => (i.id === id ? { ...i, caps } : i)));
    this.fire();
  }

  async remove(id: string): Promise<void> {
    await this.secrets.delete(tokenKey(id));
    await this.state.update(INSTANCES_KEY, this.all().filter((i) => i.id !== id));
    this.fire();
  }

  private fire(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // упавший слушатель (дерево) не должен откатывать уже записанное изменение
      }
    }
  }
}
