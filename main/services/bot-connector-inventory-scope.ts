import { AsyncLocalStorage } from "node:async_hooks";
import type { BotRuntimeAuthorityAdmission } from "./bot-runtime-authority.js";

const scope = new AsyncLocalStorage<string>();

/** Watch work may inspect only its selected, already approved live connection. */
export function withBotConnectorInventoryScope<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
  const parent = scope.getStore();
  if (parent && parent !== serverId) return Promise.reject(new Error("Watch work cannot switch its selected connector."));
  return scope.run(serverId, operation);
}

export function botConnectorInventoryServer(): string | undefined { return scope.getStore(); }

/** A returned authority lease keeps its inventory restriction after the caller's scope ends. */
export async function admitWithBotConnectorInventoryScope(serverId: string, admit: () => Promise<BotRuntimeAuthorityAdmission>): Promise<BotRuntimeAuthorityAdmission> {
  const admission = await withBotConnectorInventoryScope(serverId, admit);
  return Object.freeze({ authority: admission.authority, signal: admission.signal,
    revalidateBeforeEffect: () => withBotConnectorInventoryScope(serverId, () => admission.revalidateBeforeEffect()),
    release: () => admission.release() });
}
