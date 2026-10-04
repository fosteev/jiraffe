import * as vscode from 'vscode';
import { noticeText } from '../jira/attachments';
import type { Attachment } from '../jira/types';
import type { InstanceStore } from '../state/instances';
import type { InstanceMeta } from '../state/meta';
import type { IssueRef } from '../views/issuesTree';
import type { AttachmentContext, AttachmentService } from './attachments';
import { browseUrl, loadCard } from './card';
import { makeNonce, renderShell } from './html';
import {
  ISSUE_TABS, isAttachmentId, isImageId, isIssueKey, isVersionId, MAX_IMAGE_IDS, safeExternalUrl, type HostToView, type IssueCard, type IssueTab, type ViewToHost,
} from './protocol';

interface Entry {
  panel: vscode.WebviewPanel;
  ref: IssueRef;
  card?: Omit<IssueCard, 'pinned' | 'tab'>;
  /** Только в хосте: вложения с адресами и адреса картинок описания (`iN`). В webview адреса Jira не уходят. */
  files: Attachment[];
  inlineUrls: string[];
  error?: string;
  tab: IssueTab;
  pinned: boolean;
  ready: boolean;
  /** Номер последней загрузки: устаревший ответ (после смены задачи в preview) отбрасывается. */
  seq: number;
  disposed: boolean;
}

/** Действия над показанной задачей: принимаются, только если ключ в сообщении совпадает с текущим. */
const CARD_ACTIONS = new Set<ViewToHost['type']>(['openInBrowser', 'copyKey', 'logWork', 'pin', 'switchTab']);
/** Вложения и картинки: и instanceId, и key должны совпасть с показанной задачей, карточка — загружена. */
const ATTACHMENT_ACTIONS = new Set<ViewToHost['type']>(['loadImages', 'downloadAttachment', 'downloadAll', 'openAttachment']);
const idOf = (r: IssueRef): string => `${r.instanceId}\n${r.key}`;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const isIssueRef = (v: unknown): v is IssueRef =>
  !!v && typeof v === 'object' && typeof (v as IssueRef).instanceId === 'string' && typeof (v as IssueRef).key === 'string';

/**
 * Карточки задач: одна preview-вкладка (новая задача открывается в ней же) и закреплённые (по одной на задачу).
 * `retainContextWhenHidden: false`: скрытая вкладка выгружается, при показе webview шлёт `ready`, и мы отдаём
 * сохранённое состояние (данные и выбранная вкладка живут здесь, в хосте).
 */
