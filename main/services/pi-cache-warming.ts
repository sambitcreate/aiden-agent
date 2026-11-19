/**
 * Attended-chat adaptation of Pi's cache warmer: Pi's lifetimes, refresh
 * margin, replay rule and safety horizons, with Aiden's attendance gate.
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import {
  CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY,
  CACHE_WARMING_MAX_AGE_MS,
  CACHE_WARMING_MAX_IDLE_AGE_MS,
  CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS,
  getCacheWarmingDelayMs,
  isCacheWarmingReplayable,
  type Api,
  type AssistantMessage,
  type TranscriptContext,
  type Model,
  type SimpleStreamOptions,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { promptCacheTtlMs } from "./prompt-cache-lifetimes.js";
import type { UsageRequestSource } from "./usage-store-core.js";
import type { ChatGenerationOwner } from "./chat-generation-owner.js";
import type { ChatStartParams } from "./types.js";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";

const MAX_AGE_MS = CACHE_WARMING_MAX_AGE_MS;
const MIN_SAVINGS_USD = CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS;
/**
 * Refreshes a settled chat may send before it stops on its own, on top of
 * Pi's 30-minute idle horizon. A five-minute cache gets at most three.
 */
export const IDLE_WARM_LIMIT = 3;
const activeWarmers = new Set<PiCacheWarmer>();
/** The one warmer each open chat keeps after its reply settled. */
const chatWarmers = new Map<string, PiCacheWarmer>();

/** Accounting provenance is separate from the attended renderer authority. */
export function canWarmForegroundChat(options: {
  enabled: boolean;
  local: boolean;
  bot: boolean;
  owner: Pick<ChatGenerationOwner, "id" | "kind" | "isDestroyed">;
  usageSource?: UsageRequestSource;
  interactionSurface?: "telegram";
  mode?: ChatStartParams["mode"];
}): boolean {
  return options.enabled && !options.local && !options.bot && options.owner.id > 0 && options.owner.kind !== "remote" && !options.owner.isDestroyed() &&
    (options.usageSource === undefined || options.usageSource === "chat") &&
    options.interactionSurface === undefined && options.mode !== "assistant-automation";
}


export function stopAllPiCacheWarmers(): void {
  for (const warmer of activeWarmers) warmer.dispose();
}

/**
 * Make `warmer` the chat's warmer, ending the one an earlier reply left
 * warming. A new reply, even one that does not warm, passes `undefined`.
 */
export function adoptChatCacheWarmer(chatId: string, warmer: PiCacheWarmer | undefined): void {
  const previous = chatWarmers.get(chatId);
  if (previous && previous !== warmer) previous.dispose();
  chatWarmers.delete(chatId);
  if (warmer && !warmer.isDisposed) {
    chatWarmers.set(chatId, warmer);
    warmer.onDisposed = () => { if (chatWarmers.get(chatId) === warmer) chatWarmers.delete(chatId); };
  }
}

/**
 * The window that showed this chat moved away, closed it, or the chat was
 * removed. With a `documentId`, only that window's warmer stops, so another
 * window leaving the chat does not end it.
 */
export function releaseChatCacheWarmer(chatId: string, documentId?: string): boolean {
  const warmer = chatWarmers.get(chatId);
  if (!warmer || (documentId !== undefined && warmer.documentId !== undefined && warmer.documentId !== documentId)) return false;
  warmer.dispose();
  return true;
}

export interface CacheWarmingClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}
const realClock: CacheWarmingClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => { const timer = setTimeout(callback, delayMs); timer.unref(); return timer; },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Hash endpoint/config identity rather than retaining model headers or other authority. */
function modelIdentity(model: Model<Api>): string {
  return createHash("sha256").update(JSON.stringify(model)).digest("hex");
}

/** Pi's idle decision: one refresh pays off only if the person is likely to reply before expiry. */
function idleRefreshPays(model: Pick<Model<Api>, "cost">, promptTokens: number): boolean {
  const economics = cacheWarmingEconomics(model, promptTokens);
  if (!economics) return false;
  const missCost = economics.expectedSavings + economics.warmCost;
  return CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY * missCost - economics.warmCost >= MIN_SAVINGS_USD;
}

