// Read-only smoke по живым инстансам из env. Только GET. Токены не печатаются.
import { detectCapabilities } from '../src/jira/capabilities';
import { createJiraClient } from '../src/jira/client';
import type { InstanceKind } from '../src/jira/types';

interface Target { id: string; kind: InstanceKind; urlEnv: string; defUrl: string; tokenEnv: string; expect: { tempo: boolean; epic: string | null } }

const targets: Target[] = [
  { id: 'pilot', kind: 'dc', urlEnv: 'JIRA_PILOT_URL', defUrl: 'https://jira.pilot-gps.com', tokenEnv: 'JIRA_PILOT_TOKEN', expect: { tempo: true, epic: 'customfield_10100' } },
  { id: 'sccloud', kind: 'dc', urlEnv: 'JIRA_SCCLOUD_URL', defUrl: 'https://jira.sccloud.ru', tokenEnv: 'JIRA_SCCLOUD_TOKEN', expect: { tempo: false, epic: 'customfield_10102' } },
  { id: 'tatikoma', kind: 'dc', urlEnv: 'JIRA_TATIKOMA_URL', defUrl: 'https://atlassian.tatikoma.ru/jira', tokenEnv: 'JIRA_TATIKOMA_TOKEN', expect: { tempo: false, epic: 'customfield_10102' } },
  { id: 'cloud', kind: 'cloud', urlEnv: 'JIRA_CLOUD_URL', defUrl: 'https://fosteev.atlassian.net', tokenEnv: 'JIRA_CLOUD_TOKEN', expect: { tempo: false, epic: null } },
];

async function main(): Promise<void> {
  const rows: string[][] = [['инстанс', 'пользователь', 'tempo', 'epicLinkField', 'задач', 'ожидание']];
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
    } catch (e) {
      mismatches++;
      rows.push([t.id, '—', '—', '—', '—', `ОШИБКА: ${e instanceof Error ? e.message : String(e)}`]);
    }
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(w[i])).join('  '));
  if (mismatches) process.exitCode = 1;
}

void main();
