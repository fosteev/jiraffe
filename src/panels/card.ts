// Сборка данных карточки: запрос в Jira + санитизация. Без vscode — тестируется в vitest.
import type { JiraClient } from '../jira/client';
import { sanitizeDetail } from '../jira/sanitize';
import type { Instance } from '../jira/types';
import type { IssueCard } from './protocol';

export const hostOfUrl = (baseUrl: string): string => {
  try {
    const u = new URL(baseUrl);
    return u.host + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''));
  } catch {
    return baseUrl;
  }
};

export const browseUrl = (baseUrl: string, key: string): string => `${baseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}`;

export async function loadCard(client: JiraClient, instance: Instance, key: string): Promise<Omit<IssueCard, 'pinned' | 'tab'>> {
  const { issue, worklogs, worklogError } = await client.issueDetail(key, instance);
  return {
    instanceId: instance.id,
    instanceName: instance.name,
    host: hostOfUrl(instance.baseUrl),
    kind: instance.kind,
    tempo: instance.caps?.tempo === true,
    issue: sanitizeDetail(issue, instance.baseUrl),
    worklogs,
    ...(worklogError ? { worklogError } : {}),
  };
}
