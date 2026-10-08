import { describe, expect, it } from 'vitest';
import { buildJql, isIssueKey, isIssueSort, luceneEscape, orderBy, quoteJql, splitOrderBy } from '../src/jql';

describe('buildJql', () => {
  it('на мне', () => {
    expect(buildJql({ mode: 'mine' })).toBe('assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC');
  });

  it('проект', () => {
    expect(buildJql({ mode: 'project', projectKey: 'ABC' })).toBe('project = ABC ORDER BY updated DESC');
    expect(buildJql({ mode: 'project', projectKey: 'my proj' })).toBe('project = "my proj" ORDER BY updated DESC');
  });

  it('быстрые фильтры: категории по id, типы и приоритеты в кавычках', () => {
    expect(
      buildJql({ mode: 'project', projectKey: 'ABC', quick: { statusCategory: ['indeterminate', 'new'], types: ['Bug', 'Баг'], priorities: ['High'] } }),
    ).toBe('project = ABC AND statusCategory in (1, 2, 4) AND issuetype in ("Bug", "Баг") AND priority in ("High") ORDER BY updated DESC');
  });

  it('«Готово» в режиме «на мне» снимает resolution = Unresolved', () => {
    const j = buildJql({ mode: 'mine', quick: { statusCategory: ['done'] } });
    expect(j).toBe('assignee = currentUser() AND statusCategory in (3) ORDER BY updated DESC');
  });

  it('текст → text ~, кавычки и слэши экранируются (сначала для Lucene, затем для JQL)', () => {
    expect(buildJql({ mode: 'mine', text: 'say "hi" \\ there' })).toContain(String.raw`text ~ "say \\\"hi\\\" \\\\ there"`);
    expect(buildJql({ mode: 'mine', text: 'a\nb' })).toContain('text ~ "a b"');
  });

  it('ключ → key = KEY (в верхнем регистре) или тот же текст', () => {
    expect(buildJql({ mode: 'mine', text: 'abc-123' })).toBe(
      String.raw`assignee = currentUser() AND resolution = Unresolved AND (key = ABC-123 OR text ~ "abc\\-123") ORDER BY updated DESC`,
    );
  });

  it('textAsKey: false — похожее на ключ ищется только текстом (UTF-8)', () => {
    expect(buildJql({ mode: 'mine', text: 'UTF-8', textAsKey: false })).toContain(String.raw`AND text ~ "UTF\\-8" ORDER`);
    expect(buildJql({ mode: 'mine', text: 'UTF-8', textAsKey: false })).not.toContain('key =');
  });

  it('спецсимволы Lucene в поиске экранируются, * и ? остаются подстановками', () => {
    expect(buildJql({ mode: 'mine', text: '[UI] C++ foo! a:b' })).toContain(String.raw`text ~ "\\[UI\\] C\\+\\+ foo\\! a\\:b"`);
    expect(buildJql({ mode: 'mine', text: 'ab* ?x' })).toContain('text ~ "ab* ?x"');
    expect(buildJql({ mode: 'mine', text: 'foo AND bar OR NOT x ANDROID' })).toContain('text ~ "foo and bar or not x ANDROID"');
  });

  it('пустой текст и пустые массивы игнорируются', () => {
    expect(buildJql({ mode: 'mine', text: '   ', quick: { statusCategory: [], types: [], priorities: [] } })).toBe(buildJql({ mode: 'mine' }));
  });

  it('режим jql: свой ORDER BY сохраняется, условие оборачивается в скобки при наличии фильтров', () => {
    expect(buildJql({ mode: 'jql', jql: 'project = ABC OR labels = x ORDER BY created ASC' })).toBe('project = ABC OR labels = x ORDER BY created ASC');
    expect(buildJql({ mode: 'jql', jql: 'project = ABC OR labels = x ORDER BY created ASC', text: 'foo' })).toBe(
      '(project = ABC OR labels = x) AND text ~ "foo" ORDER BY created ASC',
    );
  });

  it('режим jql без ORDER BY получает дефолтный', () => {
    expect(buildJql({ mode: 'jql', jql: 'labels = x' })).toBe('labels = x ORDER BY updated DESC');
  });

  it('режим jql: только ORDER BY + фильтр — без пустых скобок', () => {
    expect(buildJql({ mode: 'jql', jql: 'ORDER BY created', text: 'foo' })).toBe('text ~ "foo" ORDER BY created');
  });

  it('режим jql: пустой запрос — только сортировка', () => {
    expect(buildJql({ mode: 'jql', jql: '' })).toBe('ORDER BY updated DESC');
  });
});

describe('luceneEscape', () => {
  it('операторы Lucene и висящий слэш', () => {
    expect(luceneEscape('foo\\')).toBe('foo\\\\');
    expect(luceneEscape('5" (x) {y} ^~/-|&')).toBe(String.raw`5\" \(x\) \{y\} \^\~\/\-\|\&`);
  });
});

describe('сортировка', () => {
  it('orderBy', () => {
    expect(orderBy({ field: 'key', desc: true })).toBe('ORDER BY key DESC');
    expect(orderBy({ field: 'created', desc: false })).toBe('ORDER BY created ASC');
    expect(orderBy({ field: 'priority', desc: true })).toBe('ORDER BY priority DESC, updated DESC');
  });

  it('явная сортировка заменяет порядок по умолчанию и ORDER BY из JQL', () => {
    const order = orderBy({ field: 'created', desc: true });
    expect(buildJql({ mode: 'project', projectKey: 'ABC', order })).toBe('project = ABC ORDER BY created DESC');
    expect(buildJql({ mode: 'jql', jql: 'status = Open ORDER BY rank', order })).toBe('status = Open ORDER BY created DESC');
    expect(buildJql({ mode: 'jql', jql: 'status = Open ORDER BY rank' })).toBe('status = Open ORDER BY rank');
  });

  it('isIssueSort', () => {
    expect(isIssueSort({ field: 'priority', desc: false })).toBe(true);
    expect(isIssueSort({ field: 'rank', desc: false })).toBe(false);
    expect(isIssueSort({ field: 'key' })).toBe(false);
    expect(isIssueSort(undefined)).toBe(false);
  });
});

describe('splitOrderBy', () => {
  it('ORDER BY сразу после кавычки', () => {
    expect(splitOrderBy('summary ~ "x"ORDER BY created')).toEqual({ where: 'summary ~ "x"', order: 'ORDER BY created' });
  });
  it('не режет по «order by» внутри кавычек', () => {
    expect(splitOrderBy('summary ~ "x order by y" ORDER BY key')).toEqual({ where: 'summary ~ "x order by y"', order: 'ORDER BY key' });
    expect(splitOrderBy('summary ~ "a \\" order by b"')).toEqual({ where: 'summary ~ "a \\" order by b"', order: '' });
  });
  it('регистр и пробелы', () => {
    expect(splitOrderBy('a = 1 order   by created desc')).toEqual({ where: 'a = 1', order: 'order   by created desc' });
  });
  it('поле с «order» в имени не считается сортировкой', () => {
    expect(splitOrderBy('reorder by = 1')).toEqual({ where: 'reorder by = 1', order: '' });
  });
});

describe('helpers', () => {
  it('isIssueKey', () => {
    expect(isIssueKey('ABC-123')).toBe(true);
    expect(isIssueKey(' abc-1 ')).toBe(true);
    expect(isIssueKey('ABC123')).toBe(false);
    expect(isIssueKey('hello world')).toBe(false);
    expect(isIssueKey('1-2')).toBe(false);
  });
  it('quoteJql', () => {
    expect(quoteJql('a"b')).toBe('"a\\"b"');
  });
});
