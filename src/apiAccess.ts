// Настройки доступа публичного API (`jiraffe.api.enabled`, `jiraffe.api.allowWrites`) → `ApiAccess`. Без vscode — тестируется напрямую.
// Обе настройки `scope: application`: задаются только в пользовательских настройках. Читаем их тоже только оттуда
// (`globalValue`), а не через `get()`: так .vscode/settings.json чужого репо не повлияет на доступ, даже если VS Code
// когда-нибудь начнёт его учитывать.
import type { ApiAccess } from './api';

/** Секция настроек (`getConfiguration`) и ключи внутри неё: `jiraffe.api.enabled`, `jiraffe.api.allowWrites`. */
export const API_SECTION = 'jiraffe.api';
export const API_ENABLED = 'enabled';
export const API_ALLOW_WRITES = 'allowWrites';

/** То, что `WorkspaceConfiguration.inspect()` отдаёт для булевой настройки. `unknown`: settings.json схему не навязывает. */
export interface InspectedFlag { defaultValue?: unknown; globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }

export interface ApiFlag {
  /** Действующее значение: гейт открывается только на строгом `true`. */
  value: boolean;
  /** Стандартное значение (из `package.json`; `true`, если оно не boolean). */
  def: boolean;
  /** Значение в пользовательских настройках отличается от стандартного — есть что сбрасывать. */
  modified: boolean;
}

/**
 * Значение флага: пользовательское (`globalValue`), иначе стандартное. Workspace и папка не учитываются.
 * Всё, что не `true`, — выключено: `"false"`, `0`, `null` в settings.json не должны открывать доступ.
 */
export function apiFlag(ins: InspectedFlag | undefined): ApiFlag {
  const def = typeof ins?.defaultValue === 'boolean' ? ins.defaultValue : true;
  if (ins?.globalValue === undefined) return { value: def, def, modified: false };
  return { value: ins.globalValue === true, def, modified: ins.globalValue !== def };
}

/** Доступ API: запись = включено И разрешена запись. */
export function resolveApiAccess(enabled: InspectedFlag | undefined, allowWrites: InspectedFlag | undefined): ApiAccess {
  const read = apiFlag(enabled).value;
  return { read, write: read && apiFlag(allowWrites).value };
}
