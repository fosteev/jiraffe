import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appendIgnore, ignoreLine, isIgnored, normalizeRel } from '../src/state/gitignore';
import { attachmentsIgnoreTarget } from '../src/panels/settingsPaths';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'jiraffe-gi-'));
  dirs.push(d);
  return d;
};
const repo = (): string => {
  const d = tmp();
  execFileSync('git', ['init', '-q'], { cwd: d });
  return d;
};
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('ignoreLine / normalizeRel', () => {
  it('./x, x/, x, x/y', () => {
    expect(ignoreLine('./x')).toBe('/x/');
    expect(ignoreLine('x/')).toBe('/x/');
    expect(ignoreLine('x')).toBe('/x/');
    expect(ignoreLine('x/y')).toBe('/x/y/');
    expect(ignoreLine('./a//b/./')).toBe('/a/b/');
    expect(ignoreLine('a\\b')).toBe('/a/b/');
  });
  it('пробелы внутри остаются, в конце имени экранируются', () => {
    expect(ignoreLine('my dir/att')).toBe('/my dir/att/');
    expect(ignoreLine('x ')).toBe('/x\\ /');
  });
  it('спецсимволы шаблона экранируются, чтобы строка означала ровно эту папку', () => {
    expect(ignoreLine('a*b')).toBe('/a\\*b/');
    expect(ignoreLine('[x]')).toBe('/\\[x\\]/');
    expect(ignoreLine('#c')).toBe('/\\#c/');
    expect(ignoreLine('!n')).toBe('/\\!n/');
  });
  it('пусто, точка и выход наверх — строки нет', () => {
    for (const v of ['', '.', './', '..', '../x', 'a/../b']) expect(ignoreLine(v), v).toBeUndefined();
    expect(normalizeRel('/')).toBeUndefined();
  });
});

