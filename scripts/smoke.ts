// Read-only smoke по живым инстансам из env. Только GET. Токены не печатаются.
import { detectCapabilities } from '../src/jira/capabilities';
import { createJiraClient } from '../src/jira/client';
import type { InstanceKind, SearchPage } from '../src/jira/types';
import { sanitizeDetail } from '../src/jira/sanitize';
import { buildJql } from '../src/jql';

interface Target { id: string; kind: InstanceKind; urlEnv: string; defUrl: string; tokenEnv: string; expect: { tempo: boolean; epic: string | null } }

const targets: Target[] = [
  { id: 'pilot', kind: 'dc', urlEnv: 'JIRA_PILOT_URL', defUrl: 'https://jira.pilot-gps.com', tokenEnv: 'JIRA_PILOT_TOKEN', expect: { tempo: true, epic: 'customfield_10100' } },
  { id: 'sccloud', kind: 'dc', urlEnv: 'JIRA_SCCLOUD_URL', defUrl: 'https://jira.sccloud.ru', tokenEnv: 'JIRA_SCCLOUD_TOKEN', expect: { tempo: false, epic: 'customfield_10102' } },
  { id: 'tatikoma', kind: 'dc', urlEnv: 'JIRA_TATIKOMA_URL', defUrl: 'https://atlassian.tatikoma.ru/jira', tokenEnv: 'JIRA_TATIKOMA_TOKEN', expect: { tempo: false, epic: 'customfield_10102' } },
  { id: 'cloud', kind: 'cloud', urlEnv: 'JIRA_CLOUD_URL', defUrl: 'https://fosteev.atlassian.net', tokenEnv: 'JIRA_CLOUD_TOKEN', expect: { tempo: false, epic: null } },
];

const countOf = (p: SearchPage): string => (p.total !== undefined ? String(p.total) : p.next ? `${p.issues.length}+` : String(p.issues.length));

/** Этап 3: справочники и JQL из buildJql на живом инстансе (только GET). Возвращает строку таблицы. */
async function jqlChecks(t: Target, c: ReturnType<typeof createJiraClient>): Promise<string[]> {
  const projects = await c.projects();
  const types = await c.issueTypes();
  const prios = await c.priorities();
  const favs = await c.favouriteFilters();
  const count = async (jql: string): Promise<string> => countOf(await c.search(jql, undefined, { maxResults: 100 }));
  const mine = await count(buildJql({ mode: 'mine' }));
  // «проект GARM» — на Pilot; на остальных первый доступный проект
  const projKey = t.id === 'pilot' && projects.some((p) => p.key === 'GARM') ? 'GARM' : projects[0]?.key;
  const proj = projKey ? await count(buildJql({ mode: 'project', projectKey: projKey })) : '—';
  const quick = await count(buildJql({
    mode: 'mine',
    quick: { statusCategory: ['new', 'indeterminate'], types: types.slice(0, 1).map((x) => x.name), priorities: prios.slice(0, 1).map((x) => x.name) },
    text: 'test',
  }));
  const done = await count(buildJql({ mode: 'project', projectKey: projKey, quick: { statusCategory: ['done'] } }));
  // инвариант: три категории в сумме дают весь проект (проверяет, что id 2/3/4 в JQL — те самые категории)
  const parts = await Promise.all((['new', 'indeterminate', 'done'] as const).map((k) => count(buildJql({ mode: 'project', projectKey: projKey, quick: { statusCategory: [k] } }))));
  const sum = parts.reduce((a, x) => a + parseInt(x, 10), 0);
  const catsOk = !proj.endsWith('+') && sum === parseInt(proj, 10);
  if (!catsOk && !proj.endsWith('+')) throw new Error(`категории статусов: сумма ${sum} != проект ${proj}`);
  const jqlMode = await count(buildJql({ mode: 'jql', jql: 'resolution = Unresolved ORDER BY created ASC', text: 'a "quoted" \\ word [UI] C++ foo! 5" AND x\\' }));
  return [t.id, String(projects.length), String(types.length), String(prios.length), String(favs.length), mine, `${projKey ?? '—'}: ${proj}`, quick, `${done} (${parts.join('+')})`, jqlMode];
}

