// Модель вкладки «Настройки Jiraffe»: чистая сборка состояния из простых входов. Без vscode — тестируется напрямую.
// Хост собирает входы через `getConfiguration('jiraffe').inspect(key)`; webview только рисует `SettingsState`.
import { SORT_FIELDS, type IssueSort, type SortField } from '../jql';
import { t } from '../l10n';

export type SectionId = 'conn' | 'list' | 'att' | 'time' | 'int';
export const SECTION_IDS: readonly SectionId[] = ['conn', 'list', 'att', 'time', 'int'];
export const isSectionId = (v: unknown): v is SectionId => typeof v === 'string' && (SECTION_IDS as readonly string[]).includes(v);

/** Где лежит значение: метка рядом со строкой. `state` — globalState расширения, `auto` — определяется само. */
export type Level = 'workspaceFolder' | 'workspace' | 'user' | 'state' | 'auto';
/** Куда писать скаляр в settings.json. */
export type WriteTarget = 'workspaceFolder' | 'workspace' | 'global';

/** Идентификаторы настроек, которые вкладка умеет менять. Совпадают с ключами `jiraffe.*`, кроме сортировки и группировки (globalState). */
export type SettingId = 'maxResults' | 'attachmentsDir' | 'maxImageMb' | 'workdayHours' | 'sort' | 'grouped';
export const SETTING_IDS: readonly SettingId[] = ['maxResults', 'attachmentsDir', 'maxImageMb', 'workdayHours', 'sort', 'grouped'];
export const isSettingId = (v: unknown): v is SettingId => typeof v === 'string' && (SETTING_IDS as readonly string[]).includes(v);

/** Диапазоны — как в `package.json` (contributes.configuration). */
export const RANGES = {
  maxResults: { min: 1, max: 100, integer: true, def: 50 },
  maxImageMb: { min: 1, max: 50, integer: false, def: 5 },
  workdayHours: { min: 1, max: 24, integer: false, def: 8 },
} as const;
export type NumberId = keyof typeof RANGES;
export const DEFAULT_ATTACHMENTS_DIR = '.jiraffe';
export const MAX_DIR_LENGTH = 512;

/** То, что отдаёт `WorkspaceConfiguration.inspect()` (нужные поля). */
export interface Inspected<T> { defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T }

export interface Scalar<T> { value: T; level: Level; target: WriteTarget; modified: boolean }

/**
 * Значение скаляра и уровень, откуда оно берётся: workspaceFolder › workspace › global › default.
 * `target` — куда писать правку (туда же; по умолчанию Global). `modified` — значение отличается от стандартного.
 */
export function resolveScalar<T extends string | number>(ins: Inspected<T> | undefined, fallback: T): Scalar<T> {
  // settings.json схему не навязывает: «чужой» тип на уровне (`"jiraffe.attachmentsDir": 123`) не показываем как значение,
  // но уровень и цель записи оставляем — правка или «Сбросить» перезапишет мусор там, где он лежит.
  const ok = (v: unknown): v is T => typeof v === typeof fallback && (typeof v !== 'number' || Number.isFinite(v));
  const d = ins?.defaultValue;
  const def = ok(d) ? d : fallback;
  const at = (v: T | undefined, level: Level, target: WriteTarget): Scalar<T> | undefined =>
    v === undefined ? undefined : ok(v) ? { value: v, level, target, modified: v !== def } : { value: def, level, target, modified: true };
  return at(ins?.workspaceFolderValue, 'workspaceFolder', 'workspaceFolder')
    ?? at(ins?.workspaceValue, 'workspace', 'workspace')
    ?? at(ins?.globalValue, 'user', 'global')
    ?? { value: def, level: 'user', target: 'global', modified: false };
}

export interface NumberControl { kind: 'number'; value: number; min: number; max: number; step: number; unit: string }
export interface TextControl { kind: 'text'; value: string; placeholder: string; pick: boolean }
export interface SwitchControl { kind: 'switch'; value: boolean }
export interface SortControl {
  kind: 'sort';
  /** `''` — по умолчанию. */
  field: SortField | '';
  desc: boolean;
  fields: { value: SortField | ''; label: string }[];
}
export type Control = NumberControl | TextControl | SwitchControl | SortControl;

