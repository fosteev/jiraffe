import * as vscode from 'vscode';
import { AGENTURA } from '../agentura';
import { API_ALLOW_WRITES, API_ENABLED, API_SECTION } from '../apiAccess';
import { createJiraClient } from '../jira/client';
import { detectCapabilities } from '../jira/capabilities';
import type { Instance } from '../jira/types';
import { getBundle, locale, t } from '../l10n';
import type { IssueSort } from '../jql';
import { readScope } from '../commands/instances';
import type { ApiActivity } from '../state/apiActivity';
import { inScope, type InstanceStore } from '../state/instances';
import { ConnectionStatus, connectionErrorText, instanceIdentity, instanceSnapshot, planScopeWrite } from './connectionStatus';
import { makeNonce, renderShell } from './html';
import { parseSettingsMessage, type HostToSettings, type InstanceAction, type SettingsMessage } from './protocol';
import {
  buildSettingsState, type NumberId, type SectionId, type SettingId, type SettingValue, type WriteTarget,
} from './settingsModel';
import { isAbsoluteDir, relativeInside } from './settingsPaths';

/** Что вкладке нужно от дерева задач: сортировка и группировка лежат в его globalState. */
export interface IssueViewSettings {
  readonly sort: IssueSort | undefined;
  readonly grouped: boolean;
  setSort(v: IssueSort | undefined): void;
  setGrouped(v: boolean): void;
  readonly onDidChangeView: vscode.Event<void>;
}

const SECTION = 'jiraffe';
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const TARGETS: Record<WriteTarget, vscode.ConfigurationTarget> = {
  workspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder,
  workspace: vscode.ConfigurationTarget.Workspace,
  global: vscode.ConfigurationTarget.Global,
};

/**
 * Вкладка «Настройки Jiraffe»: одна на окно. Источник правды не webview: значения лежат в settings.json (`inspect`-уровень),
 * сортировка и группировка — в globalState дерева. Webview показывает состояние и шлёт намерения; хост пишет и перерисовывает
 * вкладку по событиям (`onDidChangeConfiguration`, смена сортировки, смена папок).
 */
export class SettingsPanel implements vscode.Disposable {
  private entry?: { panel: vscode.WebviewPanel; ready: boolean; section?: SectionId };
  private readonly subs: vscode.Disposable[];

