// «Последняя запись через публичный API» для вкладки настроек: в памяти хоста, не персистится (решение 11 roadmap-settings).
// Без vscode — тестируется напрямую.
import type { WriteKind } from '../api';

export interface ApiWrite {
  kind: WriteKind;
  /** Ключ задачи, как его нормализовал API. */
  key: string;
  /** Миллисекунды (Date.now). */
  at: number;
}

export class ApiActivity {
  private last: ApiWrite | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Попытка записи, прошедшая проверки API (в том числе неуверенная, отвергнутая Jira или упавшая раньше отправки — нет токена, сеть). Отказ самого API сюда не попадает. */
  record(kind: WriteKind, key: string): void {
    this.last = { kind, key, at: this.now() };
    for (const f of [...this.listeners]) {
      try { f(); } catch { /* подписчик (перерисовка вкладки) — не часть записи */ }
    }
  }

  get(): ApiWrite | undefined {
    return this.last;
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }
}
