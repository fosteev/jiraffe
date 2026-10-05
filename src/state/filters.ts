// vscode — только типы: модуль тестируется в vitest.
import type { Memento } from 'vscode';
import type { StatusCategory } from '../jira/types';
import { type Mode, type QuickFilters } from '../jql';
import { t, tn } from '../l10n';

export const STATE_KEY = 'jiraffe.filterState';
export const SAVED_KEY = 'jiraffe.filters';

export interface ProjectSel { instanceId: string; key: string }
export interface SavedFilter { id: string; name: string; jql: string; instanceId?: string }

export interface FilterSnapshot {
  mode: Mode;
  project?: ProjectSel;
  jql: string;
  /** Если JQL взят из фильтра конкретного инстанса — опрашиваем только его. */
  jqlScope?: string;
  /** Имя применённого фильтра (для подписи в заголовке). */
  savedName?: string;
  quick: QuickFilters;
  text: string;
  /** Какие инстансы опрашивать (пусто — все). */
  instances: string[];
}

const CATS: StatusCategory[] = ['new', 'indeterminate', 'done'];
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function emptyQuick(): QuickFilters {
  return { statusCategory: [], types: [], priorities: [] };
}

export function sanitizeSnapshot(v: unknown): FilterSnapshot {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const q = (o.quick && typeof o.quick === 'object' ? o.quick : {}) as Record<string, unknown>;
  const p = o.project as Record<string, unknown> | undefined;
  const mode: Mode = o.mode === 'project' || o.mode === 'jql' ? o.mode : 'mine';
  const project = p && str(p.instanceId) && str(p.key) ? { instanceId: str(p.instanceId)!, key: str(p.key)! } : undefined;
  return {
    mode,
    ...(project ? { project } : {}),
    jql: typeof o.jql === 'string' ? o.jql : '',
    ...(str(o.jqlScope) ? { jqlScope: str(o.jqlScope) } : {}),
    ...(str(o.savedName) ? { savedName: str(o.savedName) } : {}),
    quick: {
      statusCategory: strs(q.statusCategory).filter((c): c is StatusCategory => CATS.includes(c as StatusCategory)),
      types: strs(q.types),
      priorities: strs(q.priorities),
    },
    text: typeof o.text === 'string' ? o.text : '',
    instances: strs(o.instances),
  };
}

/** Действует ли выбор инстансов: в режиме «проект» и у JQL из фильтра инстанс один и задан ими. */
export const instancesApply = (s: FilterSnapshot): boolean => s.mode === 'mine' || (s.mode === 'jql' && !s.jqlScope);

/** Число активных быстрых фильтров: каждая выбранная категория/тип/приоритет/инстанс (если действует) + текст. */
export function activeFilterCount(s: FilterSnapshot): number {
  return s.quick.statusCategory.length + s.quick.types.length + s.quick.priorities.length + (instancesApply(s) ? s.instances.length : 0) + (s.text.trim() ? 1 : 0);
}

/** Подпись в заголовке view: «2 фильтра · GARM». */
export function describeFilters(s: FilterSnapshot): string {
  const n = activeFilterCount(s);
  const parts: string[] = [];
  if (n) parts.push(tn(n, '{0} filter|{0} filters'));
  if (s.mode === 'project') parts.push(s.project?.key ?? t('no project selected'));
  else if (s.mode === 'jql') parts.push(s.savedName ? t('“{0}”', s.savedName) : 'JQL');
  else if (!n) parts.push(t('assigned to me'));
  return parts.join(' · ');
}

export class FilterState {
  private snap: FilterSnapshot;
  private listeners = new Set<() => void>();
  private savedListeners = new Set<() => void>();

  /**
   * Сохранённые фильтры — общие (`memento`, globalState); текущий выбор — свой у каждого workspace (`local`),
   * а пока workspace его не менял — берём последний глобальный.
   */
  constructor(
    private readonly memento: Memento,
    private readonly local: Memento = memento,
  ) {
    this.snap = sanitizeSnapshot(local.get<unknown>(STATE_KEY) ?? memento.get<unknown>(STATE_KEY));
  }