export interface SettingRow {
  id: SettingId;
  section: SectionId;
  /** Категория перед названием: «Список: Задач за один запрос». */
  cat: string;
  title: string;
  desc: string;
  /** Ключ в settings.json (`jiraffe.maxResults`) — для строк, которые там лежат. */
  key?: string;
  level: Level;
  modified: boolean;
  /** Подпись ссылки «Сбросить к …». */
  resetTo: string;
  control: Control;
}

export interface SectionInfo { id: SectionId; title: string; sub: string; /** Раздел-заглушка: строк нет, вместо них «скоро». */ soon: boolean }

export interface SettingsState {
  sections: SectionInfo[];
  rows: SettingRow[];
  /** Открыта ли папка: без неё нельзя «Выбрать…» и относительный путь вложений уходит во временный каталог. */
  hasWorkspace: boolean;
}

export interface SettingsInput {
  maxResults: Inspected<number> | undefined;
  attachmentsDir: Inspected<string> | undefined;
  maxImageMb: Inspected<number> | undefined;
  workdayHours: Inspected<number> | undefined;
  sort: IssueSort | undefined;
  grouped: boolean;
  hasWorkspace: boolean;
}

export const sortFieldLabel = (f: SortField): string =>
  f === 'key' ? t('Key') : f === 'priority' ? t('Priority') : f === 'created' ? t('Created') : t('Updated');

const sections = (): SectionInfo[] => [
  { id: 'conn', title: t('Connections'), sub: '', soon: true },
  { id: 'list', title: t('Issue list'), sub: '', soon: false },
  { id: 'att', title: t('Attachments'), sub: '', soon: false },
  { id: 'time', title: t('Time tracking'), sub: '', soon: false },
  { id: 'int', title: t('Integrations'), sub: '', soon: true },
];

const num = (v: Scalar<number>, id: NumberId, step: number, unit: string): NumberControl => ({ kind: 'number', value: v.value, min: RANGES[id].min, max: RANGES[id].max, step, unit });

/** Собирает состояние вкладки. t() зовётся здесь, при каждой сборке, — язык уже выставлен. */
export function buildSettingsState(i: SettingsInput): SettingsState {
  const mr = resolveScalar(i.maxResults, RANGES.maxResults.def);
  const dir = resolveScalar(i.attachmentsDir, DEFAULT_ATTACHMENTS_DIR);
  const mb = resolveScalar(i.maxImageMb, RANGES.maxImageMb.def);
  const wd = resolveScalar(i.workdayHours, RANGES.workdayHours.def);
  const rows: SettingRow[] = [
    {
      id: 'maxResults', section: 'list', cat: t('List'), title: t('Issues per request'), key: 'jiraffe.maxResults',
      desc: t('How many issues to load at once and per "Load More". More means a longer first response from Jira.'),
      level: mr.level, modified: mr.modified, resetTo: String(i.maxResults?.defaultValue ?? RANGES.maxResults.def),
      control: num(mr, 'maxResults', 1, t('from {0} to {1}', RANGES.maxResults.min, RANGES.maxResults.max)),
    },
    {
      id: 'sort', section: 'list', cat: t('List'), title: t('Sorting'),
      desc: t('Order of issues in the tree. Same as the sort button in the Issues header: changing it here changes it there.'),
      level: 'state', modified: !!i.sort, resetTo: t('Default'),
      control: {
        kind: 'sort', field: i.sort?.field ?? '', desc: i.sort?.desc ?? true,
        fields: [{ value: '', label: t('Default') }, ...SORT_FIELDS.map((f) => ({ value: f, label: sortFieldLabel(f) }))],
      },
    },
    {
      id: 'grouped', section: 'list', cat: t('List'), title: t('Group by project'),
      desc: t('Within an instance, issues are grouped by project. Off means a flat list.'),
      level: 'state', modified: i.grouped, resetTo: t('off'), control: { kind: 'switch', value: i.grouped },
    },
    {
      id: 'attachmentsDir', section: 'att', cat: t('Attachments'), title: t('Attachments folder'), key: 'jiraffe.attachmentsDir',
      desc: t('A path relative to the first workspace folder; an issue\'s files go to a subfolder named after its key. An absolute path is accepted only in user settings. With no folder open, a temporary directory is used and cleaned after a week.'),
      level: dir.level, modified: dir.modified, resetTo: typeof i.attachmentsDir?.defaultValue === 'string' ? i.attachmentsDir.defaultValue : DEFAULT_ATTACHMENTS_DIR,
      control: { kind: 'text', value: dir.value, placeholder: DEFAULT_ATTACHMENTS_DIR, pick: i.hasWorkspace },
    },
    {
      id: 'maxImageMb', section: 'att', cat: t('Attachments'), title: t('Image size limit'), key: 'jiraffe.maxImageMb',
      desc: t('Larger images get no preview in the card or the description, only the Download button. Saves traffic on heavy screenshots.'),
      level: mb.level, modified: mb.modified, resetTo: String(i.maxImageMb?.defaultValue ?? RANGES.maxImageMb.def),
      control: num(mb, 'maxImageMb', 1, t('MB')),
    },
    {
      id: 'workdayHours', section: 'time', cat: t('Time'), title: t('Workday length'), key: 'jiraffe.workdayHours',
      desc: t('The daily norm in the Tempo summary and the status bar.'),
      level: wd.level, modified: wd.modified, resetTo: String(i.workdayHours?.defaultValue ?? RANGES.workdayHours.def),
      control: num(wd, 'workdayHours', 0.5, t('hours')),
    },
  ];
  return { sections: sections(), rows, hasWorkspace: i.hasWorkspace };
}

