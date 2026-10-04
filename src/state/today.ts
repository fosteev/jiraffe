// Сводка «сегодня» по всем инстансам — для раздела Tempo и строки состояния. Без vscode — тестируется в vitest.
import { formatDuration } from '../duration';
import { loadToday, localDate, sumToday, type TodayInstance } from '../jira/worklog';
import type { InstanceStore } from './instances';
import type { InstanceMeta } from './meta';

export interface TodayState {
  date: string;
  loading: boolean;
  /** Была ли хоть одна завершённая загрузка (до неё в строке состояния — «…»). */
  loaded: boolean;
  instances: TodayInstance[];
  totalSec: number;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class TodayService {
  private state: TodayState;
  private gen = 0;
  private readonly listeners = new Set<(s: TodayState) => void>();
  private readonly sub: { dispose(): void };

  constructor(
    private readonly store: InstanceStore,
    private readonly meta: Pick<InstanceMeta, 'client' | 'myself'>,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.state = { date: localDate(now()), loading: false, loaded: false, instances: [], totalSec: 0 };
    this.sub = store.onDidChange(() => void this.refresh());
  }

  dispose(): void {
    this.sub.dispose();
    this.listeners.clear();
  }

  get(): TodayState {
    return this.state;
  }

  onDidChange(fn: (s: TodayState) => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  /** Перечитать все инстансы параллельно; упавший инстанс — строка с ошибкой, остальные считаются. Устаревший ответ отбрасывается. */
  async refresh(): Promise<void> {
    const gen = ++this.gen;
    const date = localDate(this.now());
    const insts = this.store.list();
    // Новый день — старые записи не показываем даже во время загрузки.
    const prev = this.state.date === date ? this.state : { ...this.state, instances: [], totalSec: 0, loaded: false };
    this.set({ ...prev, date, loading: true });
    const results = await Promise.all(insts.map(async (inst): Promise<TodayInstance> => {
      try {
        const [client, me] = await Promise.all([this.meta.client(inst), this.meta.myself(inst)]);
        return await loadToday(client, inst, date, me);
      } catch (e) {
        return { instanceId: inst.id, name: inst.name, tempo: inst.caps?.tempo === true, totalSec: 0, entries: [], error: errText(e) };
      }
    }));
    if (gen !== this.gen) return;
    this.set({ date, loading: false, loaded: true, instances: results, totalSec: sumToday(results) });
  }

  private set(s: TodayState): void {
    this.state = s;
    for (const fn of [...this.listeners]) {
      try {
        fn(s);
      } catch { /* слушатель не должен ломать сервис */ }
    }
  }
}

/** Текст строки состояния: `$(clock) Сегодня 3ч 15м / 8ч`; до первой загрузки — «…», ошибка на инстансе — `$(warning)`. */
export function statusBarText(s: TodayState, workdaySec: number): string {
  if (!s.loaded) return '$(clock) Сегодня …';
  const warn = s.instances.some((i) => i.error) ? ' $(warning)' : '';
  return `$(clock) Сегодня ${formatDuration(s.totalSec)} / ${formatDuration(workdaySec)}${warn}`;
}

/** Подсказка строки состояния: по инстансам (имена — недоверенный текст, вызывающий экранирует для markdown). */
export function statusBarLines(s: TodayState): string[] {
  if (!s.loaded) return ['Загрузка…'];
  if (!s.instances.length) return ['Нет подключённых инстансов'];
  return s.instances.map((i) => `${i.name}: ${i.error ? `ошибка — ${i.error}` : formatDuration(i.totalSec)}${i.tempo ? ' · Tempo' : ''}`);
}
