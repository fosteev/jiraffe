import * as vscode from 'vscode';
import { createJiraClient } from '../jira/client';
import { detectCapabilities } from '../jira/capabilities';
import { canonicalBaseUrl } from '../jira/http';
import type { Instance, InstanceKind } from '../jira/types';
import { InstanceStore, instanceIdFromUrl } from '../state/instances';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const withProgress = <T>(title: string, task: () => Promise<T>): Thenable<T> =>
  vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);

async function pickInstance(store: InstanceStore, placeHolder: string, instanceId?: string): Promise<Instance | undefined> {
  const all = store.list();
  if (instanceId) {
    const known = store.get(instanceId);
    if (known) return known;
  }
  if (all.length === 0) {
    const act = await vscode.window.showInformationMessage('Jiraffe: нет ни одного инстанса', 'Добавить');
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
    title: 'Новый инстанс Jira (1/5): адрес',
    prompt: 'Адрес с context path, если он есть: https://host или https://host/jira',
    ignoreFocusOut: true,
    validateInput: (v) => {
      try {
        const u = new URL(canonicalBaseUrl(v));
        return u.protocol === 'https:' || u.protocol === 'http:' ? undefined : 'Нужен http(s)-адрес';
      } catch {
        return 'Не похоже на URL';
      }
    },
  });
  if (!rawUrl) return;
  const baseUrl = canonicalBaseUrl(rawUrl);
  if (baseUrl.startsWith('http:') && (await vscode.window.showWarningMessage(
    `${baseUrl}: адрес без https — токен уйдёт по сети открытым текстом. Продолжить?`, { modal: true }, 'Продолжить')) !== 'Продолжить') return;
  const id = instanceIdFromUrl(baseUrl);
  if (store.get(id) && (await vscode.window.showWarningMessage(`Инстанс ${id} уже добавлен. Заменить?`, { modal: true }, 'Заменить')) !== 'Заменить') return;

  const guess: InstanceKind = new URL(baseUrl).host.endsWith('.atlassian.net') ? 'cloud' : 'dc';
  const kinds = [
    { label: 'Server / Data Center', description: 'Bearer PAT', instKind: 'dc' as InstanceKind },
    { label: 'Cloud', description: 'email + API-токен', instKind: 'cloud' as InstanceKind },
  ];
  const kindPick = await vscode.window.showQuickPick(
    kinds.sort((a, b) => Number(b.instKind === guess) - Number(a.instKind === guess)),
    { placeHolder: 'Новый инстанс Jira (2/5): тип', ignoreFocusOut: true },
  );
  if (!kindPick) return;
  const kind = kindPick.instKind;

  let email: string | undefined;
  if (kind === 'cloud') {
    email = await vscode.window.showInputBox({
      title: 'Новый инстанс Jira (3/5): email', prompt: 'Email учётной записи Atlassian', ignoreFocusOut: true,
      validateInput: (v) => (v.includes('@') ? undefined : 'Нужен email'),
    });
    if (!email) return;
    email = email.trim();
  }

  const token = await vscode.window.showInputBox({
    title: 'Новый инстанс Jira (4/5): токен',
    prompt: kind === 'cloud' ? 'API-токен Atlassian' : 'Personal Access Token',
    password: true, ignoreFocusOut: true,
    validateInput: (v) => (!v.trim() ? 'Токен пустой' : /^[\x21-\x7e]+$/.test(v.trim()) ? undefined : 'В токене пробелы или лишние символы'),
  });
  if (!token) return;

  const client = createJiraClient({ id, kind, baseUrl, email }, token.trim());
  let displayName: string;
  try {
    displayName = (await withProgress(`Jiraffe: подключение к ${baseUrl}…`, () => client.myself())).displayName;
  } catch (e) {
    void vscode.window.showErrorMessage(`Jiraffe: не удалось подключиться — ${errText(e)}`);
    return;
  }

  const name = await vscode.window.showInputBox({
    title: 'Новый инстанс Jira (5/5): имя', prompt: `Подключено как ${displayName}. Как назвать инстанс?`,
    value: new URL(baseUrl).host, ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Имя пустое'),
  });
  if (!name) return;

  const instance: Instance = { id, name: name.trim(), baseUrl, kind, ...(email ? { email } : {}) };
  try {
    instance.caps = await withProgress('Jiraffe: определяю возможности инстанса…', () => detectCapabilities(client));
  } catch (e) {
    void vscode.window.showWarningMessage(`Jiraffe: возможности инстанса не определены (${errText(e)}). Повторите «Обновить возможности инстанса».`);
  }
  await store.add(instance, token.trim());
  void vscode.window.showInformationMessage(`Jiraffe: инстанс «${instance.name}» добавлен` + (instance.caps ? ` (Tempo: ${instance.caps.tempo ? 'есть' : 'нет'})` : ''));
}

async function clientFor(store: InstanceStore, inst: Instance) {
  const token = await store.getToken(inst.id);
  if (!token) throw new Error('токен не найден в SecretStorage — добавьте инстанс заново');
  return createJiraClient(inst, token);
}

export function registerInstanceCommands(store: InstanceStore): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('jiraffe.addInstance', () => addInstance(store)),
    vscode.commands.registerCommand('jiraffe.removeInstance', async () => {
      const inst = await pickInstance(store, 'Какой инстанс удалить?');
      if (!inst) return;
      const ok = await vscode.window.showWarningMessage(`Удалить инстанс «${inst.name}» и его токен?`, { modal: true }, 'Удалить');
      if (ok === 'Удалить') await store.remove(inst.id);
    }),
    vscode.commands.registerCommand('jiraffe.testConnection', async (instanceId?: unknown) => {
      // из узла ошибки дерева приходит id инстанса; из палитры — ничего (спросим QuickPick'ом)
      const inst = await pickInstance(store, 'Проверить подключение к…', typeof instanceId === 'string' ? instanceId : undefined);
      if (!inst) return;
      try {
        const me = await (await clientFor(store, inst)).myself();
        void vscode.window.showInformationMessage(`Jiraffe: «${inst.name}» — подключено как ${me.displayName}`);
      } catch (e) {
        void vscode.window.showErrorMessage(`Jiraffe: «${inst.name}» — ${errText(e)}`);
      }
    }),
    vscode.commands.registerCommand('jiraffe.refreshCapabilities', async () => {
      const inst = await pickInstance(store, 'Обновить возможности инстанса…');
      if (!inst) return;
      try {
        const client = await clientFor(store, inst);
        const caps = await withProgress(`Jiraffe: «${inst.name}» — определяю возможности…`, () => detectCapabilities(client));
        await store.updateCaps(inst.id, caps);
        void vscode.window.showInformationMessage(`Jiraffe: «${inst.name}» — Tempo: ${caps.tempo ? 'есть' : 'нет'}, Epic Link: ${inst.kind === 'cloud' ? 'parent' : caps.epicLinkField ?? 'нет'}`);
      } catch (e) {
        void vscode.window.showErrorMessage(`Jiraffe: «${inst.name}» — ${errText(e)}`);
      }
    }),
  ];
}