export function cacheWarmingEconomics(model: Pick<Model<Api>, "cost">, promptTokens: number): { warmCost: number; expectedSavings: number } | undefined {
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return undefined;
  let rates = model.cost;
  let threshold = -1;
  for (const tier of model.cost.tiers ?? []) {
    if (promptTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
      rates = tier;
      threshold = tier.inputTokensAbove;
    }
  }
  if (![rates.input, rates.output, rates.cacheRead, rates.cacheWrite].every((rate) => Number.isFinite(rate) && rate >= 0)) return undefined;
  const hit = promptTokens * rates.cacheRead / 1_000_000;
  const miss = promptTokens * (rates.cacheWrite > 0 ? rates.cacheWrite : rates.input) / 1_000_000;
  if (miss === 0 && hit === 0) return undefined;
  const warmCost = hit + rates.output / 1_000_000;
  return { warmCost, expectedSavings: Math.max(0, miss - hit) - warmCost };
}

interface WarmRun {
  /** Hash of the model endpoint/config, computed only once warming is economical. */
  identity?: string;
  /** Shallow message-list snapshot until warming is economical, then a frozen deep copy; dropped on stop. */
  context?: TranscriptContext;
  options: Pick<SimpleStreamOptions, "sessionId" | "reasoning" | "thinkingBudgets" | "cacheRetention" | "temperature" | "transport" | "toolChoice">;
  cost: Model<Api>["cost"];
  startedAt: number;
  ttlMs: number;
  delayMs: number;
  deadlineAt: number;
  promptTokens: number;
  spentUsd: number;
  controller: AbortController;
  removeAbort: () => void;
  timer?: unknown;
  /** Set once the reply settled and the open chat keeps the cache warm. */
  idle?: { isCurrent: () => boolean; stillCurrent?: () => Promise<boolean>; warms: number };
}

export interface PiCacheWarmerIdleOptions {
  /** The window still shows the chat; checked before every refresh. */
  isCurrent(): boolean;
  /** The chat has not changed since its reply settled; checked before credentials are read. */
  stillCurrent?(): Promise<boolean>;
}

export interface PiCacheWarmerDependencies {
  signal: AbortSignal;
  enabled(): Promise<boolean>;
  /** Current attended generation ownership, independent of accounting provenance. */
  isCurrent(): boolean;
  /** Resolve credentials only when dispatching, never retain them in a timer. */
  resolveRuntime(signal: AbortSignal): Promise<ResolvedModelRuntime>;
  recordUsage(message: AssistantMessage, runtime: ResolvedModelRuntime): Promise<void>;
  /** A refresh read or wrote the cache, restarting its lifetime from dispatch. */
  onCacheRefreshed?(requestStartedAt: number): void;
  clock?: CacheWarmingClock;
  /** The renderer document that owns the chat, so only that window can release it. */
  documentId?: string;
}

/** Owns no Agent, transcript writer, tool executor or persisted request. */
export class PiCacheWarmer {
  private run?: WarmRun;
  private disposed = false;
  private readonly clock: CacheWarmingClock;
  private readonly abort = () => this.dispose();
  /** Called once, when the warmer is disposed. */
  onDisposed?: () => void;
  readonly documentId?: string;

  constructor(private readonly deps: PiCacheWarmerDependencies) {
    this.clock = deps.clock ?? realClock;
    this.documentId = deps.documentId;
    activeWarmers.add(this);
    deps.signal.addEventListener("abort", this.abort, { once: true });
    if (deps.signal.aborted) this.dispose();
  }