  private readonly status: ConnectionStatus;
  /** Инстансы, над которыми сейчас идёт диалог/запрос (переименовать, сменить токен, отключить, обновить возможности): повторное действие игнорируем. */
  private readonly busy = new Set<string>();
  /** Почему новый токен не сохранён (в памяти, до следующей попытки или замены записи инстанса — повторное «Подключить»). */
  private readonly tokenErrors = new Map<string, string>();
  private scopeQueue: Promise<void> = Promise.resolve();
  /** `instanceSnapshot` по id на момент последнего события store: замена записи под тем же id (повторное «Подключить»,
   *  обновлённые caps) требует перепроверки, хотя статус у id уже есть. */
  private snaps = new Map<string, string>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly issues: IssueViewSettings,
    private readonly store: InstanceStore,
    /** «Последняя запись через API»: память хоста, её пишет `changed` публичного API (extension.ts). */
    private readonly activity: ApiActivity,
  ) {
    this.status = new ConnectionStatus((id) => this.store.get(id) !== undefined, () => this.render());
    this.snaps = new Map(store.all().map((i) => [i.id, instanceSnapshot(i)]));
    this.subs = [
      store.onDidChange(() => {
        const next = new Map(store.all().map((i) => [i.id, instanceSnapshot(i)]));
        for (const [id, s] of next) {
          if (this.snaps.has(id) && this.snaps.get(id) !== s) {
            this.status.forget(id);
            this.tokenErrors.delete(id);
          }
        }
        this.snaps = next;
        this.status.prune();
        for (const id of [...this.tokenErrors.keys()]) if (!store.get(id)) this.tokenErrors.delete(id);
        if (this.entry) this.checkMissing();
        this.render();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(SECTION)) this.render(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.render()),
      issues.onDidChangeView(() => this.render()),
      // Agentura поставили или удалили; пришла запись через API.
      vscode.extensions.onDidChange(() => this.render()),
      activity.onDidChange(() => this.render()),
    ];
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.entry?.panel.dispose();
  }

  /** Открыть вкладку или показать уже открытую; `section` — прокрутить к разделу. */
  open(section?: SectionId): void {
    this.checkAll();
    if (this.entry) {
      this.entry.panel.reveal(undefined, false);
      if (section) {
        // Готовая вкладка прокручивается сразу; выгруженная — по своему `ready` (одноразово, см. onMessage).
        if (this.entry.ready) this.post({ type: 'scroll', section });
        else this.entry.section = section;
      }
      this.render();
      return;
    }
    this.entry = this.create();
    this.entry.section = section;
  }

  private create(): NonNullable<SettingsPanel['entry']> {
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const panel = vscode.window.createWebviewPanel('jiraffe.settings', t('Jiraffe Settings'), { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, {
      enableScripts: true,
      enableFindWidget: true,
      retainContextWhenHidden: false,
      localResourceRoots: [root],
    });
    panel.webview.html = renderShell({
      cspSource: panel.webview.cspSource,
      nonce: makeNonce(),
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'settings.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'common.css')).toString(),
      title: t('Jiraffe Settings'),
      l10n: { bundle: getBundle(), locale: locale() },
    });
    const e = { panel, ready: false, section: undefined as SectionId | undefined };
    panel.webview.onDidReceiveMessage((m: unknown) => { void this.onMessage(parseSettingsMessage(m)); });
    panel.onDidChangeViewState(() => {
      if (!panel.visible) e.ready = false; // выгруженный webview пришлёт новый `ready`
    });
    panel.onDidDispose(() => { if (this.entry === e) this.entry = undefined; });
    return e;
  }

  private post(m: HostToSettings): void {
    if (this.entry?.ready) void this.entry.panel.webview.postMessage(m);
  }

  private render(): void {
    if (!this.entry?.ready) return;
    this.post({ type: 'state', state: this.state() });
  }

  private state(): ReturnType<typeof buildSettingsState> {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    const api = vscode.workspace.getConfiguration(API_SECTION);
    const scope = readScope();
    return buildSettingsState({
      maxResults: cfg.inspect<number>('maxResults'),
      attachmentsDir: cfg.inspect<string>('attachmentsDir'),
      maxImageMb: cfg.inspect<number>('maxImageMb'),
      workdayHours: cfg.inspect<number>('workdayHours'),
      sort: this.issues.sort,
      grouped: this.issues.grouped,
      hasWorkspace: this.workspaceDir() !== undefined,
      canScope: !!vscode.workspace.workspaceFolders?.length,
      scopeSet: scope !== undefined,
      instances: this.store.all().map((inst) => ({
        inst, status: this.status.get(inst.id), inScope: inScope(inst, scope), tokenError: this.tokenErrors.get(inst.id),
      })),
      apiEnabled: api.inspect<unknown>(API_ENABLED),
      apiAllowWrites: api.inspect<unknown>(API_ALLOW_WRITES),
      agentura: !!vscode.extensions.getExtension(AGENTURA),
      lastApiWrite: this.activity.get(),
    });
  }

  private async client(inst: Instance, token?: string) {
    const tk = token ?? (await this.store.getToken(inst.id));
    if (!tk) throw new Error(t('token not found in SecretStorage — add the instance again'));
    return createJiraClient(inst, tk);
  }

  /** `myself()` напрямую клиентом (мимо кэша `InstanceMeta`): статус всегда свежий. */
  private checkOne(id: string): Promise<void> {
    const inst = this.store.get(id);
    if (!inst) return Promise.resolve();
    return this.status.check(id, async () => (await this.client(inst)).myself());
  }

  private checkAll(): void {
    for (const i of this.store.all()) void this.checkOne(i.id);
  }

  private checkMissing(): void {
    for (const i of this.store.all()) if (!this.status.has(i.id)) void this.checkOne(i.id);
  }

  private workspaceDir(): string | undefined {
    return vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri.fsPath;
  }

  private async onMessage(m: SettingsMessage | undefined): Promise<void> {
    if (!m) return;
    switch (m.type) {
      case 'ready': {
        if (!this.entry) return;
        this.entry.ready = true;
        this.checkMissing();
        this.render();
        if (this.entry.section) {
          this.post({ type: 'scroll', section: this.entry.section });
          this.entry.section = undefined; // одноразово: при перезагрузке скрытой вкладки не прыгать снова
        }
        return;
      }
      case 'invalid':
        void vscode.window.showWarningMessage(`Jiraffe: ${m.error}`);
        this.render();
        return;
      case 'set':
        await this.apply(m.setting);
        this.render();
        return;
      case 'reset':
        await this.reset(m.id);
        this.render();
        return;
      case 'pickDir':
        await this.pickDir();
        this.render();
        return;
      case 'openJson':
        void vscode.commands.executeCommand('workbench.action.openSettingsJson');
        return;
      case 'addInstance':
        void vscode.commands.executeCommand('jiraffe.addInstance');
        return;
      case 'instance':
        await this.instanceAction(m.action, m.id);
        this.render();
        return;
      case 'scopeMode':
      case 'scopeToggle':
        await this.enqueueScope(m);
        this.render();
        return;
    }
  }

  // ----- подключения -----

  private async instanceAction(action: InstanceAction, id: string): Promise<void> {
    const inst = this.store.get(id);
    if (!inst) return;
    if (action === 'check') {
      void this.checkOne(id);
      return;
    }
    if (this.busy.has(id)) return;
    this.busy.add(id);
    try {
      switch (action) {
        case 'refreshCaps': await this.refreshCaps(inst); return;
        case 'rename': await this.rename(inst); return;
        case 'setToken': await this.changeToken(inst); return;
        case 'remove': await this.remove(inst); return;
      }
    } finally {
      this.busy.delete(id);
    }
  }

  private async refreshCaps(inst: Instance): Promise<void> {
    try {
      const client = await this.client(inst);
      const caps = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('Jiraffe: “{0}” — detecting capabilities…', inst.name) },
        () => detectCapabilities(client),
      );
      // Пока шёл запрос, инстанс могли отключить или подключить заново с другим адресом/email — чужие caps не пишем.
      const now = this.store.get(inst.id);
      if (now && instanceIdentity(now) === instanceIdentity(inst)) await this.store.updateCaps(inst.id, caps);
    } catch (e) {
      void vscode.window.showErrorMessage(`Jiraffe: «${inst.name}» — ${connectionErrorText(e)}`);
    }
  }

  private async rename(inst: Instance): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: t('Rename instance'), prompt: t('The name is shown in the tree, the status bar and cards.'), value: inst.name, ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : t('The name is empty')),
    });
    if (name === undefined || !name.trim() || name.trim() === inst.name) return;
    await this.store.rename(inst.id, name);
  }

  /** Новый токен сохраняется только после успешного `myself()` с ним; при отказе остаётся старый, причина — в карточке. */
  private async changeToken(inst: Instance): Promise<void> {
    const token = await vscode.window.showInputBox({
      title: t('Change token: {0}', inst.name),
      prompt: inst.kind === 'cloud' ? t('Atlassian API token') : 'Personal Access Token',
      password: true, ignoreFocusOut: true,
      validateInput: (v) => (!v.trim() ? t('The token is empty') : /^[\x21-\x7e]+$/.test(v.trim()) ? undefined : t('The token contains spaces or unexpected characters')),
    });
    if (!token?.trim()) return;
    this.tokenErrors.delete(inst.id);
    try {
      const client = await this.client(inst, token.trim());
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('Jiraffe: connecting to {0}…', inst.baseUrl) },
        () => client.myself(),
      );
    } catch (e) {
      const msg = connectionErrorText(e);
      if (this.store.get(inst.id)) this.tokenErrors.set(inst.id, msg);
      void vscode.window.showErrorMessage(`Jiraffe: «${inst.name}» — ${t('the new token was not saved')}: ${msg}`);
      return;
    }
    // Токен проверен на этом адресе/типе/email; если запись за время проверки заменили на другую — не пишем.
    const now = this.store.get(inst.id);
    if (!now || instanceIdentity(now) !== instanceIdentity(inst)) return;
    if (await this.store.setToken(inst.id, token)) void this.checkOne(inst.id);
  }

  private async remove(inst: Instance): Promise<void> {
    const ok = await vscode.window.showWarningMessage(t('Remove instance “{0}” and its token?', inst.name), { modal: true }, t('Remove'));
    if (ok !== t('Remove')) return;
    await this.store.remove(inst.id);
    this.status.forget(inst.id);
    this.tokenErrors.delete(inst.id);
  }

  // ----- набор workspace (`jiraffe.instances`, только уровень Workspace) -----

  /** Записи набора идут по очереди: два быстрых щелчка не должны прочитать устаревший набор. */
  private enqueueScope(m: Extract<SettingsMessage, { type: 'scopeMode' | 'scopeToggle' }>): Promise<void> {
    const run = this.scopeQueue.then(() => this.writeScope(m));
    this.scopeQueue = run.catch(() => undefined);
    return run;
  }

  private async writeScope(m: Extract<SettingsMessage, { type: 'scopeMode' | 'scopeToggle' }>): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
      void vscode.window.showInformationMessage(t('Jiraffe: open a folder or workspace — the set of instances is stored in its settings'));
      return;
    }
    const g = vscode.workspace.getConfiguration(SECTION).inspect<unknown>('instances')?.globalValue;
    const plan = planScopeWrite(m, readScope(), g, this.store.all());
    if (plan.kind === 'skip') return;
    if (plan.kind === 'empty') {
      void vscode.window.showWarningMessage(t('Jiraffe: at least one instance is required'));
      return;
    }
    try {
      await vscode.workspace.getConfiguration(SECTION).update('instances', plan.value, vscode.ConfigurationTarget.Workspace);
    } catch (e) {
      void vscode.window.showErrorMessage(`Jiraffe: ${t('Could not save the setting: {0}', errText(e))}`);
    }
  }

  private async apply(s: SettingValue): Promise<void> {
    switch (s.id) {
      case 'sort': this.issues.setSort(s.value); return;
      case 'grouped': this.issues.setGrouped(s.value); return;
      case 'apiEnabled': await this.writeApi(API_ENABLED, s.value); return;
      case 'apiAllowWrites': await this.writeApi(API_ALLOW_WRITES, s.value); return;
      case 'attachmentsDir':
        if (s.value === undefined) await this.reset('attachmentsDir');
        else await this.write('attachmentsDir', s.value);
        return;
      default: await this.write(s.id, s.value);
    }
  }

  private async reset(id: SettingId): Promise<void> {
    if (id === 'sort') this.issues.setSort(undefined);
    else if (id === 'grouped') this.issues.setGrouped(false);
    else if (id === 'apiEnabled') await this.writeApi(API_ENABLED, undefined);
    else if (id === 'apiAllowWrites') await this.writeApi(API_ALLOW_WRITES, undefined);
    else await this.write(id, undefined);
  }

  /**
   * Переключатели публичного API: настройки уровня application, поэтому только в пользовательские (Global) —
   * workspace их не принимает, и проект не может включить доступ обратно. `undefined` — сброс к стандартному (включено).
   */
  private async writeApi(key: typeof API_ENABLED | typeof API_ALLOW_WRITES, value: boolean | undefined): Promise<void> {
    try {
      await vscode.workspace.getConfiguration(API_SECTION).update(key, value, vscode.ConfigurationTarget.Global);
    } catch (e) {
      void vscode.window.showErrorMessage(`Jiraffe: ${t('Could not save the setting: {0}', errText(e))}`);
    }
  }

  /** Пишет в уровень, откуда сейчас берётся значение (workspaceFolder › workspace), иначе в Global; `undefined` — сброс. */
  private async write(key: NumberId | 'attachmentsDir', value: number | string | undefined): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    const ins = cfg.inspect<unknown>(key);
    const target: WriteTarget = ins?.workspaceFolderValue !== undefined ? 'workspaceFolder' : ins?.workspaceValue !== undefined ? 'workspace' : 'global';
    // Абсолютный путь в .vscode/settings.json чужого репо — это путь «наружу» от его имени: только в пользовательские настройки.
    if (key === 'attachmentsDir' && typeof value === 'string' && isAbsoluteDir(value) && target !== 'global') {
      void vscode.window.showWarningMessage(`Jiraffe: ${t('An absolute path can only be set in user settings, but this value is stored in the workspace. Use a relative path or reset the value first.')}`);
      return;
    }
    try {
      await cfg.update(key, value, TARGETS[target]);
    } catch (e) {
      void vscode.window.showErrorMessage(`Jiraffe: ${t('Could not save the setting: {0}', errText(e))}`);
    }
  }

  /** «Выбрать…»: папка внутри первой папки workspace, в настройку пишется относительный путь. */
  private async pickDir(): Promise<void> {
    const ws = this.workspaceDir();
    if (!ws) {
      void vscode.window.showInformationMessage(`Jiraffe: ${t('Open a folder first: attachments are saved relative to it.')}`);
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: vscode.Uri.file(ws), openLabel: t('Select Folder'),
    });
    const dir = picked?.[0];
    if (!dir) return;
    const rel = relativeInside(ws, dir.fsPath);
    if (!rel) {
      void vscode.window.showWarningMessage(`Jiraffe: ${t('Choose a folder inside the workspace (not the workspace folder itself).')}`);
      return;
    }
    await this.write('attachmentsDir', rel);
  }
}
