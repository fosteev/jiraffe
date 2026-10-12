// Пути для настройки папки вложений. Отдельно от settingsModel: тот попадает в бандл webview (через protocol), а `node:path` там нет.
import path from 'node:path';
import { resolveAttachmentsRoot, type AttachmentsRootInput } from '../jira/attachments';

/** Путь выбранной в диалоге папки относительно папки workspace (через `/`). `undefined` — снаружи или это сама папка workspace. */
export function relativeInside(workspaceDir: string, picked: string): string | undefined {
  const rel = path.relative(path.resolve(workspaceDir), path.resolve(picked));
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

/** Абсолютный ли путь (POSIX или Windows) — в workspace-настройки такой не пишем. */
export const isAbsoluteDir = (s: string): boolean => path.isAbsolute(s) || path.win32.isAbsolute(s);

/**
 * Папка вложений относительно первой папки workspace, если файлы реально лягут внутрь неё (тогда имеет смысл .gitignore).
 * Берём тот же разбор, что и сохранение вложений: абсолютный путь, отсутствие workspace и временный каталог дают `undefined`.
 */
export function attachmentsIgnoreTarget(o: AttachmentsRootInput): string | undefined {
  if (!o.workspaceDir) return undefined;
  const r = resolveAttachmentsRoot(o);
  return r.inWorkspace && !r.tmp ? relativeInside(o.workspaceDir, r.root) : undefined;
}
