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

  constructor(
    private readonly memento: Memento,
    private readonly stateKey: string,
  ) {}

  get(): ProjectSel | undefined {
    return sanitizeProjectSel(this.memento.get<unknown>(this.stateKey));
  }

  set(sel: ProjectSel): void {
    void this.memento.update(this.stateKey, sel);
    for (const l of this.listeners) l();
  }

  onDidChange(fn: () => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => void this.listeners.delete(fn) };
  }
}
