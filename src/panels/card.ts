// Сборка данных карточки: запрос в Jira + санитизация. Без vscode — тестируется в vitest.
import { extractInlineImages, isImageAttachment, isTextAttachment } from '../jira/attachments';
import type { JiraClient } from '../jira/client';
import { sanitizeDetail } from '../jira/sanitize';
import { TempoClient, withTempoAttributes, type WorkAttribute } from '../jira/tempo';
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

/**
 * Карточка задачи. На Tempo-инстансе журнал — тот же стандартный `/worklog` (ворклоги Tempo там есть — проверено),
 * плюс атрибуты Tempo по каждому ворклогу (`withTempoAttributes`) и их описания (`attrs`, колонки таблицы).
 * Атрибуты — best effort: их ошибка карточку не роняет.
 */
export async function loadCard(client: JiraClient, instance: Instance, key: string, attrs?: () => Promise<WorkAttribute[]>): Promise<LoadedCard> {
  const tempo = instance.caps?.tempo === true;
  const [detail, workAttributes] = await Promise.all([
    client.issueDetail(key, instance),
    tempo && attrs ? attrs().catch((): WorkAttribute[] => []) : Promise.resolve([] as WorkAttribute[]),
  ]);
  const { issue, worklogError } = detail;
  let { worklogs } = detail;
  if (tempo && worklogs.length) worklogs = await withTempoAttributes(new TempoClient(client.http), worklogs).catch(() => worklogs);
  const { issue: clean, urls } = extractInlineImages(sanitizeDetail(issue, instance.baseUrl), instance.baseUrl);
  return {
    card: {
      instanceId: instance.id,
      instanceName: instance.name,
      host: hostOfUrl(instance.baseUrl),
      kind: instance.kind,
      tempo,
      issue: { ...clean, attachments: [] },
      worklogs,
      ...(worklogError ? { worklogError } : {}),
      attachments: issue.attachments.map(attachmentView),
      ...(tempo ? { workAttributes } : {}),
    },
    files: issue.attachments,
    inlineUrls: urls,
  };
}
