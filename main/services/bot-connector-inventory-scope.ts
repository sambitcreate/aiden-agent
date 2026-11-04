import { AsyncLocalStorage } from "node:async_hooks";
import type { BotRuntimeAuthorityAdmission } from "./bot-runtime-authority.js";
import type { BotConnectorWatchBinding } from "./bot-routine-events/connector-types.js";
import type { BotConnectorWatchCondition } from "../../renderer/shared/bot-connector-watches.js";
import { isDeepStrictEqual } from "node:util";

const scope = new AsyncLocalStorage<string>();
const cachedOnly=new AsyncLocalStorage<boolean>();
const modelEffect=new AsyncLocalStorage<()=>Promise<void>>();
export function withBotConnectorModelEffect<T>(assertCurrent:()=>Promise<void>,operation:()=>Promise<T>):Promise<T>{return modelEffect.run(assertCurrent,operation);}
export async function assertBotConnectorModelEffectCurrent():Promise<void>{await modelEffect.getStore()?.();}
export function botConnectorInventoryCacheOnly():boolean{return cachedOnly.getStore()===true;}
export function withBotConnectorCachedInventoryScope<T>(serverId:string,operation:()=>Promise<T>):Promise<T>{return cachedOnly.run(true,()=>withBotConnectorInventoryScope(serverId,operation));}
interface MetadataRenewal { serverId: string; signal: AbortSignal; assertCurrent(): Promise<void> }
const metadataRenewal = new AsyncLocalStorage<MetadataRenewal>();
/** Only the accepted source-reader enters this; ordinary model assembly remains cache-only. */
export function withBotConnectorMetadataRenewal<T>(input: MetadataRenewal, operation: () => Promise<T>): Promise<T> {
  return withBotConnectorInventoryScope(input.serverId, () => metadataRenewal.run(input, () => cachedOnly.run(false, operation)));
}
export async function assertBotConnectorMetadataRenewalCurrent(): Promise<void> {
  const value = metadataRenewal.getStore();
  if (value) { value.signal.throwIfAborted(); if (scope.getStore() !== value.serverId) throw new Error("Connector metadata renewal changed source."); await value.assertCurrent(); value.signal.throwIfAborted(); }
}
interface ForegroundLifetime { signal: AbortSignal; assertCurrent(): void | Promise<void> }
const foreground = new AsyncLocalStorage<ForegroundLifetime>();
export interface BotConnectorExecutionRestriction { routineId: string; revision: number; binding: BotConnectorWatchBinding;condition?:BotConnectorWatchCondition }
const executionRestriction = new AsyncLocalStorage<BotConnectorExecutionRestriction>();

/** Freeze the accepted account/resource, in addition to its transport scope. */
export function withBotConnectorExecutionRestriction<T>(input: BotConnectorExecutionRestriction, operation: () => Promise<T>): Promise<T> {
  if (!input.routineId || !Number.isSafeInteger(input.revision) || input.revision < 0 || !input.binding?.serverId) return Promise.reject(new Error("This watch has no valid accepted connector binding."));
  if(input.binding.adapter==="composio-calendar-v1"&&(input.condition?.kind!=="calendar"||!Number.isSafeInteger(input.condition.lookAheadMinutes)||input.condition.lookAheadMinutes<15||input.condition.lookAheadMinutes>1440))return Promise.reject(new Error("This Calendar watch has no accepted window condition."));
  const copy = structuredClone(input);
  const parent = executionRestriction.getStore();
  if (parent && !isDeepStrictEqual(parent, copy)) return Promise.reject(new Error("Watch execution cannot switch its accepted account or resource."));
  const run=()=>executionRestriction.run(copy,()=>withBotConnectorInventoryScope(copy.binding.serverId,operation));
  return copy.binding.adapter==="composio-calendar-v1"?cachedOnly.run(true,run):run();
}

/** A defensive private copy; never project its authority fingerprints to clients. */
export function botConnectorExecutionRestriction(): BotConnectorExecutionRestriction | undefined {
  const value = executionRestriction.getStore();
  return value ? structuredClone(value) : undefined;
}
export function withBotConnectorForegroundLifetime<T>(lifetime: ForegroundLifetime, operation: () => Promise<T>): Promise<T> { return foreground.run(lifetime, operation); }
export function botConnectorForegroundLifetime(): ForegroundLifetime | undefined { return foreground.getStore(); }

/** Watch work may inspect only its selected, already approved live connection. */
export function withBotConnectorInventoryScope<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
  const parent = scope.getStore();
  if (parent && parent !== serverId) return Promise.reject(new Error("Watch work cannot switch its selected connector."));
  return scope.run(serverId, operation);
}

export function botConnectorInventoryServer(): string | undefined { return scope.getStore(); }

/**
 * Enter only at the host's durable task boundary. A queued task may be drained
 * by a scheduler callback created by another input, whose ALS is not its own.
 * Nested tool calls still use the no-switch checks above.
 */
export function withBotConnectorTaskScope<T>(restriction: BotConnectorExecutionRestriction | undefined, serverId: string | undefined, operation: () => Promise<T>): Promise<T> {
  return scope.exit(() => executionRestriction.exit(() => cachedOnly.exit(()=>{
    const run=()=>restriction?withBotConnectorExecutionRestriction(restriction,operation):serverId?withBotConnectorInventoryScope(serverId,operation):operation();
    return restriction?.binding.adapter==="composio-calendar-v1"?cachedOnly.run(true,run):run();
  })));
}

/** A returned authority lease keeps its inventory restriction after the caller's scope ends. */
export async function admitWithBotConnectorInventoryScope(serverId: string, admit: () => Promise<BotRuntimeAuthorityAdmission>): Promise<BotRuntimeAuthorityAdmission> {
  const lifetime = foreground.getStore();
  const admission = await withBotConnectorInventoryScope(serverId, admit);
  return Object.freeze({ authority: admission.authority, signal: admission.signal,
    revalidateBeforeEffect: () => lifetime ? foreground.run(lifetime, () => withBotConnectorInventoryScope(serverId, () => admission.revalidateBeforeEffect())) : withBotConnectorInventoryScope(serverId, () => admission.revalidateBeforeEffect()),
    release: () => admission.release() });
}
