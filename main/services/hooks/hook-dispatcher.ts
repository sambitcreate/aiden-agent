/**
 * Runs every active hook that matches an event and merges their answers.
 *
 * - Only hooks the source reports as active run (approved digest, enabled,
 *   not paused, not disabled after failures).
 * - The same handler configured in several scopes (say, a global hook copied
 *   into a repo file) runs once; the first scope's copy is kept.
 * - Matching hooks run in parallel, a few at a time.
 * - An idempotency key caches the outcome, so a durable replay of the same
 *   tool call never re-runs a hook. The cache is cleared whenever the owner
 *   changes which hooks may run, so a replay never reuses a stale answer.
 * - Nothing dispatched from inside a hook run triggers hooks again.
 * - Three consecutive failures disable a hook until it is re-enabled.
 * - Each hook keeps a short in-memory run log.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { claudeToolInput, claudeToolName, aidenToolName } from "./hook-aliases.js";
import { clampHookTimeout } from "./hook-config.js";
import { compileHookMatcher, matcherMatchesTool, matcherMatchesValue, type CompiledHookMatcher } from "./hook-matcher.js";
import { mergeHookResults, type HookMergeEntry } from "./hook-merge.js";
import { interpretHookRun, runHookCommand, type HookRawRun } from "./hook-runner.js";
import type {
  HookDefinition,
  HookDispatchContext,
  HookDispatcher,
  HookEvent,
  HookOutcome,
  HookPayload,
  HookRunRecord,
  HookScope,
} from "./hook-types.js";

export const HOOK_RUN_CONCURRENCY = 4;
export const HOOK_RUN_LOG_SIZE = 20;
const IDEMPOTENCY_CACHE_SIZE = 256;
const MATCHER_CACHE_SIZE = 256;

const hookRunScope = new AsyncLocalStorage<true>();

/** True while code runs on behalf of a hook; such code never dispatches hooks. */
export function isInsideHookRun(): boolean {
  return hookRunScope.getStore() === true;
}

const TOOL_EVENTS: ReadonlySet<HookEvent> = new Set(["PreToolUse", "PostToolUse"]);

export interface HookDispatcherSource {
  /**
   * Active hooks for `event` in `scopes`, in scope order. Called on every
   * dispatch, so drift is caught each fire. `cwd` is where they will run.
   */
  activeHooks(event: HookEvent, scopes: readonly HookScope[], cwd: string): Promise<HookDefinition[]>;
  /** Cheap, synchronous and conservative: false only when no active hook can match. */
  mayHaveActiveHooks(event: HookEvent, scopes: readonly HookScope[], toolName?: string): boolean;
}

export interface HookHealth {
  recordSuccess(hook: HookDefinition): Promise<void>;
  /** Returns true when this failure disabled the hook. */
  recordFailure(hook: HookDefinition): Promise<boolean>;
}

export type HookRunFunction = (hook: HookDefinition, payload: HookPayload, context: HookDispatchContext) => Promise<HookRawRun>;

export interface HookDispatcherOptions {
  source: HookDispatcherSource;
  health?: HookHealth;
  /** Runs one hook. Defaults to the real shell runner. */
  run?: HookRunFunction;
  onRun?: (hook: HookDefinition, record: HookRunRecord) => void;
  onAutoDisabled?: (hook: HookDefinition) => void;
  concurrency?: number;
  now?: () => number;
}

export interface AidenHookDispatcher extends HookDispatcher {
  getRunLog(hookId: string): HookRunRecord[];
  lastRun(hookId: string): HookRunRecord | undefined;
  /** Forget cached outcomes; call whenever approvals, switches or pause change. */
  clearIdempotencyCache(): void;
}

/** Two hooks with the same key do exactly the same thing for the same event. */
function handlerKey(hook: HookDefinition): string {
  const { handler } = hook;
  return JSON.stringify([
    hook.event,
    hook.matcher,
    handler.command,
    clampHookTimeout(handler.timeout),
    handler.failClosed === true,
    [...(handler.envAllow ?? [])].sort(),
  ]);
}

/** Keep the first of each identical handler, in scope order. */
export function dedupeHooks(hooks: readonly HookDefinition[]): HookDefinition[] {
  const seen = new Set<string>();
  return hooks.filter((hook) => {
    const key = handlerKey(hook);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Fill in Claude spellings so Claude Code scripts read Aiden's payloads unchanged. */
export function normalizeHookPayload(event: HookEvent, payload: HookPayload, context: HookDispatchContext): HookPayload {
  const normalized: HookPayload = { ...payload, hook_event_name: event, session_id: payload.session_id || context.sessionId, cwd: payload.cwd || context.cwd };
  const name = payload.aiden_tool_name ?? (payload.tool_name ? aidenToolName(payload.tool_name) : undefined);
  if (name) {
    normalized.aiden_tool_name = name;
    normalized.tool_name = claudeToolName(name);
  }
  if (payload.tool_input) normalized.tool_input = claudeToolInput(payload.tool_input);
  return normalized;
}

function matchTarget(event: HookEvent, payload: HookPayload): { tool?: string; value?: string } {
  if (TOOL_EVENTS.has(event)) return { tool: payload.aiden_tool_name ?? payload.tool_name };
  if (event === "SessionStart") return { value: payload.source };
  if (event === "PreCompact") return { value: payload.trigger };
  if (event === "Notification") return { value: typeof payload.notification_type === "string" ? payload.notification_type : undefined };
  return {};
}

class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly limit: number) {}
  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as K);
  }
  delete(key: K): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

