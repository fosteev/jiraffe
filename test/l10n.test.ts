import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatDuration } from '../src/duration';
import { setL10n, t, tn } from '../src/l10n';

const root = join(__dirname, '..');
const readJson = (p: string): Record<string, string> => JSON.parse(readFileSync(join(root, p), 'utf8')) as Record<string, string>;
const ru = readJson('l10n/bundle.l10n.ru.json');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const unescape = (s: string, q: string): string =>
  s.replace(/\\(.)/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === q || c === '\\' || c === "'" || c === '"' || c === '`' ? c : `\\${c}`));

const STR = String.raw`'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|\x60((?:[^\x60\\$]|\\.|\$(?!\{))*)\x60`;
const T_RE = new RegExp(String.raw`(?<![\w.$])t\(\s*(?:${STR})`, 'g');
// tn(выражение, 'формы') — выражение без запятых верхнего уровня внутри скобок не поддерживаем: берём до первой запятой, допуская вложенные скобки на один уровень.
const TN_RE = new RegExp(String.raw`(?<![\w.$])tn\(\s*(?:[^,()]|\([^()]*\))+,\s*(?:${STR})`, 'g');

function scan(): { t: Map<string, string>; tn: Map<string, string> } {
  const out = { t: new Map<string, string>(), tn: new Map<string, string>() };
  for (const f of [...walk(join(root, 'src')), ...walk(join(root, 'webview'))]) {
    if (f.endsWith(join('src', 'l10n.ts'))) continue;
    const text = readFileSync(f, 'utf8');
    for (const [kind, re] of [['t', T_RE], ['tn', TN_RE]] as const) {
      for (const m of text.matchAll(re)) {
        const [, a, b, c] = m;
        const raw = a ?? b ?? c ?? '';
        const q = a !== undefined ? "'" : b !== undefined ? '"' : '`';
        out[kind].set(unescape(raw, q), f);
      }
    }
  }
  return out;
}

const ph = (s: string): string => [...new Set([...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]!))].sort().join(',');

describe('бандл l10n', () => {
  const found = scan();
  const keys = new Map([...found.t, ...found.tn]);

  it('находит литералы в коде', () => {
    expect(keys.size).toBeGreaterThan(50);
  });

  it('каждый ключ из кода есть в русском бандле', () => {
    expect([...keys.keys()].filter((k) => !(k in ru))).toEqual([]);
  });

  it('в бандле нет ключей, которых нет в коде', () => {
    expect(Object.keys(ru).filter((k) => !keys.has(k))).toEqual([]);
  });

  it('плейсхолдеры ключа и перевода совпадают', () => {
    const bad = Object.entries(ru).filter(([k, v]) => ph(k) !== ph(v)).map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it('у tn-ключей 2 формы, у перевода 3', () => {
    const bad: string[] = [];
    for (const k of found.tn.keys()) {
      if (k.split('|').length !== 2 || (ru[k] ?? '').split('|').length !== 3) bad.push(k);
    }
    expect(bad).toEqual([]);
  });

  it('package.nls.json и package.nls.ru.json — одинаковые ключи, все %key% из package.json есть', () => {
    const en = readJson('package.nls.json');
    const nlsRu = readJson('package.nls.ru.json');
    expect(Object.keys(nlsRu).sort()).toEqual(Object.keys(en).sort());
    const pkg = readFileSync(join(root, 'package.json'), 'utf8');
    const used = [...pkg.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]!);
    expect(used.filter((k) => !(k in en))).toEqual([]);
    expect(Object.keys(en).filter((k) => !used.includes(k))).toEqual([]);
  });

  describe('с русским бандлом', () => {
    afterAll(() => setL10n(undefined, 'en'));

    it('formatDuration и плюралы', () => {
      setL10n(ru, 'ru');
      expect(formatDuration(5400)).toBe('1ч 30м');
      const k = [...found.tn.keys()][0]!;
      const forms = ru[k]!.split('|');
      expect(tn(5, k)).toBe(forms[2]!.replace('{0}', '5'));
      expect(tn(2, k)).toBe(forms[1]!.replace('{0}', '2'));
      expect(tn(1, k)).toBe(forms[0]!.replace('{0}', '1'));
    });

    it('без бандла — английский ключ с подстановкой', () => {
      setL10n(undefined, 'en');
      expect(t('{0}h {1}m', 1, 30)).toBe('1h 30m');
      expect(tn(1, '{0} issue|{0} issues')).toBe('1 issue');
      expect(tn(2, '{0} issue|{0} issues')).toBe('2 issues');
    });
  });
});
