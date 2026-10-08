import * as vscode from 'vscode';
import { noticeText } from '../jira/attachments';
import { localDate } from '../jira/worklog';
import type { LogWorkPanels, WorklogService } from '../commands/logWork';
import type { Attachment } from '../jira/types';
import type { InstanceStore } from '../state/instances';
import type { InstanceMeta } from '../state/meta';
import type { IssueRef } from '../views/issuesTree';
import type { AttachmentContext, AttachmentService } from './attachments';
import { askMenu, issueContext, parseTaskSessions, taskMeta, type AskEntry, type TaskSession } from './aiContext';
import { browseUrl, loadCard } from './card';
import { getBundle, locale, t } from '../l10n';
import { makeNonce, renderShell } from './html';
import {
  ISSUE_TABS, isAttachmentId, isImageId, isIssueKey, isVersionId, MAX_IMAGE_IDS, safeExternalUrl, type HostToView, type IssueCard, type IssueTab, type LogFormView, type ViewToHost,
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
  /** Диалог «Залогать время», который ещё не доставлен в webview (вкладка была скрыта и перезагружается). */
  pendingForm?: { key: string; form: LogFormView };
}

/** Действия над показанной задачей: принимаются, только если ключ в сообщении совпадает с текущим. */
const CARD_ACTIONS = new Set<ViewToHost['type']>(['openInBrowser', 'copyKey', 'logWork', 'transition', 'pin', 'switchTab', 'askAi']);
/** Вложения и картинки: и instanceId, и key должны совпасть с показанной задачей, карточка — загружена. */
const ATTACHMENT_ACTIONS = new Set<ViewToHost['type']>(['loadImages', 'downloadAttachment', 'downloadAll', 'openAttachment', 'submitWorklog']);
/** ИИ-чат: расширение Agentura (не на Marketplace — нет его, нет и кнопки). */
const AGENTURA = 'fosteev.agentura';
const idOf = (r: IssueRef): string => `${r.instanceId}\n${r.key}`;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const isIssueRef = (v: unknown): v is IssueRef =>
  !!v && typeof v === 'object' && typeof (v as IssueRef).instanceId === 'string' && typeof (v as IssueRef).key === 'string';

/**
 * Карточки задач: одна preview-вкладка (новая задача открывается в ней же) и закреплённые (по одной на задачу).
 * `retainContextWhenHidden: false`: скрытая вкладка выгружается, при показе webview шлёт `ready`, и мы отдаём
 * сохранённое состояние (данные и выбранная вкладка живут здесь, в хосте).
 */
