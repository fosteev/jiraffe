// Читает бандл локализации, который хост положил в каркас (renderShell). Импортировать ПЕРВЫМ в каждом webview-входе.
import { setL10n } from '../src/l10n';

try {
  const raw = document.getElementById('jiraffe-l10n')?.textContent;
  const o = raw ? (JSON.parse(raw) as { bundle?: Record<string, string>; locale?: string }) : {};
  setL10n(o.bundle, o.locale ?? 'en');
} catch {
  setL10n(undefined, 'en');
}