// ----- валидация значений из webview (недоверенных) -----

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseNumber(id: NumberId, v: unknown): Parsed<number> {
  const r = RANGES[id];
  if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: t('Enter a number.') };
  if (r.integer && !Number.isInteger(v)) return { ok: false, error: t('Enter a whole number.') };
  if (v < r.min || v > r.max) return { ok: false, error: t('The value must be from {0} to {1}.', r.min, r.max) };
  return { ok: true, value: v };
}

/** Пустая строка = вернуть стандартное (`undefined` → сброс). Абсолютный путь допустим только при записи в Global — это проверяет хост. */
export function parseDir(v: unknown): Parsed<string | undefined> {
  if (typeof v !== 'string') return { ok: false, error: t('Enter a path.') };
  const s = v.trim();
  if (s.length > MAX_DIR_LENGTH || s.includes('\0')) return { ok: false, error: t('The path is too long or contains invalid characters.') };
  // `..` в любом месте: относительный путь наружу из workspace рантайм всё равно откатит на `.jiraffe` (и предупредит один раз),
  // а вкладка показывала бы его как действующий.
  if (s.split(/[\\/]/).includes('..')) return { ok: false, error: t('The path must not contain "..".') };
  return { ok: true, value: s || undefined };
}

/** Сортировка из webview: `{ field: '' | SortField, desc }`; пустое поле = по умолчанию. */
export function parseSort(v: unknown): Parsed<IssueSort | undefined> {
  const o = v as { field?: unknown; desc?: unknown } | null;
  if (!o || typeof o !== 'object' || typeof o.desc !== 'boolean') return { ok: false, error: t('Unknown sort order.') };
  if (o.field === '') return { ok: true, value: undefined };
  if (typeof o.field === 'string' && (SORT_FIELDS as readonly string[]).includes(o.field)) return { ok: true, value: { field: o.field as SortField, desc: o.desc } };
  return { ok: false, error: t('Unknown sort order.') };
}

export function parseSwitch(v: unknown): Parsed<boolean> {
  return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, error: t('Unknown value.') };
}

/** Одна проверка на любой id: что именно писать. `undefined` у dir/sort — сбросить/по умолчанию. */
export type SettingValue =
  | { id: NumberId; value: number }
  | { id: 'attachmentsDir'; value: string | undefined }
  | { id: 'sort'; value: IssueSort | undefined }
  | { id: 'grouped'; value: boolean };

export function parseSetting(id: unknown, v: unknown): Parsed<SettingValue> {
  if (!isSettingId(id)) return { ok: false, error: t('Unknown setting.') };
  const wrap = <T>(r: Parsed<T>, f: (x: T) => SettingValue): Parsed<SettingValue> => (r.ok ? { ok: true, value: f(r.value) } : r);
  switch (id) {
    case 'maxResults':
    case 'maxImageMb':
    case 'workdayHours': return wrap(parseNumber(id, v), (value) => ({ id, value }));
    case 'attachmentsDir': return wrap(parseDir(v), (value) => ({ id, value }));
    case 'sort': return wrap(parseSort(v), (value) => ({ id, value }));
    case 'grouped': return wrap(parseSwitch(v), (value) => ({ id, value }));
  }
}
