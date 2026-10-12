// .gitignore для папки вложений. Без vscode (тестируется на временном git-репо): только node:fs и git из PATH.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Путь к папке без `./` и хвостового `/`, разделитель `/`. `undefined` — пусто, `.`, выход наверх или управляющие символы
 * (перевод строки из settings.json дописал бы в .gitignore лишние строки) — такое в .gitignore не пишем.
 */
export function normalizeRel(rel: string): string | undefined {
  if (/[\u0000-\u001f\u007f]/.test(rel)) return undefined;
  const parts = rel.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length || parts.includes('..')) return undefined;
  return parts.join('/');
}

/** Спецсимволы шаблона .gitignore в имени папки экранируем, чтобы строка означала ровно эту папку. */
const escapeGlob = (s: string): string =>
  s.replace(/[\\*?[\]]/g, '\\$&').replace(/^([#!])/, '\\$1').replace(/ $/, '\\ ');

/** Строка для .gitignore: `/<папка>/` (от корня и только каталог). `undefined` — папку описать нельзя. */
export function ignoreLine(rel: string): string | undefined {
  const n = normalizeRel(rel);
  return n === undefined ? undefined : `/${escapeGlob(n)}/`;
}

/**
 * Игнорируется ли папка в git-репо, в котором лежит `wsDir`: `git check-ignore -q <rel>/` (слэш — чтобы ещё не созданная
 * папка считалась каталогом). `core.fsmonitor` отключён: хук из `.git/config` репо запускался бы сам при открытии вкладки. `undefined` — узнать нельзя (нет git, не репо, неверный путь): подсказку не показываем.
 */
export function isIgnored(wsDir: string, rel: string): Promise<boolean | undefined> {
  const n = normalizeRel(rel);
  if (n === undefined) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.fsmonitor=false', 'check-ignore', '-q', '--', `${n}/`], { cwd: wsDir, timeout: 5000, windowsHide: true }, (err) => {
      if (!err) return resolve(true);
      const code = (err as { code?: unknown }).code;
      resolve(code === 1 ? false : undefined); // 1 — не игнорируется; 128 / ENOENT / таймаут — неизвестно
    });
  });
}

/** Дописать строку для `rel` в `<wsDir>/.gitignore` (создать файл, если нет). Уже есть такая строка — ничего не делаем. Вернёт, дописали ли. */
export async function appendIgnore(wsDir: string, rel: string): Promise<boolean> {
  const line = ignoreLine(rel);
  if (line === undefined) throw new Error('bad path');
  const file = path.join(wsDir, '.gitignore');
  // .gitignore-симлинк может вести за пределы workspace: туда не пишем.
  const st = await fs.lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
  if (st && !st.isFile()) throw new Error('.gitignore is not a regular file');
  let cur = '';
  try {
    cur = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (cur.split(/\r?\n/).some((l) => l.trim() === line)) return false;
  const eol = cur.includes('\r\n') ? '\r\n' : '\n';
  await fs.appendFile(file, `${cur && !/\n$/.test(cur) ? eol : ''}${line}${eol}`);
  return true;
}