async function runBounded<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createHookDispatcher(options: HookDispatcherOptions): AidenHookDispatcher {
  const now = options.now ?? Date.now;
  const concurrency = Math.max(1, options.concurrency ?? HOOK_RUN_CONCURRENCY);
  const run: HookRunFunction =
    options.run ??
    ((hook, payload, context) => runHookCommand({ hook, payload, cwd: context.cwd, sessionId: context.sessionId, signal: context.signal, now }));
  const outcomes = new BoundedMap<string, Promise<HookOutcome>>(IDEMPOTENCY_CACHE_SIZE);
  const matchers = new BoundedMap<string, CompiledHookMatcher | null>(MATCHER_CACHE_SIZE);
  const runLogs = new Map<string, HookRunRecord[]>();

  const compiled = (matcher: string): CompiledHookMatcher | null => {
    const cached = matchers.get(matcher);
    if (cached !== undefined) return cached;
    const result = compileHookMatcher(matcher);
    const value = result.ok ? result.matcher : null;
    matchers.set(matcher, value);
    return value;
  };

  const matches = (hook: HookDefinition, event: HookEvent, payload: HookPayload): boolean => {
    const matcher = compiled(hook.matcher);
    if (!matcher) return false;
    const target = matchTarget(event, payload);
    if (TOOL_EVENTS.has(event)) return matcher.kind === "all" || (target.tool !== undefined && matcherMatchesTool(matcher, target.tool));
    if (event === "SessionStart" || event === "PreCompact" || event === "Notification") return matcherMatchesValue(matcher, target.value);
    // Events without a match target ignore the matcher, as in Claude Code.
    return true;
  };

  const record = (hook: HookDefinition, entry: HookRunRecord) => {
    const log = runLogs.get(hook.id) ?? [];
    log.push(entry);
    if (log.length > HOOK_RUN_LOG_SIZE) log.splice(0, log.length - HOOK_RUN_LOG_SIZE);
    runLogs.set(hook.id, log);
    try {
      options.onRun?.(hook, entry);
    } catch {
      // A listener must never change the outcome.
    }
  };

  const runOne = async (hook: HookDefinition, event: HookEvent, payload: HookPayload, context: HookDispatchContext): Promise<HookMergeEntry> => {
    const raw = await run(hook, payload, context);
    const result = interpretHookRun(event, raw, hook.handler);
    record(hook, {
      hookId: hook.id,
      event,
      startedAt: raw.startedAt,
      durationMs: raw.durationMs,
      exitCode: raw.exitCode,
      timedOut: raw.timedOut,
      outputExcerpt: result.excerpt,
      result: result.result,
    });
    if (options.health && !raw.aborted) {
      try {
        if (result.result === "error") {
          if (await options.health.recordFailure(hook)) options.onAutoDisabled?.(hook);
        } else {
          await options.health.recordSuccess(hook);
        }
      } catch {
        // Health bookkeeping is best effort; the hook's answer still counts.
      }
    }
    return { hook, result };
  };

  const execute = async (event: HookEvent, payload: HookPayload, context: HookDispatchContext): Promise<HookOutcome> => {
    let hooks: HookDefinition[];
    try {
      hooks = await options.source.activeHooks(event, context.scopes, context.cwd);
    } catch (error) {
      return { ranHooks: [], notices: [`Aiden could not load hooks: ${error instanceof Error ? error.message : String(error)}`] };
    }
    const normalized = normalizeHookPayload(event, payload, context);
    const selected = dedupeHooks(hooks.filter((hook) => hook.event === event && matches(hook, event, normalized)));
    if (selected.length === 0 || context.signal?.aborted) return { ranHooks: [] };
    const entries = await hookRunScope.run(true, () => runBounded(selected, concurrency, (hook) => runOne(hook, event, normalized, context)));
    return mergeHookResults(event, entries, normalized);
  };

  return {
    async dispatch(event, payload, context) {
      if (isInsideHookRun()) return { ranHooks: [] };
      if (!context.idempotencyKey) return execute(event, payload, context);
      const key = `${event}\u0000${context.idempotencyKey}`;
      const cached = outcomes.get(key);
      if (cached) return cached;
      const pending = execute(event, payload, context);
      outcomes.set(key, pending);
      try {
        const outcome = await pending;
        // An abandoned run must be able to run again on replay.
        if (context.signal?.aborted) outcomes.delete(key);
        return outcome;
      } catch (error) {
        outcomes.delete(key);
        throw error;
      }
    },
    hasHooks(event, scopes, toolName) {
      if (isInsideHookRun()) return false;
      return options.source.mayHaveActiveHooks(event, scopes, toolName);
    },
    getRunLog(hookId) {
      return [...(runLogs.get(hookId) ?? [])];
    },
    lastRun(hookId) {
      const log = runLogs.get(hookId);
      return log?.[log.length - 1];
    },
    clearIdempotencyCache() {
      outcomes.clear();
    },
  };
}
