import * as vscode from 'vscode';
import { noticeText } from '../jira/attachments';
import { localDate } from '../jira/worklog';
import type { InstanceStore } from '../state/instances';
import type { InstanceMeta } from '../state/meta';
import { browseUrl } from './card';
import { getBundle, locale, t } from '../l10n';
import { makeNonce, renderShell } from './html';
import { loadEpicPage, loadReleasePage, releaseUrl } from './list';
import { isIssueKey, isVersionId, type HostToList, type ListPage, type ListToHost } from './protocol';

export type ListKind = ListPage['type'];
/** Эпик: `id` — ключ; релиз: `id` — id версии. */
export interface ListRef { kind: ListKind; instanceId: string; id: string }

interface Entry {
  panel: vscode.WebviewPanel;
  ref: ListRef;
  data?: ListPage;
  error?: string;
  ready: boolean;
  /** Номер последней загрузки: устаревший ответ отбрасывается. */
  seq: number;
  disposed: boolean;
}

const idOf = (r: ListRef): string => `${r.kind}\n${r.instanceId}\n${r.id}`;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Вкладки эпика и релиза: по одной на цель (повторное открытие — фокус и перечитывание). Как и карточка, вкладка выгружается
 * при скрытии (`retainContextWhenHidden: false`): данные живут в хосте и уходят в webview по `ready`.
 */
export class ListPanelManager implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: InstanceStore,
    private readonly meta: InstanceMeta,
  ) {}

  dispose(): void {
    for (const e of [...this.entries.values()]) e.panel.dispose();
  }

  /** Ключ эпика и id версии — по формату (аргументы команд и сообщений webview недоверенные). */
  static valid(ref: ListRef): boolean {
    return ref.kind === 'epic' ? isIssueKey(ref.id) : isVersionId(ref.id);
  }

  open(ref: ListRef): void {
    if (!ListPanelManager.valid(ref)) return;
    const found = this.entries.get(idOf(ref));
    if (found) {
      found.panel.reveal(undefined, false);
      void this.load(found);
      return;
    }
    const e = this.create(ref);
    this.entries.set(idOf(ref), e);
    void this.load(e);
  }

  private create(ref: ListRef): Entry {
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const title = ref.kind === 'epic' ? ref.id : t('Release');
    const panel = vscode.window.createWebviewPanel(`jiraffe.${ref.kind}`, title, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, {
      enableScripts: true,
      enableFindWidget: true,
      retainContextWhenHidden: false,
      localResourceRoots: [root],
    });
    panel.webview.html = renderShell({
      cspSource: panel.webview.cspSource,
      nonce: makeNonce(),
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'list.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'common.css')).toString(),
      title,
      l10n: { bundle: getBundle(), locale: locale() },
    });
    const e: Entry = { panel, ref, ready: false, seq: 0, disposed: false };
    panel.webview.onDidReceiveMessage((m: ListToHost) => this.onMessage(e, m));
    panel.onDidChangeViewState(() => {
      if (!panel.visible) e.ready = false; // выгруженный webview пришлёт новый `ready`
    });
    panel.onDidDispose(() => {
      e.disposed = true;
      if (this.entries.get(idOf(e.ref)) === e) this.entries.delete(idOf(e.ref));
    });
    return e;
  }

  /** Перечитать открытые вкладки (по `jiraffe.refresh`). */
  reloadAll(): void {
    for (const e of this.entries.values()) void this.load(e);
  }

  private async load(e: Entry): Promise<void> {
    const seq = ++e.seq;
    const ref = e.ref;
    e.error = undefined;
    this.render(e);
    try {
      const inst = this.store.get(ref.instanceId);
      if (!inst) throw new Error(t('instance removed — add it again'));
      const client = await this.meta.client(inst);
      let data: ListPage;
      if (ref.kind === 'epic') {
        data = await loadEpicPage(client, inst, ref.id);
      } else {
        // Ключ проекта версии — из кэша проектов; не загрузился — вкладка без проекта в крошках.
        const projects = await this.meta.projects(inst).catch(() => []);
        data = await loadReleasePage(client, inst, ref.id, (pid) => projects.find((p) => p.id === pid)?.key, localDate());
      }
      if (e.disposed || e.seq !== seq) return;
      e.data = data;
      e.panel.title = data.type === 'epic' ? data.key : data.name;
    } catch (err) {
      if (e.disposed || e.seq !== seq) return;
      e.data = undefined;
      e.error = errText(err);
    }
    this.render(e);
  }

  private render(e: Entry): void {
    if (e.disposed || !e.ready) return;
    const { kind, instanceId, id } = e.ref;
    const msg: HostToList = e.error ? { type: 'error', kind, instanceId, id, message: e.error }
      : e.data ? { type: 'page', data: e.data } : { type: 'loading', kind, instanceId, id };
    void e.panel.webview.postMessage(msg);
  }

  /** Сообщения webview недоверенные: инстанс и цель должны совпасть с вкладкой, ключ — по формату. */
  private onMessage(e: Entry, m: ListToHost): void {
    if (!m || typeof m !== 'object') return;
    const ref = e.ref;
    const sameTarget = (x: { instanceId?: unknown; kind?: unknown; id?: unknown }): boolean => x.instanceId === ref.instanceId && x.kind === ref.kind && x.id === ref.id;
    switch (m.type) {
      case 'ready':
        e.ready = true;
        this.render(e);
        break;
      case 'refresh':
        if (sameTarget(m)) void this.load(e);
        break;
      case 'openIssue':
        if (m.instanceId === ref.instanceId && isIssueKey(m.key)) void vscode.commands.executeCommand('jiraffe.openIssue', { instanceId: ref.instanceId, key: m.key });
        break;
      case 'openInBrowser':
        if (sameTarget(m)) this.openInBrowser(e);
        break;
    }
  }

  private openInBrowser(e: Entry): void {
    const inst = this.store.get(e.ref.instanceId);
    if (!inst) return;
    const d = e.data;
    const url = e.ref.kind === 'epic'
      ? browseUrl(inst.baseUrl, e.ref.id)
      : releaseUrl(inst.baseUrl, d?.project ?? '', e.ref.id);
    if (!url) {
      void vscode.window.showInformationMessage(t('Jiraffe: could not determine the version’s project — release URL unknown'));
      return;
    }
    void vscode.env.openExternal(vscode.Uri.parse(url)).then(undefined, (err: unknown) => vscode.window.showErrorMessage(`Jiraffe: ${noticeText(errText(err))}`));
  }
}
