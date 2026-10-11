// Модель вкладки «Настройки Jiraffe»: чистая сборка состояния из простых входов. Без vscode — тестируется напрямую.
// Хост собирает входы через `getConfiguration('jiraffe').inspect(key)`; webview только рисует `SettingsState`.
import type { WriteKind } from '../api';
import { apiFlag, type InspectedFlag } from '../apiAccess';
import { SORT_FIELDS, type IssueSort, type SortField } from '../jql';
import type { Instance } from '../jira/types';
import { t } from '../l10n';
import type { ApiWrite } from '../state/apiActivity';

export type SectionId = 'conn' | 'list' | 'att' | 'time' | 'int';
export const SECTION_IDS: readonly SectionId[] = ['conn', 'list', 'att', 'time', 'int'];
export const isSectionId = (v: unknown): v is SectionId => typeof v === 'string' && (SECTION_IDS as readonly string[]).includes(v);

/** Где лежит значение: метка рядом со строкой. `state` — globalState расширения, `auto` — определяется само. */
export type Level = 'workspaceFolder' | 'workspace' | 'user' | 'state' | 'auto';
/** Куда писать скаляр в settings.json. */
export type WriteTarget = 'workspaceFolder' | 'workspace' | 'global';

/**
 * Идентификаторы настроек, которые вкладка умеет менять. Совпадают с ключами `jiraffe.*`, кроме сортировки и группировки (globalState)
 * и двух переключателей API (`jiraffe.api.enabled`, `jiraffe.api.allowWrites`: уровень application, пишутся только в Global).
 */
export type SettingId = 'maxResults' | 'attachmentsDir' | 'maxImageMb' | 'workdayHours' | 'sort' | 'grouped' | 'apiEnabled' | 'apiAllowWrites';
export const SETTING_IDS: readonly SettingId[] = ['maxResults', 'attachmentsDir', 'maxImageMb', 'workdayHours', 'sort', 'grouped', 'apiEnabled', 'apiAllowWrites'];
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

export interface SectionInfo {
  id: SectionId;
  title: string;
  sub: string;
  /** Раздел-заглушка: строк нет, вместо них «скоро». */
  soon: boolean;
  /** Счётчик проблем у пункта меню (подключения с ошибкой). */
  badge?: number;
}

// ----- «Подключения» -----

export type ConnState = 'checking' | 'ok' | 'error';
/** Результат последней проверки `myself()`; в памяти хоста, не персистится. `undefined` — ещё не проверяли. */
export type ConnStatusInput = { state: 'checking' } | { state: 'ok'; account: string } | { state: 'error'; message: string };
export type Journal = 'tempo' | 'jira' | 'unknown';
export type EpicLink = { kind: 'field'; id: string } | { kind: 'parent' } | { kind: 'none' } | { kind: 'unknown' };

export interface InstanceCard {
  id: string;
  name: string;
  baseUrl: string;
  host: string;
  kind: 'dc' | 'cloud';
  /** Что за токен: подпись «Personal Access Token» / «API token + email». Сам токен сюда не попадает никогда. */
  tokenKind: string;
  state: ConnState;
  account?: string;
  error?: string;
  serverVersion?: string;
  /** ISO-время последней проверки возможностей (только если разобралось как дата). */
  checkedAt?: string;
  journal: Journal;
  epic: EpicLink;
  /** Входит ли в набор workspace (при «все» — всегда да). */
  inScope: boolean;
  /** Новый токен не прошёл проверку и не сохранён (старый остаётся). Не то же, что `error`: старый токен может работать. */
  tokenError?: string;
}

export interface ConnectionsState {
  /** `all` — `jiraffe.instances` не задан; `some` — набор задан. */
  mode: 'all' | 'some';
  /** Есть ли открытая папка/workspace: набор лежит в его settings.json, без него радио неактивно. */
  canScope: boolean;
  cards: InstanceCard[];
}

/** Таблица «Куда пишется время»: по строке на инстанс набора workspace. */
export interface TimeTarget { id: string; name: string; journal: Journal; label: string; note: string }
export interface TimeTargets { title: string; desc: string; rows: TimeTarget[] }

// ----- «Интеграции» -----

