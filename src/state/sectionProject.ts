// Проект, выбранный в разделе «Эпики» или «Релизы» (у каждого раздела свой — как в прототипе; не связан с режимом «Проект» в «Задачах»).
// vscode — только типы: модуль тестируется в vitest.
import type { Memento } from 'vscode';
import type { ProjectSel } from './filters';

export const EPIC_PROJECT_KEY = 'jiraffe.epicProject';
export const RELEASE_PROJECT_KEY = 'jiraffe.releaseProject';

export function sanitizeProjectSel(v: unknown): ProjectSel | undefined {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return typeof o.instanceId === 'string' && o.instanceId && typeof o.key === 'string' && o.key ? { instanceId: o.instanceId, key: o.key } : undefined;
}

export class SectionProject {
  private listeners = new Set<() => void>();

  /** Выбор — свой у каждого workspace (`memento`); пока не менялся — берём глобальный (`fallback`). */
  constructor(
    private readonly memento: Memento,
    private readonly stateKey: string,
    private readonly fallback?: Memento,
  ) {}

  get(): ProjectSel | undefined {
    return sanitizeProjectSel(this.memento.get<unknown>(this.stateKey) ?? this.fallback?.get<unknown>(this.stateKey));
  }

  set(sel: ProjectSel): void {
    void this.memento.update(this.stateKey, sel);
    for (const l of this.listeners) l();
  }

  /** Инстанс отключён: если выбранный проект (в workspace или в глобальном запасном значении) — его, выбор сбрасывается. */
  async forgetInstance(instanceId: string): Promise<void> {
    let changed = false;
    for (const m of [this.memento, this.fallback]) {
      if (m && sanitizeProjectSel(m.get<unknown>(this.stateKey))?.instanceId === instanceId) {
        await m.update(this.stateKey, undefined);
        changed = true;
      }
    }
    if (changed) for (const l of this.listeners) l();
  }

  onDidChange(fn: () => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => void this.listeners.delete(fn) };
  }
}

const selId = (s: ProjectSel): string => `${s.instanceId}\n${s.key}`;

/** Список под одним ключом: массив; одиночный объект (как писал `SectionProject` до 0.10) читается как список из одного. */
export function sanitizeProjectList(v: unknown): ProjectSel[] {
  const seen = new Set<string>();
  const out: ProjectSel[] = [];
  for (const raw of Array.isArray(v) ? v : [v]) {
    const s = sanitizeProjectSel(raw);
    if (s && !seen.has(selId(s))) {
      seen.add(selId(s));
      out.push(s);
    }
  }
  return out;
}

/** Несколько проектов раздела («Релизы»). Хранение и запасное глобальное значение — как у `SectionProject`. */
export class SectionProjects {
  private listeners = new Set<() => void>();

  constructor(
    private readonly memento: Memento,
    private readonly stateKey: string,
    private readonly fallback?: Memento,
  ) {}

  get(): ProjectSel[] {
    return sanitizeProjectList(this.memento.get<unknown>(this.stateKey) ?? this.fallback?.get<unknown>(this.stateKey));
  }

  set(list: readonly ProjectSel[]): void {
    void this.memento.update(this.stateKey, sanitizeProjectList(list));
    this.fire();
  }

  remove(sel: ProjectSel): void {
    this.set(this.get().filter((s) => selId(s) !== selId(sel)));
  }

  /** Инстанс отключён: его проекты убираются из списка workspace и из глобального запасного. */
  async forgetInstance(instanceId: string): Promise<void> {
    let changed = false;
    for (const m of [this.memento, this.fallback]) {
      const raw = m?.get<unknown>(this.stateKey);
      if (!m || raw === undefined) continue;
      const list = sanitizeProjectList(raw);
      const kept = list.filter((s) => s.instanceId !== instanceId);
      if (kept.length !== list.length) {
        await m.update(this.stateKey, kept); // пустой список, а не undefined: иначе workspace откатился бы на запасной
        changed = true;
      }
    }
    if (changed) this.fire();
  }

  onDidChange(fn: () => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => void this.listeners.delete(fn) };
  }

  private fire(): void {
    for (const l of this.listeners) l();
  }
}
