// Строка состояния: «$(clock) Сегодня 3ч 15м / 8ч», клик — раздел Tempo.
import * as vscode from 'vscode';
import { t } from '../l10n';
import { statusBarLines, statusBarText, type TodayService } from '../state/today';
import type { InstanceStore } from '../state/instances';

export const workdaySec = (): number => {
  const h = vscode.workspace.getConfiguration('jiraffe').get<number>('workdayHours', 8);
  return Math.round((Number.isFinite(h) && h > 0 ? Math.min(h, 24) : 8) * 3600);
};

export class TodayStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('jiraffe.today', vscode.StatusBarAlignment.Left, 50);
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly today: TodayService,
    private readonly store: InstanceStore,
  ) {
    this.item.name = t('Jiraffe: Today');
    this.item.command = 'jiraffe.tempo.focus';
    const d = today.onDidChange(() => this.update());
    this.subs.push(
      { dispose: () => d.dispose() },
      vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('jiraffe.workdayHours')) this.update(); }),
    );
    this.update();
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.item.dispose();
  }

  update(): void {
    if (!this.store.list().length) {
      this.item.hide();
      return;
    }
    const s = this.today.get();
    this.item.text = statusBarText(s, workdaySec());
    // Обычная строка, не MarkdownString: имена инстансов и тексты ошибок — недоверенные.
    this.item.tooltip = [t('Jiraffe · today {0}', s.date), ...statusBarLines(s), '', t('Click to open the Tempo section')].join('\n');
    this.item.show();
  }
}
