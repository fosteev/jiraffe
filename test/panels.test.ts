import { describe, expect, it } from 'vitest';
import { browseUrl, hostOfUrl } from '../src/panels/card';
import { csp, makeNonce, renderShell } from '../src/panels/html';
import { ISSUE_TABS, isIssueKey, isVersionId, safeExternalUrl, type IssueCard } from '../src/panels/protocol';
import { esc, fmtDue, priorityIcon, renderCard, typeKind } from '../webview/render';

const card: IssueCard = {
  instanceId: 'i', instanceName: 'Sample <b>', host: 'h.example', kind: 'dc', tempo: false, pinned: false, tab: 'desc',
  issue: {
    instanceId: 'i', key: 'ABC-1', summary: 'S <img src=x onerror=1>', type: 'Bug', status: 'Open', statusCategory: 'new', updated: '2026-01-02T10:00:00.000+0000',
    watchers: [], descriptionHtml: '<p>d</p>', fixVersions: [{ id: '7', name: '1.0' }], labels: [], components: [], created: '2026-01-01T10:00:00.000+0000',
    timetracking: { originalSec: 3600, spentSec: 7200 }, attachments: [], comments: [], history: [],
    epic: { key: 'ABC-0', summary: 'Epic' },
  },
  worklogs: [],
  attachments: [],
};

describe('html shell', () => {
  it('CSP дословно по плану, nonce в script', () => {
    expect(csp('vscode-webview://x', 'N')).toBe("default-src 'none'; img-src vscode-webview://x data:; style-src vscode-webview://x; script-src 'nonce-N'");
    const nonce = makeNonce();
    expect(nonce).not.toBe(makeNonce());
    const html = renderShell({ cspSource: 'vscode-webview://x', nonce, scriptUri: 'u/issue.js', styleUri: 'u/common.css', title: 'A"B', l10n: { locale: 'en' } });
    expect(html).toContain(`<script nonce="${nonce}" src="u/issue.js">`);
    expect(html).toContain('href="u/common.css"');
    expect(html).toContain('<title>A&quot;B</title>');
    expect(html).not.toMatch(/ style=|unsafe-inline/);
  });
  it('browseUrl / hostOfUrl с context path', () => {
    expect(browseUrl('https://h.example/jira/', 'ABC-1')).toBe('https://h.example/jira/browse/ABC-1');
    expect(hostOfUrl('https://h.example/jira/')).toBe('h.example/jira');
  });
});

describe('render карточки', () => {
  it('экранирует пользовательский текст, не использует inline style, кнопки и вкладки на месте', () => {
    for (const tab of ISSUE_TABS) {
      const html = renderCard(card, tab);
      expect(html).not.toMatch(/ style=/);
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('S &lt;img src=x onerror=1&gt;');
      expect(html).toContain('Sample &lt;b&gt;');
      for (const a of ['copyKey', 'openInBrowser', 'logWork', 'pin']) expect(html).toContain(`data-act="${a}"`);
      expect(html.match(/data-act="tab"/g)).toHaveLength(5);
    }
  });
  it('закреплённая: кнопка disabled; эпик и релиз — кнопки-ссылки с data-атрибутами', () => {
    const html = renderCard({ ...card, pinned: true }, 'desc');
    expect(html).toContain('data-act="pin" disabled');
    expect(html).toContain('data-act="epic" data-key="ABC-0"');
    expect(html).toContain('data-act="release" data-id="7"');
  });
  it('время: сверх оценки подсвечено, полоска с data-w', () => {
    const html = renderCard(card, 'desc');
    expect(html).toContain('over estimate');
    expect(html).toContain('data-w="100"');
  });
  it('пустые вкладки не падают', () => {
    expect(renderCard(card, 'com')).toContain('No comments');
    expect(renderCard(card, 'wl')).toContain('No entries yet');
    expect(renderCard(card, 'hist')).toContain('created the issue');
  });
  it('хелперы', () => {
    expect(esc('<&">')).toBe('&lt;&amp;&quot;&gt;');
    expect(typeKind('Ошибка')).toBe('bug');
    expect(typeKind('Epic')).toBe('epic');
    expect(typeKind('Sub-task')).toBe('subtask');
    expect(priorityIcon('Highest')).toContain('M3.5 8.5L8 5');
    expect(priorityIcon(undefined)).toBe('');
    expect(fmtDue('not-a-date')).toBe('not-a-date');
  });
  it('проверки сообщений из webview: ключ и id релиза', () => {
    for (const k of ['ABC-1', 'GARM_2-123', 'A1-0']) expect(isIssueKey(k)).toBe(true);
    for (const k of ['abc-1', 'ABC-1/../../rest', 'ABC-1?x', ' ABC-1', 'ABC', '-1', 1, undefined, 'A'.repeat(70) + '-1']) expect(isIssueKey(k)).toBe(false);
    expect(isVersionId('10200')).toBe(true);
    for (const v of ['1.0', '', '1 OR 1', 7]) expect(isVersionId(v)).toBe(false);
  });
  it('openExternal из webview: только http(s)/mailto', () => {
    expect(safeExternalUrl('https://h.example/jira/browse/ABC-1?q=a%2Bb#x')).toBe('https://h.example/jira/browse/ABC-1?q=a%2Bb#x');
    expect(safeExternalUrl('mailto:a@example.test')).toBe('mailto:a@example.test');
    for (const u of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'vscode:extension/x', 'command:workbench.action.quit', 'file:///etc/passwd', 'data:text/html,x', 'not a url', '', 42, undefined]) {
      expect(safeExternalUrl(u)).toBeUndefined();
    }
  });
  it('журнал не загрузился — текст ошибки экранирован, instead of “No entries yet”', () => {
    const html = renderCard({ ...card, worklogError: 'HTTP 500 <x>' }, 'wl');
    expect(html).toContain('Failed to load the work log: HTTP 500 &lt;x&gt;');
    expect(html).not.toContain('No entries yet');
  });
});
