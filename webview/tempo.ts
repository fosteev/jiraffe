// Webview раздела «Tempo»: рисует сводку «сегодня» (today.ts), шлёт действия в хост.
import './l10nInit';
import type { HostToTempo, TempoToHost } from '../src/panels/protocol';
import { renderToday } from './today';

declare function acquireVsCodeApi(): { postMessage(m: TempoToHost): void };
const vscode = acquireVsCodeApi();
const app = document.getElementById('app') as HTMLElement;

window.addEventListener('message', (ev: MessageEvent<HostToTempo>) => {
  const m = ev.data;
  if (m?.type !== 'today') return;
  app.className = 'tempo-view';
  app.innerHTML = renderToday(m.data);
  // Ширина полоски — через CSSOM: inline style запрещён CSP.
  for (const el of app.querySelectorAll<HTMLElement>('[data-w]')) el.style.width = `${el.dataset.w}%`;
});

function act(el: HTMLElement): void {
  switch (el.dataset.act) {
    case 'open':
      if (el.dataset.inst && el.dataset.key) vscode.postMessage({ type: 'openIssue', instanceId: el.dataset.inst, key: el.dataset.key });
      break;
    case 'logWork': vscode.postMessage({ type: 'logWork' }); break;
    case 'refresh': vscode.postMessage({ type: 'refresh' }); break;
    case 'addInstance': vscode.postMessage({ type: 'addInstance' }); break;
  }
}

app.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (el) act(el);
});
app.addEventListener('keydown', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('.row[data-act]');
  if (el && (ev.key === 'Enter' || ev.key === ' ')) {
    ev.preventDefault();
    act(el);
  }
});

vscode.postMessage({ type: 'ready' });
