// Раздел «Tempo» (WebviewView): блок «Сегодня» из прототипа (`renderTempo`), без недельной таблицы.
import * as vscode from 'vscode';
import { getBundle, locale } from '../l10n';
import { makeNonce, renderShell } from '../panels/html';
import { isIssueKey, type HostToTempo, type TempoToHost, type TodayView } from '../panels/protocol';
import type { InstanceStore } from '../state/instances';
import type { TodayService } from '../state/today';
import { workdaySec } from './statusBar';

export class TempoViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly today: TodayService,
    private readonly store: InstanceStore,
  ) {
    const d = today.onDidChange(() => this.post());
    this.subs.push(
      { dispose: () => d.dispose() },
      vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('jiraffe.workdayHours')) this.post(); }),
    );
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    view.webview.html = renderShell({
      cspSource: view.webview.cspSource,
      nonce: makeNonce(),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(root, 'tempo.js')).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(root, 'common.css')).toString(),
      title: 'Tempo',
      l10n: { bundle: getBundle(), locale: locale() },
    });
    view.webview.onDidReceiveMessage((m: TempoToHost) => this.onMessage(m));
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  private data(): TodayView {
    const s = this.today.get();
    return { date: s.date, loading: s.loading || !s.loaded, totalSec: s.totalSec, workdaySec: workdaySec(), noInstances: !this.store.list().length, instances: s.instances };
  }

  /** Скрытый view без retainContext сообщение теряет — при показе webview пришлёт `ready`, и мы отдадим данные заново. */
  private post(): void {
    const msg: HostToTempo = { type: 'today', data: this.data() };
    void this.view?.webview.postMessage(msg);
  }

  private onMessage(m: TempoToHost): void {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'ready':
        this.post();
        break;
      case 'openIssue':
        // Из webview — только известный инстанс и ключ по формату Jira.
        if (typeof m.instanceId === 'string' && this.store.get(m.instanceId) && isIssueKey(m.key)) {
          void vscode.commands.executeCommand('jiraffe.openIssue', { instanceId: m.instanceId, key: m.key });
        }
        break;
      case 'logWork':
        void vscode.commands.executeCommand('jiraffe.logWork');
        break;
      case 'refresh':
        void this.today.refresh();
        break;
      case 'addInstance':
        void vscode.commands.executeCommand('jiraffe.addInstance');
        break;
    }
  }
}