  /** Called only at a real foreground request, before its transport starts. */
  requestStarted(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions = {}): (message: AssistantMessage) => void {
    this.stop();
    // An explicit retention, so the PI_CACHE_RETENTION environment never
    // decides a lifetime the request did not ask for.
    const retention = options.cacheRetention ?? "short";
    // Pi's declared lifetime first, then the documented provider lifetimes;
    // a model with neither is never warmed.
    const ttlMs = promptCacheTtlMs(model, retention);
    const delayMs = Number.isFinite(ttlMs) && ttlMs > 0 ? getCacheWarmingDelayMs(ttlMs) : undefined;
    // Payload rewrites, arbitrary sampling/metadata and deferred requests cannot be
    // replayed faithfully without retaining callbacks or opaque authority.
    if (this.disposed || delayMs === undefined || !this.deps.isCurrent() || options.signal?.aborted || options.headers || options.onPayload || (options as ModelsSimpleStreamOptions).transformHeaders || options.samplingParams || options.metadata || options.env || options.deferred || model.samplingParams ||
      !isCacheWarmingReplayable(model, { ...options, cacheRetention: retention })) return () => {};
    const controller = new AbortController();
    const requestSignal = options.signal;
    const cancel = () => { if (this.run === run) this.stop(); };
    // Only the message list is copied here: each foreground request (every
    // tool-loop turn) passes through, and most never become worth warming.
    const run: WarmRun = {
      context: { ...context, messages: [...context.messages] },
      options: {
        sessionId: options.sessionId, reasoning: options.reasoning,
        thinkingBudgets: options.thinkingBudgets ? structuredClone(options.thinkingBudgets) : undefined,
        cacheRetention: retention, temperature: options.temperature, transport: options.transport,
        toolChoice: options.toolChoice ? structuredClone(options.toolChoice) : undefined,
      },
      cost: model.cost, startedAt: this.clock.now(), ttlMs,
      delayMs, deadlineAt: 0,
      promptTokens: 0, spentUsd: 0, controller,
      removeAbort: () => requestSignal?.removeEventListener("abort", cancel),
    };
    this.run = run;
    requestSignal?.addEventListener("abort", cancel, { once: true });
    // No timer is armed until provider-reported usage establishes real economics.
    return (message) => {
      if (this.run !== run || message.stopReason === "error" || message.stopReason === "aborted") return;
      run.promptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
      const economics = cacheWarmingEconomics({ cost: run.cost }, run.promptTokens);
      if (!economics || economics.expectedSavings < MIN_SAVINGS_USD || !run.context) { this.stop(); return; }
      // Freeze the replayed prefix and endpoint identity only for a request worth warming.
      run.context = structuredClone(run.context);
      run.cost = structuredClone(run.cost);
      run.identity = modelIdentity(model);
      this.schedule(run, run.startedAt);
    };
  }

