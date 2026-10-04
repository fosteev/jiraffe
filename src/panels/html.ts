// Каркас HTML для webview: строгий CSP, скрипты только с nonce. Чистая функция — тестируется без vscode.
import { randomBytes } from 'node:crypto';

export interface ShellOptions {
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
  title: string;
}

export const makeNonce = (): string => randomBytes(16).toString('base64url');

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function csp(cspSource: string, nonce: string): string {
  return `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource}; script-src 'nonce-${nonce}'`;
}

export function renderShell(o: ShellOptions): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(csp(o.cspSource, o.nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<link rel="stylesheet" href="${esc(o.styleUri)}">
</head>
<body>
<div id="app" class="loading-note">Загрузка…</div>
<script nonce="${o.nonce}" src="${esc(o.scriptUri)}"></script>
</body>
</html>`;
}
