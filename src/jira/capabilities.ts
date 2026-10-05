import type { JiraClient } from './client';
import { JiraError } from './http';
import type { Capabilities } from './types';

export const EPIC_LINK_SCHEMA = 'com.pyxis.greenhopper.jira:gh-epic-link';

/**
 * Tempo: GET /rest/tempo-core/1/work-attribute — 200 «есть», 404 или HTML вместо JSON (редирект на login.jsp) «нет» (прочие ошибки пробрасываются).
 * Epic Link — по /rest/api/2/field. На Cloud оба шага пропускаются: Tempo Cloud — другой API
 * (вне MVP), эпик там — `parent`.
 */
export async function detectCapabilities(client: JiraClient): Promise<Capabilities> {
  let tempo = false;
  let epicLinkField: string | null = null;
  if (client.kind === 'dc') {
    try {
      await client.http.getJson('/rest/tempo-core/1/work-attribute');
      tempo = true;
    } catch (e) {
      // Сервер без Tempo: 404 либо (globex) 302 на login.jsp → после редиректа HTML вместо JSON.
      if (!(e instanceof JiraError && (e.status === 404 || e.code === 'format'))) throw e;
    }
    const fields = await client.fields();
    epicLinkField = fields.find((f) => f.schemaCustom === EPIC_LINK_SCHEMA)?.id ?? null;
  }
  let serverVersion: string | undefined;
  try {
    serverVersion = await client.serverVersion();
  } catch {
    serverVersion = undefined; // версия — справочная, не валим из-за неё
  }
  return { tempo, epicLinkField, checkedAt: new Date().toISOString(), ...(serverVersion ? { serverVersion } : {}) };
}