/** Статус Agentura: только «найдена / не установлена» (решение 12). */
export interface AgenturaInfo { title: string; desc: string; found: boolean }
/** Последняя запись через публичный API (память хоста). `at` — ISO-время; форматирует webview. */
export interface LastApiWrite { kind: WriteKind; label: string; key: string; at: string }
/** Сами переключатели API — обычные строки `rows` раздела `int`; здесь то, что настройкой не является. */
export interface IntegrationsState { agentura: AgenturaInfo; lastWrite?: LastApiWrite }

export interface SettingsState {
  sections: SectionInfo[];
  rows: SettingRow[];
  connections: ConnectionsState;
  timeTargets: TimeTargets;
  integrations: IntegrationsState;
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
  /** Есть ли открытая папка (для набора workspace; в отличие от `hasWorkspace` — любая схема, не только file). */
  canScope: boolean;
  /** Все подключённые инстансы с последним известным статусом и принадлежностью набору. */
  instances: { inst: Instance; status: ConnStatusInput | undefined; inScope: boolean; tokenError?: string }[];
  /** Задан ли набор `jiraffe.instances`. */
  scopeSet: boolean;
  /** `inspect()` настроек `jiraffe.api.enabled` / `jiraffe.api.allowWrites`: учитываются только пользовательские и стандартные значения. */
  apiEnabled: InspectedFlag | undefined;
  apiAllowWrites: InspectedFlag | undefined;
  /** Установлено ли расширение Agentura. */
  agentura: boolean;
  /** Последняя запись через публичный API с запуска окна. */
  lastApiWrite: ApiWrite | undefined;
}

export const sortFieldLabel = (f: SortField): string =>
  f === 'key' ? t('Key') : f === 'priority' ? t('Priority') : f === 'created' ? t('Created') : t('Updated');

const sections = (errors: number): SectionInfo[] => [
  { id: 'conn', title: t('Connections'), sub: t('Connections and tokens are shared by all VS Code windows. Here you also choose which of them are visible in this folder.'), soon: false, ...(errors ? { badge: errors } : {}) },
  { id: 'list', title: t('Issue list'), sub: '', soon: false },
  { id: 'att', title: t('Attachments'), sub: '', soon: false },
  { id: 'time', title: t('Time tracking'), sub: '', soon: false },
  { id: 'int', title: t('Integrations'), sub: '', soon: false },
];

const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * Карточка инстанса. Всё из `InstanceStore` (globalState) считается недоверенным: имя, версия, время и caps проверяются по типу,
 * лишнее отбрасывается. Токена здесь нет — только подпись его вида.
 */
export function buildInstanceCard(inst: Instance, status: ConnStatusInput | undefined, inScope: boolean, tokenError?: string): InstanceCard {
  const id = String(inst.id);
  const baseUrl = String(inst.baseUrl);
  let host = baseUrl;
  try { host = new URL(baseUrl).host; } catch { /* оставляем как есть */ }
  const kind = inst.kind === 'cloud' ? 'cloud' : 'dc';
  const caps = inst.caps && typeof inst.caps === 'object' ? inst.caps : undefined;
  const checked = str(caps?.checkedAt, 40);
  const epic: EpicLink = !caps ? { kind: 'unknown' }
    : kind === 'cloud' ? { kind: 'parent' }
    : typeof caps.epicLinkField === 'string' && caps.epicLinkField ? { kind: 'field', id: caps.epicLinkField.slice(0, 80) }
    : { kind: 'none' };
  return {
    id, name: str(inst.name) ?? id, baseUrl, host, kind,
    tokenKind: kind === 'cloud' ? t('API token + email') : 'Personal Access Token',
    state: status?.state ?? 'checking',
    ...(status?.state === 'ok' ? { account: status.account } : {}),
    ...(status?.state === 'error' ? { error: status.message } : {}),
    ...(str(caps?.serverVersion, 40) ? { serverVersion: str(caps?.serverVersion, 40) } : {}),
    ...(checked && Number.isFinite(Date.parse(checked)) ? { checkedAt: checked } : {}),
    journal: !caps ? 'unknown' : caps.tempo === true ? 'tempo' : 'jira',
    epic, inScope,
    ...(tokenError ? { tokenError } : {}),
  };
}

const writeKindLabel = (k: WriteKind): string =>
  k === 'comment' ? t('comment') : k === 'transition' ? t('status change') : t('work log');

