import * as vscode from 'vscode';
import { createJiraClient } from '../jira/client';
import { detectCapabilities } from '../jira/capabilities';
import { canonicalBaseUrl } from '../jira/http';
import type { Instance, InstanceKind } from '../jira/types';
import { InstanceStore, inScope, instanceIdFromUrl } from '../state/instances';
import { t } from '../l10n';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const withProgress = <T>(title: string, task: () => Promise<T>): Thenable<T> =>
  vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);

const SCOPE_KEY = 'instances';
const config = () => vscode.workspace.getConfiguration('jiraffe');

/** Набор инстансов workspace из `jiraffe.instances`; не задан или пуст — undefined (видны все). */
export function readScope(): string[] | undefined {
  const v = config().get<unknown>(SCOPE_KEY);
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [];
  return list.length ? list : undefined;
}

/**
 * После добавления: набор workspace задан — новый инстанс дописываем в него (иначе он «пропал» бы); не задан,
 * а инстансов уже несколько — предлагаем оставить в этом workspace только новый.
 */
async function offerWorkspaceScope(store: InstanceStore, inst: Instance): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) return;
  const ws = config().inspect<unknown>(SCOPE_KEY)?.workspaceValue;
  if (Array.isArray(ws) && ws.length) {
    if (!ws.includes(inst.id)) await config().update(SCOPE_KEY, [...ws, inst.id], vscode.ConfigurationTarget.Workspace);
    return;
  }
  if (store.all().length < 2) return;
  const onlyThis = t('Only this one');
  const act = await vscode.window.showInformationMessage(
    t('Jiraffe: show only “{0}” in this workspace? Other instances stay in other windows.', inst.name),
    onlyThis, t('All instances'),
  );
  if (act === onlyThis) await config().update(SCOPE_KEY, [inst.id], vscode.ConfigurationTarget.Workspace);
}

const addButton = (): vscode.QuickInputButton => ({ iconPath: new vscode.ThemeIcon('add'), tooltip: t('Add Instance') });

async function scopeInstances(store: InstanceStore): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showInformationMessage(t('Jiraffe: open a folder or workspace — the set of instances is stored in its settings'));
    return;
  }
  const all = store.all();
  if (!all.length) {
    await vscode.commands.executeCommand('jiraffe.addInstance');
    return;
  }
  const scope = readScope();
  type Item = vscode.QuickPickItem & { id: string };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = t('Workspace Instances');
  qp.placeholder = t('Check the ones to show here (all checked means all); “+” adds a new connection');
  qp.canSelectMany = true;
  qp.buttons = [addButton()];
  qp.items = all.map((i) => ({ label: i.name, description: i.baseUrl, id: i.id }));
  qp.selectedItems = qp.items.filter((it) => inScope(all.find((i) => i.id === it.id)!, scope));
  const picked = await new Promise<readonly Item[] | 'add' | undefined>((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems));
    qp.onDidTriggerButton(() => resolve('add'));
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (picked === 'add') {
    await vscode.commands.executeCommand('jiraffe.addInstance');
    return;
  }
  if (!picked) return;
  if (!picked.length) {
    void vscode.window.showWarningMessage(t('Jiraffe: at least one instance is required'));
    return;
  }
  const value = picked.length === all.length ? undefined : picked.map((p) => p.id);
  await config().update(SCOPE_KEY, value, vscode.ConfigurationTarget.Workspace);
}

/** Управление подключениями — среди всех инстансов, не только этого workspace. */
async function pickInstance(store: InstanceStore, placeHolder: string, instanceId?: string): Promise<Instance | undefined> {
  const all = store.all();
  if (instanceId) {
    const known = store.get(instanceId);
    if (known) return known;
  }
  if (all.length === 0) {
    const act = await vscode.window.showInformationMessage(t('Jiraffe: no instances yet'), t('Add'));
    if (act) await vscode.commands.executeCommand('jiraffe.addInstance');
    return undefined;
  }
  if (all.length === 1) return all[0];
  const picked = await vscode.window.showQuickPick(
    all.map((i) => ({ label: i.name, description: i.baseUrl, instance: i })),
    { placeHolder },
  );
  return picked?.instance;
}