  onDidChange(fn: () => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => void this.listeners.delete(fn) };
  }

  /** Изменился список локальных фильтров (дерево задач от этого не перезагружается). */
  onDidChangeSaved(fn: () => void): { dispose(): void } {
    this.savedListeners.add(fn);
    return { dispose: () => void this.savedListeners.delete(fn) };
  }

  get snapshot(): FilterSnapshot {
    return this.snap;
  }

  setMode(mode: Mode): void {
    this.patch({ mode });
  }

  setProject(project: ProjectSel): void {
    this.patch({ mode: 'project', project });
  }

  /**
   * `baked` — что уже «запечено» в этот JQL и снимается с быстрых фильтров: `all` — категории, типы, приоритеты и текст
   * (сохранённый фильтр), `categories` — только категории статуса (конвертация режима в `editJql`). Выбор инстансов
   * в JQL не запекается и остаётся.
   */
  setJql(jql: string, opts: { scope?: string; savedName?: string; baked?: 'all' | 'categories' } = {}): void {
    const baked: Partial<FilterSnapshot> =
      opts.baked === 'all' ? { quick: emptyQuick(), text: '' }
      : opts.baked === 'categories' ? { quick: { ...this.snap.quick, statusCategory: [] } }
      : {};
    this.patch({ mode: 'jql', jql, jqlScope: opts.scope, savedName: opts.savedName, ...baked });
  }

  setQuick(quick: QuickFilters, instances: string[]): void {
    this.patch({ quick, instances });
  }

  setText(text: string): void {
    this.patch({ text });
  }

  /**
   * Сбрасывает быстрые фильтры, текст и выбор инстансов; режим и проект остаются. Если передан список существующих
   * инстансов — снимает и ссылки на удалённые: проект (останется «выберите проект») и привязку JQL к инстансу.
   */
  reset(existing?: string[]): void {
    const p: Partial<FilterSnapshot> = { quick: emptyQuick(), text: '', instances: [] };
    if (existing && this.snap.project && !existing.includes(this.snap.project.instanceId)) p.project = undefined;
    if (existing && this.snap.jqlScope && !existing.includes(this.snap.jqlScope)) p.jqlScope = undefined;
    this.patch(p);
  }

  /** Идентификаторы инстансов, которые надо опрашивать (из существующих). */
  activeInstanceIds(existing: string[]): string[] {
    const s = this.snap;
    if (s.mode === 'project') return s.project && existing.includes(s.project.instanceId) ? [s.project.instanceId] : [];
    if (s.mode === 'jql' && s.jqlScope) return existing.includes(s.jqlScope) ? [s.jqlScope] : [];
    const chosen = s.instances.filter((i) => existing.includes(i));
    return chosen.length ? chosen : existing;
  }

  // ----- локальные («Мои») фильтры -----

  listSaved(): SavedFilter[] {
    const v = this.memento.get<unknown>(SAVED_KEY, []);
    return Array.isArray(v)
      ? (v as SavedFilter[]).filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string' && typeof f.jql === 'string' && (f.instanceId === undefined || typeof f.instanceId === 'string'))
      : [];
  }

  async saveFilter(name: string, jql: string, instanceId?: string): Promise<SavedFilter> {
    const f: SavedFilter = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, jql, ...(instanceId ? { instanceId } : {}) };
    await this.memento.update(SAVED_KEY, [...this.listSaved(), f]);
    this.fire(this.savedListeners);
    return f;
  }

  async deleteFilter(id: string): Promise<void> {
    await this.memento.update(SAVED_KEY, this.listSaved().filter((f) => f.id !== id));
    this.fire(this.savedListeners);
  }

  private patch(p: Partial<FilterSnapshot>): void {
    const next = { ...this.snap, ...p } as FilterSnapshot;
    // undefined-поля не должны оставаться ключами (JSON и сравнение)
    for (const k of Object.keys(next) as (keyof FilterSnapshot)[]) if (next[k] === undefined) delete next[k];
    this.snap = next;
    void this.local.update(STATE_KEY, next);
    this.fire();
  }

  private fire(listeners: Set<() => void> = this.listeners): void {
    for (const l of listeners) {
      try {
        l();
      } catch {
        // упавший слушатель не должен ломать состояние
      }
    }
  }
}