export class IssuePanelManager implements vscode.Disposable, LogWorkPanels {
  private preview: Entry | undefined;
  private readonly pinned = new Map<string, Entry>();
  private active: Entry | undefined;
  /** Agentura поставили или удалили — перерисовать карточки (кнопка «Спросить ИИ»). */
  private readonly extWatch = vscode.extensions.onDidChange(() => {
    for (const e of [this.preview, ...this.pinned.values()]) if (e?.card) this.render(e);
  });

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: InstanceStore,
    private readonly meta: InstanceMeta,
    private readonly attachments: AttachmentService,
    private readonly worklog: WorklogService,
  ) {}

  dispose(): void {
    this.extWatch.dispose();
    for (const e of [this.preview, ...this.pinned.values()]) e?.panel.dispose();
  }

  /**
   * Открыть задачу: закреплённая — фокус, иначе — в preview (создаётся при необходимости).
   * `beside` (API): новая вкладка — в соседней колонке; уже видимая остаётся на месте, скрытая (под другой вкладкой) — переезжает рядом.
   */
  open(ref: IssueRef, beside = false): void {
    const colFor = (p: vscode.WebviewPanel): vscode.ViewColumn | undefined => (beside && !p.visible ? vscode.ViewColumn.Beside : undefined);
    const pinned = this.pinned.get(idOf(ref));
    if (pinned) {
      pinned.panel.reveal(colFor(pinned.panel), false);
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
        this.preview.pendingForm = undefined;
        this.preview.tab = 'desc';
        this.preview.panel.title = ref.key;
      }
      this.preview.panel.reveal(colFor(this.preview.panel), false);
      void this.load(this.preview);
      return;
    }
    this.preview = this.create(ref, beside);
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
    void vscode.env.clipboard.writeText(e.ref.key).then(() => vscode.window.setStatusBarMessage(t('Jiraffe: key {0} copied', e.ref.key), 2500));
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

  /** Задача активной карточки (или preview) — для `jiraffe.logWork` без аргумента. */
  activeRef(): IssueRef | undefined {
    return (this.active ?? this.preview)?.ref;
  }

  /**
   * Диалог «Залогать время» в карточке задачи, если она открыта и загружена (вкладка выводится на передний план).
   * Нет карточки — false: команда покажет QuickInput.
   */
  async showLogForm(ref: IssueRef): Promise<boolean> {
    const e = this.find(ref);
    const inst = this.store.get(ref.instanceId);
    if (!e?.card || !inst) return false;
    let form: LogFormView;
    try {
      form = { ...(await this.worklog.form(inst)), instanceName: inst.name, summary: e.card.issue.summary, today: localDate() };
    } catch (err) {
      void vscode.window.showErrorMessage(`Jiraffe: ${noticeText(errText(err))}`);
      return true;
    }
    if (e.disposed || e.ref.key !== ref.key || !e.card) return false;
    e.pendingForm = { key: ref.key, form };
    e.panel.reveal(undefined, false);
    this.flushForm(e);
    return true;
  }

  /** Перечитать открытые карточки задачи (после записи времени). */
  reload(ref: IssueRef): void {
    const e = this.find(ref);
    if (e && !e.disposed) void this.load(e);
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

  private create(ref: IssueRef, beside = false): Entry {
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const panel = vscode.window.createWebviewPanel('jiraffe.issue', ref.key, { viewColumn: beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, preserveFocus: false }, {
      enableScripts: true,
      enableFindWidget: true,
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
      l10n: { bundle: getBundle(), locale: locale() },
    });
    const e: Entry = { panel, ref, files: [], inlineUrls: [], tab: 'desc', pinned: false, ready: false, seq: 0, disposed: false };
    panel.webview.onDidReceiveMessage((m: ViewToHost) => this.onMessage(e, m));
    panel.onDidChangeViewState(() => {
      // Скрытый webview (retainContextWhenHidden: false) выгружается: до нового `ready` сообщения ему не шлём.
      if (!panel.visible) e.ready = false;
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
      if (!inst) throw new Error(t('instance removed — add it again'));
      const loaded = await loadCard(await this.meta.client(inst), inst, ref.key, () => this.meta.workAttributes(inst));
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
    else if (e.card) msg = { type: 'issue', data: { ...e.card, pinned: e.pinned, tab: e.tab, ai: !!vscode.extensions.getExtension(AGENTURA) } };
    else msg = { type: 'loading', instanceId, key };
    void e.panel.webview.postMessage(msg);
    if (msg.type === 'issue') this.flushForm(e);
  }

  /** Диалог уходит после карточки и только в видимый webview (скрытый без retainContext сообщения теряет — дождёмся `ready`). */
  private flushForm(e: Entry): void {
    const p = e.pendingForm;
    if (!p || e.disposed || !e.ready || !e.card || !e.panel.visible) return;
    e.pendingForm = undefined;
    if (p.key !== e.ref.key) return;
    const msg: HostToView = { type: 'logForm', instanceId: e.ref.instanceId, key: e.ref.key, form: p.form };
    void e.panel.webview.postMessage(msg);
  }

  /**
   * «Открыть в Agentura»: задача в контексте (файл), ссылка на неё в поле ввода, чат входит в группу задачи.
   * Чаты задачи спрашиваем у Agentura (`agentura.taskSessions`): есть — меню «Продолжить / другие / новый», нет — сразу новый.
   * Команды нет или она упала (старая Agentura) — как раньше: `sessionKey` возобновляет единственный чат задачи.
   */
  private async askAi(e: Entry): Promise<void> {
    const ext = vscode.extensions.getExtension(AGENTURA);
    const inst = this.store.get(e.ref.instanceId);
    if (!ext || !inst || !e.card) return;
    const { instanceId, key } = e.ref;
    const card = e.card;
    try {
      if (!ext.isActive) await ext.activate(); // команда служебная: без активации её ещё нет
      const url = browseUrl(inst.baseUrl, key);
      let session: string | undefined; // не задан — старое поведение (по sessionKey)
      let sessions: TaskSession[] | undefined;
      try {
        sessions = parseTaskSessions(await vscode.commands.executeCommand('agentura.taskSessions', { instanceId, key }));
      } catch {
        sessions = undefined; // нет команды / ошибка — не мешаем открыть чат
      }
      if (sessions) {
        const menu = askMenu(sessions);
        if (!menu) session = 'new';
        else {
          const picked = await this.pickChat(menu);
          if (!picked) return; // меню закрыли
          session = picked.kind === 'new' ? 'new' : picked.session.id;
        }
      }
      await vscode.commands.executeCommand('agentura.openWithContext', {
        name: `${key}.md`,
        context: issueContext(card, url),
        prompt: `${url} `, // в поле ввода — ссылка на задачу, дальше пишется вопрос
        sessionKey: `jiraffe:${instanceId}:${key}`, // для Agentura 0.8.0 (одна сессия на ключ)
        task: taskMeta(card, instanceId, url),
        ...(session ? { session } : {}),
      });
    } catch (err) {
      void vscode.window.showErrorMessage(t('Jiraffe: could not open the AI chat: {0}', errText(err)));
    }
  }

  private async pickChat(menu: AskEntry[]): Promise<AskEntry | undefined> {
    type Item = vscode.QuickPickItem & { entry?: AskEntry };
    const items: Item[] = [];
    for (const entry of menu) {
      if (entry.kind === 'new') {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: `$(add) ${t('New chat for this issue')}`, entry });
        continue;
      }
      const s = entry.session;
      const title = (s.title || s.id).replace(/\$\(/g, '$\u200b('); // `$(icon)` в подписи QuickPick — иконка; чужой текст не должен её рисовать
      items.push({
        label: entry.kind === 'continue' ? `$(comment-discussion) ${t('Continue: {0}', title)}` : `$(comment) ${title}`,
        description: [s.provider, s.live ? t('running') : ''].filter(Boolean).join(' · '),
        detail: s.updatedAt && Number.isFinite(new Date(s.updatedAt).getTime()) ? new Date(s.updatedAt).toLocaleString(locale()) : undefined,
        entry,
      });
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: t('Open in Agentura') });
    return pick?.entry;
  }

  private async submitWorklog(e: Entry, draft: unknown): Promise<void> {
    const ref = { ...e.ref };
    const r = await this.worklog.submit(ref, draft);
    if (e.disposed) return;
    const msg: HostToView = { type: 'logResult', instanceId: ref.instanceId, key: ref.key, ...r };
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
      case 'askAi':
        void this.askAi(e);
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
      case 'transition':
        void vscode.commands.executeCommand('jiraffe.transition', ref);
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
      case 'submitWorklog':
        void this.submitWorklog(e, m.draft);
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
