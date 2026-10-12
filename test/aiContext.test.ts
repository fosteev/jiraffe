import { describe, expect, it } from 'vitest';
import { AI_COMMENTS, askMenu, htmlToText, issueContext, parseTaskSessions, taskMeta } from '../src/panels/aiContext';
import type { IssueDetail } from '../src/jira/types';

const detail = (descriptionHtml: string, comments: string[] = []): IssueDetail => ({
  instanceId: 'i', key: 'ABC-1', summary: 'Fix login', type: 'Bug', status: 'Open', statusCategory: 'new', updated: '2026-10-02', watchers: [], descriptionHtml,
  fixVersions: [{ id: '1', name: '2.0' }], labels: ['auth'], components: [], created: '2026-10-01', timetracking: {}, attachments: [], history: [],
  assignee: { id: 'u', name: 'Ann' },
  comments: comments.map((bodyHtml, n) => ({ id: String(n), created: `c${n}`, bodyHtml, author: { id: 'b', name: 'Bob' } })),
});

describe('htmlToText', () => {
  it('блоки — строки, списки — пункты, ссылки — с адресом, сущности раскодированы', () => {
    const html = '<p>Hello&nbsp;<b>world</b> &amp; &lt;you&gt; &#8212; &#x41;</p><ul><li>one</li><li>two</li></ul><p>see <a href="https://x.test/a">docs</a>, <a href="https://x.test/b">https://x.test/b</a></p>';
    expect(htmlToText(html)).toBe('Hello world & <you> — A\n\n- one\n- two\n\nsee docs (https://x.test/a), https://x.test/b');
  });

  it('картинки — [image], переносы <br>, лишние пустые строки схлопываются', () => {
    expect(htmlToText('<p>a<br/>b</p><p></p><p></p><span class="img-ph" data-img="i0">pic.png</span><img src="x">')).toBe('a\nb\n\n[image][image]');
  });
});

describe('issueContext', () => {
  it('поля, описание и комментарии; пустые поля пропущены', () => {
    const s = issueContext({ instanceName: 'Work', issue: detail('<p>Steps</p>', ['<p>ok</p>']) }, 'https://j.test/browse/ABC-1');
    expect(s).toContain('# ABC-1: Fix login\n');
    expect(s).toContain('- URL: https://j.test/browse/ABC-1\n');
    expect(s).toContain('- Assignee: Ann\n');
    expect(s).toContain('- Fix versions: 2.0\n');
    expect(s).not.toContain('Priority');
    expect(s).not.toContain('Components');
    expect(s).toContain('## Description\n\nSteps\n');
    expect(s).toContain('## Comments (1)\n\n### Bob, c0\n\nok\n');
  });

  it('без описания — (empty); комментариев больше лимита — последние', () => {
    const many = Array.from({ length: AI_COMMENTS + 3 }, (_, n) => `<p>m${n}</p>`);
    const s = issueContext({ instanceName: 'Work', issue: detail('', many) }, 'u');
    expect(s).toContain('## Description\n\n(empty)\n');
    expect(s).toContain(`## Comments (last ${AI_COMMENTS} of ${AI_COMMENTS + 3})`);
    expect(s).not.toContain('\nm2\n');
    expect(s).toContain(`\nm${AI_COMMENTS + 2}\n`);
  });
});

describe('меню «Открыть в Agentura»', () => {
  const s = (id: string, updatedAt: number) => ({ id, provider: 'claude', title: id, updatedAt, live: false });

  it('0 чатов — без меню (сразу новый чат)', () => {
    expect(askMenu([])).toBeNull();
    expect(askMenu(parseTaskSessions([])!)).toBeNull();
  });

  it('2 чата — «Продолжить» первым (самый свежий), затем остальной, затем «новый»', () => {
    const menu = askMenu(parseTaskSessions([s('old', 1), s('fresh', 5)])!)!;
    expect(menu.map((m) => m.kind)).toEqual(['continue', 'chat', 'new']);
    expect(menu[0]).toMatchObject({ kind: 'continue', session: { id: 'fresh' } });
    expect(menu[1]).toMatchObject({ kind: 'chat', session: { id: 'old' } });
  });

  it('ответ не массив (старая Agentura) — undefined; битые элементы пропускаются', () => {
    expect(parseTaskSessions(undefined)).toBeUndefined();
    expect(parseTaskSessions({})).toBeUndefined();
    expect(parseTaskSessions([null, { title: 'x' }, { id: 'a', updatedAt: '2026-10-01T00:00:00Z', live: true }])).toEqual([
      { id: 'a', provider: '', title: '', updatedAt: Date.parse('2026-10-01T00:00:00Z'), live: true },
    ]);
  });

  it('недоверенный ответ: длинный id пропускается, title обрезается, не больше 50 чатов', () => {
    const many = Array.from({ length: 80 }, (_, i) => s(`c${i}`, i));
    const r = parseTaskSessions([{ id: 'x'.repeat(201) }, { id: 'long', title: 't'.repeat(500), updatedAt: {} }, ...many])!;
    expect(r).toHaveLength(50);
    expect(r[0].id).toBe('c79');
    expect(r.find((x) => x.id.startsWith('xxx'))).toBeUndefined();
    const all = parseTaskSessions([{ id: 'long', title: 't'.repeat(500), updatedAt: {} }])!;
    expect(all[0]).toMatchObject({ title: 't'.repeat(200), updatedAt: 0 });
  });

  it('taskMeta — поля из карточки', () => {
    expect(taskMeta({ instanceName: 'W', issue: detail('') } as never, 'inst', 'https://j.test/browse/ABC-1')).toEqual({
      key: 'ABC-1', instanceId: 'inst', title: 'Fix login', status: 'Open', statusCategory: 'new', url: 'https://j.test/browse/ABC-1',
    });
  });
});