/** Этап 4: карточка задачи (только GET). Берём свежую задачу, предпочитая ту, у которой есть эпик. Ключи не печатаем. */
async function cardCheck(t: Target, c: ReturnType<typeof createJiraClient>, caps: Awaited<ReturnType<typeof detectCapabilities>>): Promise<string[]> {
  const inst = { id: t.id, kind: t.kind, caps };
  const epicJql = t.kind === 'cloud' ? 'parent is not EMPTY' : caps.epicLinkField ? `cf[${caps.epicLinkField.replace('customfield_', '')}] is not EMPTY` : null;
  let page = epicJql ? await c.search(`${epicJql} ORDER BY updated DESC`, ['summary'], { maxResults: 1 }).catch(() => undefined) : undefined;
  if (!page?.issues.length) page = await c.search('updated >= -365d ORDER BY updated DESC', ['summary'], { maxResults: 1 });
  const key = page.issues[0]?.key;
  if (!key) return [t.id, 'нет задач'];
  const { issue, worklogs } = await c.issueDetail(key, inst);
  const s = sanitizeDetail(issue, process.env[t.urlEnv] || t.defUrl);
  if (/<script|onerror=|onclick=|javascript:/i.test(s.descriptionHtml + s.comments.map((x) => x.bodyHtml).join(''))) throw new Error('санитизация пропустила опасную разметку');
  if (!issue.summary || !issue.created) throw new Error('пустые summary/created');
  const spent = issue.timetracking.spentSec ?? 0;
  const wlSum = worklogs.reduce((a, w) => a + w.timeSpentSec, 0);
  return [t.id, issue.statusCategory, `${s.descriptionHtml.length}`, String(issue.comments.length), String(issue.history.length), String(worklogs.length), `${spent}/${wlSum}`,
    String(issue.watchers.length), issue.epic ? (issue.epic.summary ? 'да+название' : 'да') : 'нет', String(issue.fixVersions.length), String(issue.attachments.length)];
}

async function main(): Promise<void> {
  const rows: string[][] = [['инстанс', 'пользователь', 'tempo', 'epicLinkField', 'задач', 'ожидание']];
  const jqlRows: string[][] = [['инстанс', 'проектов', 'типов', 'приоритетов', 'избр.фильтров', 'на мне', 'проект', 'быстрые+текст', 'готово', 'JQL-режим']];
  const cardRows: string[][] = [['инстанс', 'категория', 'описание, симв.', 'комментариев', 'история', 'ворклогов', 'спент/сумма', 'наблюдателей', 'эпик', 'релизов', 'вложений']];
  let mismatches = 0;
  for (const t of targets) {
    const token = process.env[t.tokenEnv];
    if (!token) { rows.push([t.id, '—', '—', '—', '—', `пропущен (нет ${t.tokenEnv})`]); continue; }
    const email = process.env.JIRA_CLOUD_EMAIL;
    if (t.kind === 'cloud' && !email) { rows.push([t.id, '—', '—', '—', '—', 'пропущен (нет JIRA_CLOUD_EMAIL)']); continue; }
    const baseUrl = process.env[t.urlEnv] || t.defUrl;
    try {
      const c = createJiraClient({ id: t.id, kind: t.kind, baseUrl, email }, token);
      const me = await c.myself();
      const caps = await detectCapabilities(c);
      const page = await c.search('assignee = currentUser() AND resolution = Unresolved', undefined, { maxResults: 5 });
      const ok = caps.tempo === t.expect.tempo && caps.epicLinkField === t.expect.epic;
      if (!ok) mismatches++;
      const count = page.total !== undefined ? String(page.total) : page.next ? `${page.issues.length}+` : String(page.issues.length);
      rows.push([t.id, me.displayName, String(caps.tempo), String(caps.epicLinkField), count, ok ? 'ок' : `РАСХОЖДЕНИЕ (ждали tempo=${t.expect.tempo}, epic=${t.expect.epic})`]);
      try {
        jqlRows.push(await jqlChecks(t, c));
      } catch (e) {
        mismatches++;
        jqlRows.push([t.id, `ОШИБКА: ${e instanceof Error ? e.message : String(e)}`]);
      }
      try {
        cardRows.push(await cardCheck(t, c, caps));
      } catch (e) {
        mismatches++;
        cardRows.push([t.id, `ОШИБКА: ${e instanceof Error ? e.message : String(e)}`]);
      }
    } catch (e) {
      mismatches++;
      rows.push([t.id, '—', '—', '—', '—', `ОШИБКА: ${e instanceof Error ? e.message : String(e)}`]);
    }
  }
  for (const table of [rows, jqlRows, cardRows]) {
    const w = table[0].map((_, i) => Math.max(...table.map((r) => (r[i] ?? '').length)));
    for (const r of table) console.log(r.map((c, i) => c.padEnd(w[i])).join('  '));
    console.log('');
  }
  if (mismatches) process.exitCode = 1;
}

void main();
