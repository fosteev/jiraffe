// Что чистить, когда инстанс отключён. Без vscode: хранилище и подписчики приходят интерфейсами (тестируется на фейках).

interface Forgettable { forgetInstance(instanceId: string): Promise<void> }
interface IdSource { all(): readonly { id: string }[]; onDidChange(fn: () => void): { dispose(): void } }

/** Сохранённые фильтры инстанса, проект режима «Проект» и проекты разделов «Эпики» / «Релизы» с этим инстансом. */
export async function forgetInstance(id: string, targets: readonly Forgettable[]): Promise<void> {
  for (const t of targets) {
    try {
      await t.forgetInstance(id);
    } catch {
      // сбой очистки одного хранилища не должен мешать остальным
    }
  }
}

/**
 * Зовёт `onRemoved(id)` для каждого id, пропавшего из `store.all()` между событиями. Сравнение множеств, а не вызов из
 * `remove()`: так сработает и команда `jiraffe.removeInstance`, и «Отключить» на вкладке, и любой будущий путь.
 * Смена набора workspace и замена записи под тем же id (повторное «Подключить») удалением не считаются.
 */
export function watchRemovedInstances(store: IdSource, onRemoved: (id: string) => void): { dispose(): void } {
  let known = new Set(store.all().map((i) => i.id));
  return store.onDidChange(() => {
    const next = new Set(store.all().map((i) => i.id));
    for (const id of known) if (!next.has(id)) onRemoved(id);
    known = next;
  });
}
