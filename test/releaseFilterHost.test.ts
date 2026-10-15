import { afterAll, describe, expect, it } from 'vitest';
import { setL10n } from '../src/l10n';
import type { ListRow, ReleasePage } from '../src/panels/protocol';
import { copiedMessage, defaultFilterName, releaseFilterRequest, savedMessage } from '../src/panels/releaseFilterHost';
import { emptyFilter } from '../webview/releaseFilter';

const cloud = { kind: 'cloud' as const, caps: { tempo: false, epicLinkField: null, checkedAt: '' } };
const dcNoEpic = { kind: 'dc' as const, caps: { tempo: false, epicLinkField: null, checkedAt: '' } };
const row = (key: string, o: Partial<ListRow> = {}): ListRow => ({ key, summary: `S ${key}`, type: 'Task', status: 'Open', statusCategory: 'new', ...o });
const page = (rows: ListRow[], meId?: string): ReleasePage => ({
  type: 'release', instanceId: 'i', instanceName: 'I', project: 'ABC', id: '5', name: '2.14.0', released: false,
  kind: 'cloud', progress: { done: 0, inProgress: 0, todo: rows.length, total: rows.length }, rows, truncated: false, ...(meId ? { meId } : {}),
} as unknown as ReleasePage);
const F = (o: Record<string, unknown>): unknown => ({ ...emptyFilter(), ...o });

afterAll(() => setL10n(undefined, 'en'));

describe('releaseFilterRequest', () => {
  it('не объект вместо фильтра и неверный id релиза — игнор', () => {
    expect(releaseFilterRequest(cloud, '5', undefined, undefined)).toBeUndefined();
    expect(releaseFilterRequest(cloud, '5', 'x', undefined)).toBeUndefined();
    expect(releaseFilterRequest(cloud, '5', [], undefined)).toBeUndefined();
    expect(releaseFilterRequest(cloud, '1 OR 2', emptyFilter(), undefined)).toBeUndefined();
  });
  it('мусорный фильтр приводится к пустому: JQL только по релизу', () => {
    expect(releaseFilterRequest(cloud, '5', { q: 5, cats: 'x', assignee: [1, {}] }, undefined)).toEqual({
      filter: emptyFilter(), jql: 'fixVersion = 5 ORDER BY status, priority', notes: [],
    });
  });
  it('поиск по ключу идёт как key = только для задачи со страницы вкладки', () => {
    const p = page([row('ABC-1')]);
    expect(releaseFilterRequest(cloud, '5', F({ q: 'abc-1' }), p)?.jql).toContain('(key = ABC-1 OR summary ~');
    expect(releaseFilterRequest(cloud, '5', F({ q: 'abc-2' }), p)?.jql).not.toContain('key =');
    expect(releaseFilterRequest(cloud, '5', F({ q: 'abc-1' }), undefined)?.jql).not.toContain('key =');
  });
  it('эпик не учтён: DC без Epic Link', () => {
    const r = releaseFilterRequest(dcNoEpic, '5', F({ epic: ['ABC-9'] }), page([]));
    expect(r?.notes).toEqual(['The epic condition was left out: Epic Link field is unknown on this instance.']);
    expect(r?.jql).not.toContain('ABC-9');
  });
  it('эпик не учтён: поле есть, но ни один ключ не по формату — другая причина', () => {
    const dc = { kind: 'dc' as const, epicLinkField: 'customfield_10008', caps: { tempo: false, epicLinkField: null, checkedAt: '' } };
    const r = releaseFilterRequest(dc, '5', F({ epic: ['not a key'] }), page([]));
    expect(r?.notes).toEqual(['The epic condition was left out: none of the selected epic keys is valid.']);
    expect(releaseFilterRequest(dc, '5', F({ epic: ['ABC-9'] }), page([]))?.jql).toContain('cf[10008] in (ABC-9)');
  });
  it('Cloud, «Без эпика» и подзадача без эпика среди отфильтрованных — пометка; без подзадачи или на другом фильтре — нет', () => {
    const rows = [row('ABC-1'), row('ABC-2', { type: 'Sub-task', assignee: { id: 'anna', name: 'Anna' } }), row('ABC-3', { type: 'Sub-task', epicKey: 'ABC-90' })];
    const note = 'Sub-tasks without an epic are not included in the JQL.';
    expect(releaseFilterRequest(cloud, '5', F({ epic: [''] }), page(rows))?.notes).toEqual([note]);
    expect(releaseFilterRequest(cloud, '5', F({ epic: [''], assignee: ['ivan'] }), page(rows))?.notes).toEqual([]);
    expect(releaseFilterRequest(cloud, '5', F({ epic: ['ABC-90'] }), page(rows))?.notes).toEqual([]);
    expect(releaseFilterRequest(cloud, '5', F({ epic: [''] }), page([row('ABC-1')]))?.notes).toEqual([]);
    expect(releaseFilterRequest(dcNoEpic, '5', F({ epic: [''] }), page(rows))?.notes).not.toContain(note);
  });
  it('«Только мои» учитывает meId страницы при подсчёте подзадач', () => {
    const rows = [row('ABC-2', { type: 'Sub-task', assignee: { id: 'anna', name: 'Anna' } })];
    expect(releaseFilterRequest(cloud, '5', F({ epic: [''], mine: true }), page(rows, 'ivan'))?.notes).toEqual([]);
    expect(releaseFilterRequest(cloud, '5', F({ epic: [''], mine: true }), page(rows, 'anna'))?.notes).toHaveLength(1);
  });
});

describe('тексты хоста', () => {
  it('имя по умолчанию и уведомления', () => {
    expect(defaultFilterName('ABC', '2.14.0')).toBe('ABC: 2.14.0 (filtered)');
    expect(defaultFilterName('', '2.14.0')).toBe('2.14.0 (filtered)');
    expect(copiedMessage('fixVersion = 5', [])).toBe('JQL copied: fixVersion = 5');
    expect(copiedMessage('x', ['a.', 'b.'])).toBe('JQL copied: x a. b.');
    expect(savedMessage('F', ['a.'])).toBe('Saved filter F. a.');
  });
  it('русский перевод', () => {
    setL10n({ '{0} (filtered)': '{0} (с фильтрами)', 'Saved filter {0}.': 'Фильтр «{0}» сохранён.' }, 'ru');
    expect(defaultFilterName('ABC', '2.14.0')).toBe('ABC: 2.14.0 (с фильтрами)');
    expect(savedMessage('F', [])).toBe('Фильтр «F» сохранён.');
  });
});