export class IssuePanelManager implements vscode.Disposable {
  private preview: Entry | undefined;
  private readonly pinned = new Map<string, Entry>();
  private active: Entry | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: InstanceStore,
    private readonly meta: InstanceMeta,
    private readonly attachments: AttachmentService,
  ) {}

  dispose(): void {
    for (const e of [this.preview, ...this.pinned.values()]) e?.panel.dispose();
  }

  /** Открыть задачу: закреплённая — фокус, иначе — в preview (создаётся при необходимости). */
  open(ref: IssueRef): void {
    const pinned = this.pinned.get(idOf(ref));
    if (pinned) {
      pinned.panel.reveal(undefined, false);
      void this.load(pinned);
      return;
    }
    if (this.preview) {
      const same = idOf(this.preview.ref) === idOf(ref);
      if (!same) {
        this.preview.ref = ref;
        this.preview.card = undefined;
        this.preview.files = [];
        this.preview.inlineUrls = [];
        this.preview.error = undefined;
        this.preview.tab = 'desc';
        this.preview.panel.title = ref.key;
      }
      this.preview.panel.reveal(undefined, false);
      void this.load(this.preview);
      return;
    }
    this.preview = this.create(ref);
    void this.load(this.preview);
  }

  /** Перевести preview (или карточку указанной задачи) в закреплённые. */
  pin(ref?: IssueRef): boolean {
    const e = ref ? this.find(ref) : this.active ?? this.preview;
    if (!e) return false;
    this.pinEntry(e);
    return true;
  }

  copyKey(ref?: IssueRef): boolean {
    const e = ref ? this.find(ref) : this.active ?? this.preview;
    if (!e) return false;
    void vscode.env.clipboard.writeText(e.ref.key).then(() => vscode.window.setStatusBarMessage(`Jiraffe: ключ ${e.ref.key} скопирован`, 2500));
    return true;
  }

  openInBrowser(ref?: IssueRef): boolean {
    const e = ref ? this.find(ref) : this.active ?? this.preview;
    const inst = e && this.store.get(e.ref.instanceId);
    if (!e || !inst) return false;
    void vscode.env.openExternal(vscode.Uri.parse(browseUrl(inst.baseUrl, e.ref.key)));
    return true;
  }

  /** Команда `jiraffe.downloadAttachment({instanceId, key, id})`: вложение открытой карточки. */
  downloadAttachment(ref: IssueRef, id: string): boolean {
    const e = this.find(ref);
    if (!e?.card || !isAttachmentId(id)) return false;
    void this.withAttachments(e, (ctx) => this.attachments.download(ctx, id));
    return true;
  }

  private find(ref: IssueRef): Entry | undefined {
    return this.pinned.get(idOf(ref)) ?? (this.preview && idOf(this.preview.ref) === idOf(ref) ? this.preview : undefined);
  }

  private pinEntry(e: Entry): void {
    if (e.pinned) return;
    e.pinned = true;
    if (this.preview === e) this.preview = undefined;
    this.pinned.set(idOf(e.ref), e);
    this.render(e);
  }

  private create(ref: IssueRef): Entry {
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const panel = vscode.window.createWebviewPanel('jiraffe.issue', ref.key, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [root],
    });
    const nonce = makeNonce();
    panel.webview.html = renderShell({
      cspSource: panel.webview.cspSource,
      nonce,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'issue.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'common.css')).toString(),
      title: ref.key,
    });
    const e: Entry = { panel, ref, files: [], inlineUrls: [], tab: 'desc', pinned: false, ready: false, seq: 0, disposed: false };
    panel.webview.onDidReceiveMessage((m: ViewToHost) => this.onMessage(e, m));
    panel.onDidChangeViewState(() => {
      if (panel.active) this.active = e;
      else if (this.active === e) this.active = undefined;
    });
    panel.onDidDispose(() => {
      e.disposed = true;
      if (this.preview === e) this.preview = undefined;
      if (this.active === e) this.active = undefined;
      if (this.pinned.get(idOf(e.ref)) === e) this.pinned.delete(idOf(e.ref));
    });
    this.active = e;
    return e;
  }

  private async load(e: Entry): Promise<void> {
    const seq = ++e.seq;
    const ref = e.ref;
    e.error = undefined; // «Повторить» сразу показывает загрузку, а не прежнюю ошибку
    this.render(e); // без card — «загрузка», с card — старые данные, пока не придут новые
    try {
      const inst = this.store.get(ref.instanceId);
      if (!inst) throw new Error('инстанс удалён — добавьте его заново');
      const loaded = await loadCard(await this.meta.client(inst), inst, ref.key);
      if (e.disposed || e.seq !== seq) return;
      e.card = loaded.card;
      e.files = loaded.files;
      e.inlineUrls = loaded.inlineUrls;
      e.error = undefined;
    } catch (err) {
      if (e.disposed || e.seq !== seq) return;
      e.card = undefined;
      e.files = [];
      e.inlineUrls = [];
      e.error = errText(err);
    }
    this.render(e);
  }

  private render(e: Entry): void {
    if (e.disposed || !e.ready) return;
    let msg: HostToView;
    const { instanceId, key } = e.ref;
    if (e.error) msg = { type: 'error', instanceId, key, message: e.error };
    else if (e.card) msg = { type: 'issue', data: { ...e.card, pinned: e.pinned, tab: e.tab } };
    else msg = { type: 'loading', instanceId, key };
    void e.panel.webview.postMessage(msg);
  }

  private onMessage(e: Entry, m: ViewToHost): void {
    if (!m || typeof m !== 'object') return;
    const ref = e.ref;
    // Действие из устаревшего вида (preview уже переключили на другую задачу) не должно попасть в новую.
    if (CARD_ACTIONS.has(m.type) && (m as { key?: unknown }).key !== ref.key) return;
    if (ATTACHMENT_ACTIONS.has(m.type)) {
      const a = m as { instanceId?: unknown; key?: unknown };
      if (a.instanceId !== ref.instanceId || a.key !== ref.key || !e.card) return;
    }
    switch (m.type) {
      case 'ready':
        e.ready = true;
        this.render(e);
        break;
      case 'switchTab':
        if (ISSUE_TABS.includes(m.tab)) e.tab = m.tab;
        break;
      case 'pin':
        this.pinEntry(e);
        break;
      case 'copyKey':
        this.copyKey(ref);
        break;
      case 'openInBrowser':
        this.openInBrowser(ref);
        break;
      case 'openIssue':
        if (isIssueKey(m.key)) this.open({ instanceId: ref.instanceId, key: m.key });
        break;
      case 'openEpic':
        if (isIssueKey(m.key)) void vscode.commands.executeCommand('jiraffe.openEpic', { instanceId: ref.instanceId, key: m.key });
        break;
      case 'openRelease':
        if (isVersionId(m.id)) void vscode.commands.executeCommand('jiraffe.openRelease', { instanceId: ref.instanceId, id: m.id });
        break;
      case 'logWork':
        void vscode.commands.executeCommand('jiraffe.logWork', ref);
        break;
      case 'openExternal':
        openExternal(m.url);
        break;
      case 'loadImages':
        if (Array.isArray(m.ids)) this.loadImages(e, m.ids.slice(0, MAX_IMAGE_IDS).filter(isImageId));
        break;
      case 'downloadAttachment':
        if (isAttachmentId(m.id)) void this.withAttachments(e, (ctx) => this.attachments.download(ctx, m.id));
        break;
      case 'openAttachment':
        if (isAttachmentId(m.id)) void this.withAttachments(e, (ctx) => this.attachments.openInEditor(ctx, m.id));
        break;
      case 'downloadAll':
        void this.withAttachments(e, (ctx) => this.attachments.downloadAll(ctx));
        break;
    }
  }

  /** Контекст вложений текущей карточки (снимок: смена задачи в preview на уже начатое скачивание не влияет). */
  private async withAttachments(e: Entry, fn: (ctx: AttachmentContext) => Promise<void>): Promise<void> {
    const inst = this.store.get(e.ref.instanceId);
    if (!inst || !e.card) return;
    const seq = e.seq;
    try {
      const client = await this.meta.client(inst);
      await fn({ inst, client, key: e.ref.key, files: e.files, inlineUrls: e.inlineUrls, alive: () => !e.disposed && e.seq === seq });
    } catch (err) {
      void vscode.window.showErrorMessage(`Jiraffe: ${noticeText(errText(err))}`);
    }
  }

  /** Картинки уходят в webview по одной, по мере скачивания; ответ для устаревшей карточки (seq) отбрасывается. */
  private loadImages(e: Entry, ids: string[]): void {
    const seq = e.seq;
    const { instanceId, key } = e.ref;
    void this.withAttachments(e, async (ctx) => {
      await Promise.all([...new Set(ids)].map(async (id) => {
        const r = await this.attachments.image(ctx, id);
        if (e.disposed || e.seq !== seq || !e.ready) return;
        const msg: HostToView = { type: 'attachmentPreview', instanceId, key, id, ...r };
        void e.panel.webview.postMessage(msg);
      }));
    });
  }
}

/** Из webview открываем только http(s) и mailto: остальное (javascript:, file:, vscode:) отбрасываем. */
export function openExternal(url: unknown): void {
  const safe = safeExternalUrl(url);
  if (safe) void vscode.env.openExternal(vscode.Uri.parse(safe));
}
