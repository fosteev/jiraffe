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
