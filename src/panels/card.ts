// Сборка данных карточки: запрос в Jira + санитизация. Без vscode — тестируется в vitest.
import { extractInlineImages, isImageAttachment, isTextAttachment } from '../jira/attachments';
import type { JiraClient } from '../jira/client';
import { sanitizeDetail } from '../jira/sanitize';
import type { Attachment, Instance } from '../jira/types';
import type { AttachmentView, IssueCard } from './protocol';

export const hostOfUrl = (baseUrl: string): string => {
  try {
    const u = new URL(baseUrl);
    return u.host + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''));
  } catch {
    return baseUrl;
  }
};

export const browseUrl = (baseUrl: string, key: string): string => `${baseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}`;

export const attachmentView = (a: Attachment): AttachmentView => {
  const { contentUrl: _c, thumbnailUrl: _t, ...rest } = a; // eslint-disable-line @typescript-eslint/no-unused-vars
  return { ...rest, image: isImageAttachment(a), text: isTextAttachment(a) };
};

export interface LoadedCard {
  /** Уходит в webview: без адресов Jira. */
  card: Omit<IssueCard, 'pinned' | 'tab'>;
  /** Только хосту: вложения с адресами и адреса картинок описания/комментариев (`iN` → `inlineUrls[N]`). */
  files: Attachment[];
  inlineUrls: string[];
}

export async function loadCard(client: JiraClient, instance: Instance, key: string): Promise<LoadedCard> {
  const { issue, worklogs, worklogError } = await client.issueDetail(key, instance);
  const { issue: clean, urls } = extractInlineImages(sanitizeDetail(issue, instance.baseUrl), instance.baseUrl);
  return {
    card: {
      instanceId: instance.id,
      instanceName: instance.name,
      host: hostOfUrl(instance.baseUrl),
      kind: instance.kind,
      tempo: instance.caps?.tempo === true,
      issue: { ...clean, attachments: [] },
      worklogs,
      ...(worklogError ? { worklogError } : {}),
      attachments: issue.attachments.map(attachmentView),
    },
    files: issue.attachments,
    inlineUrls: urls,
  };
}
