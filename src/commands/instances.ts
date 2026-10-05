import * as vscode from 'vscode';
import { createJiraClient } from '../jira/client';
import { detectCapabilities } from '../jira/capabilities';
import { canonicalBaseUrl } from '../jira/http';
import type { Instance, InstanceKind } from '../jira/types';
import { InstanceStore, inScope, instanceIdFromUrl } from '../state/instances';

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
  const act = await vscode.window.showInformationMessage(
    `Jiraffe: показывать в этом workspace только «${inst.name}»? Остальные инстансы останутся в других окнах.`,
    'Только его', 'Все инстансы',
  );
  if (act === 'Только его') await config().update(SCOPE_KEY, [inst.id], vscode.ConfigurationTarget.Workspace);
}

const ADD_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('add'), tooltip: 'Добавить инстанс' };

async function scopeInstances(store: InstanceStore): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showInformationMessage('Jiraffe: откройте папку или workspace — набор инстансов хранится в его настройках');
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
  qp.title = 'Инстансы этого workspace';
  qp.placeholder = 'Отметьте, какие показывать здесь (все отмечены — все); «+» — новое подключение';
  qp.canSelectMany = true;
  qp.buttons = [ADD_BUTTON];
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
    void vscode.window.showWarningMessage('Jiraffe: нужен хотя бы один инстанс');
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
  await offerWorkspaceScope(store, instance);
}

async function clientFor(store: InstanceStore, inst: Instance) {
  const token = await store.getToken(inst.id);
  if (!token) throw new Error('токен не найден в SecretStorage — добавьте инстанс заново');
  return createJiraClient(inst, token);
}

export function registerInstanceCommands(store: InstanceStore): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('jiraffe.addInstance', () => addInstance(store)),
    vscode.commands.registerCommand('jiraffe.scopeInstances', () => scopeInstances(store)),
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