const timeTarget = (c: InstanceCard): TimeTarget => ({
  id: c.id, name: c.name, journal: c.journal,
  label: c.journal === 'tempo' ? 'Tempo' : c.journal === 'jira' ? t('Jira work log') : t('Not checked yet'),
  note: c.journal === 'tempo' ? t('work type and AI Tokens') : c.journal === 'jira' ? t('AI Tokens go to the comment') : '',
});

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
  // Доступ API: уровень всегда «пользователь» (настройки application, workspace их не задаёт); второй переключатель скрыт при выключенном первом.
  const apiOn = apiFlag(i.apiEnabled);
  const apiWrite = apiFlag(i.apiAllowWrites);
  rows.push({
    id: 'apiEnabled', section: 'int', cat: 'API', title: t('Access for other extensions'), key: 'jiraffe.api.enabled',
    desc: t('Jiraffe\'s public API: other extensions (for example, Agentura) see the instances of this workspace, read issues and open the card. Tokens and email are never passed out. Set in user settings only: a project\'s .vscode/settings.json cannot change it.'),
    level: 'user', modified: apiOn.modified, resetTo: apiOn.def ? t('on') : t('off'), control: { kind: 'switch', value: apiOn.value },
  });
  if (apiOn.value) {
    rows.push({
      id: 'apiAllowWrites', section: 'int', cat: 'API', title: t('Allow writing on your behalf'), key: 'jiraffe.api.allowWrites',
      desc: t('API v2: comment, status change, work log. Every action is performed as your Jira account. Off means extensions can only read. Set in user settings only.'),
      level: 'user', modified: apiWrite.modified, resetTo: apiWrite.def ? t('on') : t('off'), control: { kind: 'switch', value: apiWrite.value },
    });
  }
  const cards = i.instances.map((x) => buildInstanceCard(x.inst, x.status, x.inScope, x.tokenError));
  // Время записи — из часов хоста, но `toISOString()` на невалидной дате бросает: лучше без строки, чем пустая вкладка.
  const lastDate = i.lastApiWrite ? new Date(i.lastApiWrite.at) : undefined;
  const lastAt = lastDate && !Number.isNaN(lastDate.getTime()) ? lastDate.toISOString() : undefined;
  return {
    sections: sections(cards.filter((c) => c.state === 'error').length), rows, hasWorkspace: i.hasWorkspace,
    connections: { mode: i.scopeSet ? 'some' : 'all', canScope: i.canScope, cards },
    timeTargets: {
      title: t('Where time is logged'),
      desc: t('Chosen per instance: with Tempo, the entry goes to Tempo (with a work type and AI Tokens); without it, to the issue\'s standard Jira work log.'),
      rows: cards.filter((c) => c.inScope).map(timeTarget),
    },
    integrations: {
      agentura: {
        title: t('AI chat on an issue'),
        desc: t('The "Open in Agentura" button in the issue card: a chat about the issue. It appears on its own when the Agentura extension is installed.'),
        found: i.agentura,
      },
      ...(lastAt && i.lastApiWrite
        ? { lastWrite: { kind: i.lastApiWrite.kind, label: writeKindLabel(i.lastApiWrite.kind), key: i.lastApiWrite.key, at: lastAt } }
        : {}),
    },
  };
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
  | { id: 'grouped' | 'apiEnabled' | 'apiAllowWrites'; value: boolean };

export function parseSetting(id: unknown, v: unknown): Parsed<SettingValue> {
  if (!isSettingId(id)) return { ok: false, error: t('Unknown setting.') };
  const wrap = <T>(r: Parsed<T>, f: (x: T) => SettingValue): Parsed<SettingValue> => (r.ok ? { ok: true, value: f(r.value) } : r);
  switch (id) {
    case 'maxResults':
    case 'maxImageMb':
    case 'workdayHours': return wrap(parseNumber(id, v), (value) => ({ id, value }));
    case 'attachmentsDir': return wrap(parseDir(v), (value) => ({ id, value }));
    case 'sort': return wrap(parseSort(v), (value) => ({ id, value }));
    case 'grouped':
    case 'apiEnabled':
    case 'apiAllowWrites': return wrap(parseSwitch(v), (value) => ({ id, value }));
  }
}
