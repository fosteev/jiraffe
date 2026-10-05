// Локализация без vscode: один механизм для хоста и webview. Ключ бандла — английский текст.
// t()/tn() вызывать только внутри функций: модуль импортируется раньше setL10n и получил бы английский.
let current: Record<string, string> | undefined;
let currentLocale = 'en';
let rules: Intl.PluralRules | undefined;

export function setL10n(bundle: Record<string, string> | undefined, locale: string): void {
  current = bundle;
  currentLocale = locale || 'en';
  try {
    rules = new Intl.PluralRules(currentLocale);
  } catch {
    rules = new Intl.PluralRules('en');
    currentLocale = 'en';
  }
}

export const locale = (): string => currentLocale;
export const getBundle = (): Record<string, string> | undefined => current;

const fill = (s: string, args: readonly (string | number)[]): string =>
  s.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));

export function t(message: string, ...args: (string | number)[]): string {
  return fill(current?.[message] ?? message, args);
}

/** Плюрал: forms — английский ключ `'{0} issue|{0} issues'`; перевод из бандла — формы через `|` (ru: one|few|many). `{0}` — n. */
export function tn(n: number, forms: string, ...args: (string | number)[]): string {
  const parts = (current?.[forms] ?? forms).split('|');
  const cat = (rules ??= new Intl.PluralRules(currentLocale)).select(n);
  let i: number;
  if (parts.length >= 3) i = cat === 'one' ? 0 : cat === 'few' ? 1 : 2;
  else i = cat === 'one' ? 0 : 1;
  return fill(parts[Math.min(i, parts.length - 1)]!, [n, ...args]);
}