describe('isIgnored / appendIgnore на настоящем git-репо (временная папка)', () => {
  it('нет строки → false; кнопка дописывает → true; повторно не дублирует', async () => {
    const d = repo();
    expect(await isIgnored(d, '.jiraffe')).toBe(false);
    expect(await appendIgnore(d, '.jiraffe')).toBe(true);
    expect(readFileSync(path.join(d, '.gitignore'), 'utf8')).toBe('/.jiraffe/\n');
    expect(await isIgnored(d, '.jiraffe')).toBe(true);
    expect(await appendIgnore(d, './.jiraffe/')).toBe(false);
    expect(readFileSync(path.join(d, '.gitignore'), 'utf8')).toBe('/.jiraffe/\n');
  });

  it('существующая папка и ещё не созданная ведут себя одинаково', async () => {
    const d = repo();
    mkdirSync(path.join(d, 'docs', 'att'), { recursive: true });
    expect(await isIgnored(d, 'docs/att')).toBe(false);
    expect(await isIgnored(d, 'nope/att')).toBe(false);
    await appendIgnore(d, 'docs/att');
    expect(await isIgnored(d, 'docs/att')).toBe(true);
    expect(await isIgnored(d, 'nope/att')).toBe(false);
  });

  it('файл без перевода строки в конце: перед строкой добавляется перевод; CRLF сохраняется', async () => {
    const d = repo();
    writeFileSync(path.join(d, '.gitignore'), 'node_modules');
    await appendIgnore(d, 'att');
    expect(readFileSync(path.join(d, '.gitignore'), 'utf8')).toBe('node_modules\n/att/\n');
    const e = repo();
    writeFileSync(path.join(e, '.gitignore'), 'a\r\nb');
    await appendIgnore(e, 'att');
    expect(readFileSync(path.join(e, '.gitignore'), 'utf8')).toBe('a\r\nb\r\n/att/\r\n');
  });

  it('уже заканчивается переводом строки — пустых строк не добавляем', async () => {
    const d = repo();
    writeFileSync(path.join(d, '.gitignore'), 'x\n');
    await appendIgnore(d, 'att');
    expect(readFileSync(path.join(d, '.gitignore'), 'utf8')).toBe('x\n/att/\n');
  });

  it('имя с пробелом и спецсимволом после дописывания действительно игнорируется', async () => {
    const d = repo();
    await appendIgnore(d, 'my dir/a[1]');
    expect(await isIgnored(d, 'my dir/a[1]')).toBe(true);
    expect(await isIgnored(d, 'my dir/a1')).toBe(false);
  });

  it('вложенная папка workspace в репо: .gitignore пишется в неё и действует', async () => {
    const d = repo();
    const sub = path.join(d, 'pkg');
    mkdirSync(sub);
    expect(await isIgnored(sub, 'att')).toBe(false);
    await appendIgnore(sub, 'att');
    expect(await isIgnored(sub, 'att')).toBe(true);
  });

  it('не репозиторий → undefined (подсказки нет); репо пользователя не затрагивается', async () => {
    const d = tmp();
    expect(await isIgnored(d, '.jiraffe')).toBeUndefined();
    expect(await isIgnored(d, '..')).toBeUndefined();
  });

  it('нет git в PATH → undefined', async () => {
    const d = repo();
    const old = process.env.PATH;
    process.env.PATH = path.join(d, 'empty');
    try {
      expect(await isIgnored(d, '.jiraffe')).toBeUndefined();
    } finally {
      process.env.PATH = old;
    }
  });

  it('путь, который описать нельзя, — ошибка записи', async () => {
    await expect(appendIgnore(tmp(), '../x')).rejects.toThrow();
  });

  it('перевод строки в имени папки: строки нет, git не зовём, файл не пишем', async () => {
    const d = repo();
    expect(normalizeRel('x\n!keep')).toBeUndefined();
    expect(ignoreLine('x\r\n#y')).toBeUndefined();
    expect(await isIgnored(d, 'x\n!keep')).toBeUndefined();
    await expect(appendIgnore(d, 'x\n!keep')).rejects.toThrow();
    expect(() => readFileSync(path.join(d, '.gitignore'))).toThrow();
  });

  it('хук core.fsmonitor из .git/config репо не запускается', async () => {
    const d = repo();
    const mark = path.join(tmp(), 'ran');
    const hook = path.join(d, 'hook.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${mark}'\n`, { mode: 0o755 });
    execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: d });
    writeFileSync(path.join(d, 'a.txt'), 'x');
    execFileSync('git', ['-c', 'core.fsmonitor=false', 'add', 'a.txt'], { cwd: d });
    expect(await isIgnored(d, '.jiraffe')).toBe(false);
    expect(() => readFileSync(mark)).toThrow();
  });

  it('.gitignore — симлинк на файл снаружи: отказ, внешний файл не тронут', async () => {
    const d = repo();
    const outside = path.join(tmp(), 'victim');
    writeFileSync(outside, 'keep\n');
    symlinkSync(outside, path.join(d, '.gitignore'));
    await expect(appendIgnore(d, '.jiraffe')).rejects.toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('keep\n');
  });
});

describe('attachmentsIgnoreTarget: подсказка только для относительной папки внутри workspace', () => {
  const ws = path.resolve('/w/proj');
  const tmpDir = path.resolve('/tmp');
  const t = (setting: string | undefined, over: Partial<{ fromWorkspace: boolean; workspaceDir: string | undefined }> = {}) =>
    attachmentsIgnoreTarget({ setting, fromWorkspace: false, workspaceDir: ws, tmpDir, ...over });
  it('умолчание и относительные', () => {
    expect(t(undefined)).toBe('.jiraffe');
    expect(t('.jiraffe')).toBe('.jiraffe');
    expect(t('./docs/att/')).toBe('docs/att');
  });
  it('абсолютный (из пользовательских настроек), без workspace и выход наружу — подсказки нет', () => {
    expect(t(path.resolve('/home/u/att'))).toBeUndefined();
    expect(t('.jiraffe', { workspaceDir: undefined })).toBeUndefined();
  });
  it('абсолютный из workspace-настроек игнорируется сохранением (падает на .jiraffe) — подсказка про .jiraffe', () => {
    expect(t(path.resolve('/etc/x'), { fromWorkspace: true })).toBe('.jiraffe');
  });
  it('сам workspace (`.` ) → умолчание не подменяем, но rel пуст → undefined', () => {
    expect(t('.')).toBe('.jiraffe');
  });
});