  stop(): void {
    const run = this.run;
    this.run = undefined;
    if (!run) return;
    if (run.timer !== undefined) this.clock.clearTimeout(run.timer);
    run.context = undefined;
    run.removeAbort();
    run.controller.abort();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * The reply ended while its window still shows the chat. Keeps the last
   * request warm under Pi's idle rules (a 15% chance of a reply before
   * expiry must still save $0.05, within 30 minutes of that request) and
   * at most `IDLE_WARM_LIMIT` refreshes. Returns false, disposing the
   * warmer, when there is nothing worth keeping warm.
   */
  settle(idle: PiCacheWarmerIdleOptions): boolean {
    const run = this.run;
    if (this.disposed || !run || run.identity === undefined || !idle.isCurrent() ||
      !idleRefreshPays({ cost: run.cost }, run.promptTokens)) {
      this.dispose();
      return false;
    }
    run.idle = { isCurrent: () => idle.isCurrent(), ...(idle.stillCurrent ? { stillCurrent: () => idle.stillCurrent!() } : {}), warms: 0 };
    if (!this.withinHorizon(run, this.nextRefreshAt(run))) {
      this.dispose();
      return false;
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    activeWarmers.delete(this);
    this.deps.signal.removeEventListener("abort", this.abort);
    const onDisposed = this.onDisposed;
    this.onDisposed = undefined;
    onDisposed?.();
  }

  private nextRefreshAt(run: WarmRun): number {
    return run.deadlineAt - Math.floor((run.ttlMs - run.delayMs) / 2);
  }

  private attended(run: WarmRun): boolean {
    return run.idle ? run.idle.isCurrent() : this.deps.isCurrent();
  }

  /** Pi's horizons: an hour from the real request while streaming, 30 minutes once idle. */
  private withinHorizon(run: WarmRun, refreshAt: number): boolean {
    if (run.idle) return run.idle.warms < IDLE_WARM_LIMIT && refreshAt <= run.startedAt + CACHE_WARMING_MAX_IDLE_AGE_MS;
    return refreshAt <= run.startedAt + MAX_AGE_MS;
  }

  private schedule(run: WarmRun, cacheWrittenAt: number): void {
    const nextAt = cacheWrittenAt + run.delayMs;
    run.deadlineAt = nextAt + Math.floor((run.ttlMs - run.delayMs) / 2);
    if (this.run !== run) return;
    if (!this.attended(run)) { this.stopIdle(run); return; }
    if (!this.pays(run) || !this.withinHorizon(run, nextAt) || this.clock.now() > run.deadlineAt) { this.stopIdle(run); return; }
    run.timer = this.clock.setTimeout(() => void this.refresh(run), Math.max(0, nextAt - this.clock.now()));
  }

  /** While streaming, one replayed prefix avoids one miss, so refreshes share its savings; idle refreshes pay one at a time. */
  private pays(run: WarmRun): boolean {
    if (run.idle) return idleRefreshPays({ cost: run.cost }, run.promptTokens);
    const economics = cacheWarmingEconomics({ cost: run.cost }, run.promptTokens);
    return economics !== undefined && economics.expectedSavings - run.spentUsd >= MIN_SAVINGS_USD;
  }

  /** A settled chat's warmer has nothing left to do once its run stops. */
  private stopIdle(run: WarmRun): void {
    if (this.run !== run) return;
    if (run.idle) this.dispose();
    else this.stop();
  }

  private current(run: WarmRun): boolean {
    const now = this.clock.now();
    return this.run === run && this.attended(run) && !run.controller.signal.aborted && !this.deps.signal.aborted && now <= run.deadlineAt &&
      now <= run.startedAt + (run.idle ? CACHE_WARMING_MAX_IDLE_AGE_MS : MAX_AGE_MS);
  }

  private async refresh(run: WarmRun): Promise<void> {
    run.timer = undefined;
    try {
      // Settings are read before resolving credentials (no keychain read when off)
      // and again after, since either await can race a toggle or a cancellation.
      if (!this.current(run) || !(await this.deps.enabled())) { this.stopIdle(run); return; }
      // A settled chat that changed since (a new message, a model switch, a
      // compaction) no longer sends this prefix.
      if (run.idle?.stillCurrent && !(await run.idle.stillCurrent())) { this.stopIdle(run); return; }
      if (!this.current(run)) { this.stopIdle(run); return; }
      const runtime = await this.deps.resolveRuntime(run.controller.signal);
      if (!this.current(run) || !(await this.deps.enabled()) || !this.current(run) || modelIdentity(runtime.model) !== run.identity) { this.stopIdle(run); return; }
      const context = run.context;
      if (!context) { this.stopIdle(run); return; }
      const economics = cacheWarmingEconomics({ cost: run.cost }, run.promptTokens);
      if (!economics || !this.pays(run)) { this.stopIdle(run); return; }
      // One replayed prefix can avoid only one future miss. Reserve this request's
      // estimated cost before dispatch; every later streaming refresh shares that budget.
      run.spentUsd += economics.warmCost;
      if (run.idle) run.idle.warms += 1;
      const dispatchedAt = this.clock.now();
      const message = await runtime.streams.streamSimple(runtime.model, context, {
        ...run.options, apiKey: runtime.apiKey, headers: runtime.headers,
        maxTokens: 1, maxRetries: 0, timeoutMs: 30_000, signal: run.controller.signal,
        // A replay must not use or replace the real conversation's server-side continuation state.
        disableContinuation: true,
      }).result();
      // Account provider usage even when cancellation races a completed response.
      await this.deps.recordUsage(message, runtime);
      const reportedCost = message.usage.cost.total;
      if (Number.isFinite(reportedCost) && reportedCost > economics.warmCost) {
        run.spentUsd += reportedCost - economics.warmCost;
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") { this.stopIdle(run); return; }
      if (message.usage.cacheRead + message.usage.cacheWrite > 0) this.deps.onCacheRefreshed?.(dispatchedAt);
      if (this.run === run) this.schedule(run, dispatchedAt);
    } catch {
      // Warming cannot fail the foreground turn and does not retry a failed refresh.
      this.stopIdle(run);
    }
  }
}


/** Observe the exact normalized request after host provider hooks have run. */
export function withPiCacheWarming(streamFn: StreamFn, warmer: PiCacheWarmer): StreamFn {
  return async (model, context, options) => {
    let finished: (message: AssistantMessage) => void = () => {};
    try { finished = warmer.requestStarted(model, context, options); } catch { warmer.stop(); }
    try {
      const stream = await streamFn(model, context, options);
      void stream.result().then(finished).catch(() => warmer.stop());
      return stream;
    } catch (error) {
      warmer.stop();
      throw error;
    }
  };
}