async function addInstance(store: InstanceStore): Promise<void> {
  const rawUrl = await vscode.window.showInputBox({
    title: t('New Jira Instance (1/5): URL'),
    prompt: t('URL with the context path, if any: https://host or https://host/jira'),
    ignoreFocusOut: true,
    validateInput: (v) => {
      try {
        const u = new URL(canonicalBaseUrl(v));
        return u.protocol === 'https:' || u.protocol === 'http:' ? undefined : t('An http(s) URL is required');
      } catch {
        return t('Doesn’t look like a URL');
      }
    },
  });
  if (!rawUrl) return;
  const baseUrl = canonicalBaseUrl(rawUrl);
  if (baseUrl.startsWith('http:') && (await vscode.window.showWarningMessage(
    t('{0}: the URL is not https — the token will be sent over the network in plain text. Continue?', baseUrl), { modal: true }, t('Continue'))) !== t('Continue')) return;
  const id = instanceIdFromUrl(baseUrl);
  if (store.get(id) && (await vscode.window.showWarningMessage(t('Instance {0} is already added. Replace?', id), { modal: true }, t('Replace'))) !== t('Replace')) return;

  const guess: InstanceKind = new URL(baseUrl).host.endsWith('.atlassian.net') ? 'cloud' : 'dc';
  const kinds = [
    { label: 'Server / Data Center', description: 'Bearer PAT', instKind: 'dc' as InstanceKind },
    { label: 'Cloud', description: t('email + API token'), instKind: 'cloud' as InstanceKind },
  ];
  const kindPick = await vscode.window.showQuickPick(
    kinds.sort((a, b) => Number(b.instKind === guess) - Number(a.instKind === guess)),
    { placeHolder: t('New Jira Instance (2/5): type'), ignoreFocusOut: true },
  );
  if (!kindPick) return;
  const kind = kindPick.instKind;

  let email: string | undefined;
  if (kind === 'cloud') {
    email = await vscode.window.showInputBox({
      title: t('New Jira Instance (3/5): email'), prompt: t('Atlassian account email'), ignoreFocusOut: true,
      validateInput: (v) => (v.includes('@') ? undefined : t('An email is required')),
    });
    if (!email) return;
    email = email.trim();
  }

  const token = await vscode.window.showInputBox({
    title: t('New Jira Instance (4/5): token'),
    prompt: kind === 'cloud' ? t('Atlassian API token') : 'Personal Access Token',
    password: true, ignoreFocusOut: true,
    validateInput: (v) => (!v.trim() ? t('The token is empty') : /^[\x21-\x7e]+$/.test(v.trim()) ? undefined : t('The token contains spaces or unexpected characters')),
  });
  if (!token) return;

  const client = createJiraClient({ id, kind, baseUrl, email }, token.trim());
  let displayName: string;
  try {
    displayName = (await withProgress(t('Jiraffe: connecting to {0}…', baseUrl), () => client.myself())).displayName;
  } catch (e) {
    void vscode.window.showErrorMessage(t('Jiraffe: could not connect — {0}', errText(e)));
    return;
  }

  const name = await vscode.window.showInputBox({
    title: t('New Jira Instance (5/5): name'), prompt: t('Connected as {0}. What should the instance be called?', displayName),
    value: new URL(baseUrl).host, ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : t('The name is empty')),
  });
  if (!name) return;

  const instance: Instance = { id, name: name.trim(), baseUrl, kind, ...(email ? { email } : {}) };
  try {
    instance.caps = await withProgress(t('Jiraffe: detecting instance capabilities…'), () => detectCapabilities(client));
  } catch (e) {
    void vscode.window.showWarningMessage(t('Jiraffe: could not detect instance capabilities ({0}). Run “Refresh Instance Capabilities” again.', errText(e)));
  }
  await store.add(instance, token.trim());
  void vscode.window.showInformationMessage(t('Jiraffe: instance “{0}” added', instance.name) + (instance.caps ? t(' (Tempo: {0})', instance.caps.tempo ? t('available') : t('no')) : ''));
  await offerWorkspaceScope(store, instance);
}

async function clientFor(store: InstanceStore, inst: Instance) {
  const token = await store.getToken(inst.id);
  if (!token) throw new Error(t('token not found in SecretStorage — add the instance again'));
  return createJiraClient(inst, token);
}

export function registerInstanceCommands(store: InstanceStore): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('jiraffe.addInstance', () => addInstance(store)),
    vscode.commands.registerCommand('jiraffe.scopeInstances', () => scopeInstances(store)),
    vscode.commands.registerCommand('jiraffe.removeInstance', async () => {
      const inst = await pickInstance(store, t('Which instance to remove?'));
      if (!inst) return;
      const ok = await vscode.window.showWarningMessage(t('Remove instance “{0}” and its token?', inst.name), { modal: true }, t('Remove'));
      if (ok === t('Remove')) await store.remove(inst.id);
    }),
    vscode.commands.registerCommand('jiraffe.testConnection', async (instanceId?: unknown) => {
      // из узла ошибки дерева приходит id инстанса; из палитры — ничего (спросим QuickPick'ом)
      const inst = await pickInstance(store, t('Test connection to…'), typeof instanceId === 'string' ? instanceId : undefined);
      if (!inst) return;
      try {
        const me = await (await clientFor(store, inst)).myself();
        void vscode.window.showInformationMessage(t('Jiraffe: “{0}” — connected as {1}', inst.name, me.displayName));
      } catch (e) {
        void vscode.window.showErrorMessage(`Jiraffe: «${inst.name}» — ${errText(e)}`);
      }
    }),
    vscode.commands.registerCommand('jiraffe.refreshCapabilities', async () => {
      const inst = await pickInstance(store, t('Refresh instance capabilities…'));
      if (!inst) return;
      try {
        const client = await clientFor(store, inst);
        const caps = await withProgress(t('Jiraffe: “{0}” — detecting capabilities…', inst.name), () => detectCapabilities(client));
        await store.updateCaps(inst.id, caps);
        void vscode.window.showInformationMessage(t('Jiraffe: “{0}” — Tempo: {1}, Epic Link: {2}', inst.name, caps.tempo ? t('available') : t('no'), inst.kind === 'cloud' ? 'parent' : caps.epicLinkField ?? t('no')));
      } catch (e) {
        void vscode.window.showErrorMessage(`Jiraffe: «${inst.name}» — ${errText(e)}`);
      }
    }),
  ];
}
