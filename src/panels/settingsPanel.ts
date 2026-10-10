import * as vscode from 'vscode';
import { getBundle, locale, t } from '../l10n';
import type { IssueSort } from '../jql';
import { makeNonce, renderShell } from './html';
import { parseSettingsMessage, type HostToSettings, type SettingsMessage } from './protocol';
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

  constructor(private readonly extensionUri: vscode.Uri, private readonly issues: IssueViewSettings) {
    this.subs = [
      vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(SECTION)) this.render(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.render()),
      issues.onDidChangeView(() => this.render()),
    ];
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.entry?.panel.dispose();
  }

  /** Открыть вкладку или показать уже открытую; `section` — прокрутить к разделу. */
  open(section?: SectionId): void {
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
    return buildSettingsState({
      maxResults: cfg.inspect<number>('maxResults'),
      attachmentsDir: cfg.inspect<string>('attachmentsDir'),
      maxImageMb: cfg.inspect<number>('maxImageMb'),
      workdayHours: cfg.inspect<number>('workdayHours'),
      sort: this.issues.sort,
      grouped: this.issues.grouped,
      hasWorkspace: this.workspaceDir() !== undefined,
    });
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
    }
  }

  private async apply(s: SettingValue): Promise<void> {
    switch (s.id) {
      case 'sort': this.issues.setSort(s.value); return;
      case 'grouped': this.issues.setGrouped(s.value); return;
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
    else await this.write(id, undefined);
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
