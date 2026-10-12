// Чтение доступа публичного API из настроек VS Code. Отдельно от `apiAccess.ts`: тот без vscode и тестируется напрямую.
import * as vscode from 'vscode';
import type { ApiAccess } from './api';
import { API_ALLOW_WRITES, API_ENABLED, API_SECTION, resolveApiAccess } from './apiAccess';

/** Доступ других расширений к API из пользовательских настроек. Вызывается на каждое обращение, не кэшируется. */
export function apiAccess(): ApiAccess {
  const cfg = vscode.workspace.getConfiguration(API_SECTION);
  return resolveApiAccess(cfg.inspect<unknown>(API_ENABLED), cfg.inspect<unknown>(API_ALLOW_WRITES));
}
