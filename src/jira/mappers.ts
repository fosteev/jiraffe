import type { InstanceKind, IssueSummary, StatusCategory, UserRef } from './types';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function mapUser(raw: Raw | null | undefined, kind: InstanceKind): UserRef | undefined {
  if (!raw) return undefined;
  const id = kind === 'cloud' ? raw.accountId : raw.name;
  if (!id) return undefined;
  const avatar = raw.avatarUrls?.['48x48'] ?? raw.avatarUrls?.['32x32'];
  return { id: String(id), name: String(raw.displayName ?? id), ...(avatar ? { avatarUrl: String(avatar) } : {}) };
}

export function mapStatusCategory(raw: Raw | null | undefined): StatusCategory {
  const key = raw?.statusCategory?.key;
  return key === 'done' || key === 'indeterminate' ? key : 'new';
}

export function mapIssueSummary(instanceId: string, kind: InstanceKind, raw: Raw): IssueSummary {
  const f: Raw = raw.fields ?? {};
  return {
    instanceId,
    key: String(raw.key),
    summary: String(f.summary ?? ''),
    type: String(f.issuetype?.name ?? ''),
    ...(f.issuetype?.iconUrl ? { typeIconUrl: String(f.issuetype.iconUrl) } : {}),
    status: String(f.status?.name ?? ''),
    statusCategory: mapStatusCategory(f.status),
    ...(f.priority?.name ? { priority: String(f.priority.name) } : {}),
    ...(mapUser(f.assignee, kind) ? { assignee: mapUser(f.assignee, kind) } : {}),
    updated: String(f.updated ?? ''),
  };
}
