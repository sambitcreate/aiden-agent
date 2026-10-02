/** Active-run-only adaptation of Pi 1.0 cache-warmer economics and safety horizons. */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import type { Api, AssistantMessage, TranscriptContext, Model, SimpleStreamOptions, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";

const MAX_AGE_MS = 60 * 60_000;
const MIN_SAVINGS_USD = 0.05;
const activeWarmers = new Set<PiCacheWarmer>();

export function stopAllPiCacheWarmers(): void {
  for (const warmer of activeWarmers) warmer.dispose();
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
  identity: string;
  context: TranscriptContext;
  options: Pick<SimpleStreamOptions, "sessionId" | "reasoning" | "thinkingBudgets" | "cacheRetention" | "temperature" | "transport" | "toolChoice">;
  cost: Model<Api>["cost"];
  startedAt: number;
  ttlMs: number;
  delayMs: number;
  deadlineAt: number;
  promptTokens: number;
  controller: AbortController;
  removeAbort: () => void;
  timer?: unknown;
}

export interface PiCacheWarmerDependencies {
  signal: AbortSignal;
  enabled(): Promise<boolean>;
  /** Resolve credentials only when dispatching, never retain them in a timer. */
  resolveRuntime(signal: AbortSignal): Promise<ResolvedModelRuntime>;
  recordUsage(message: AssistantMessage, runtime: ResolvedModelRuntime): Promise<void>;
  clock?: CacheWarmingClock;
}

/** Owns no Agent, transcript writer, tool executor or persisted request. */
export class PiCacheWarmer {
  private run?: WarmRun;
  private disposed = false;
  private readonly clock: CacheWarmingClock;
  private readonly abort = () => this.dispose();

  constructor(private readonly deps: PiCacheWarmerDependencies) {
    this.clock = deps.clock ?? realClock;
    activeWarmers.add(this);
    deps.signal.addEventListener("abort", this.abort, { once: true });
    if (deps.signal.aborted) this.dispose();
  }

  /** Called only at a real foreground request, before its transport starts. */
  requestStarted(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions = {}): (message: AssistantMessage) => void {
    this.stop();
    const retention = options.cacheRetention ?? "short";
    const ttlMs = retention === "none" ? 0 : (model.promptCache?.[retention] ?? 0) * 1000;
    // Payload rewrites, arbitrary sampling/metadata and deferred requests cannot be
    // replayed faithfully without retaining callbacks or opaque authority.
    if (this.disposed || options.signal?.aborted || !Number.isFinite(ttlMs) || ttlMs <= 10_000 || options.headers || options.onPayload || (options as ModelsSimpleStreamOptions).transformHeaders || options.samplingParams || options.metadata || options.env || options.deferred || model.samplingParams ||
      (options.reasoning && model.api === "anthropic-messages" && (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking !== true)) return () => {};
    const controller = new AbortController();
    const requestSignal = options.signal;
    const cancel = () => { if (this.run === run) this.stop(); };
    const run: WarmRun = {
      identity: modelIdentity(model), context: structuredClone(context),
      options: {
        sessionId: options.sessionId, reasoning: options.reasoning,
        thinkingBudgets: options.thinkingBudgets ? structuredClone(options.thinkingBudgets) : undefined,
        cacheRetention: retention, temperature: options.temperature, transport: options.transport,
        toolChoice: options.toolChoice ? structuredClone(options.toolChoice) : undefined,
      },
      cost: structuredClone(model.cost), startedAt: this.clock.now(), ttlMs,
      delayMs: Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)), deadlineAt: 0,
      promptTokens: 0, controller,
      removeAbort: () => requestSignal?.removeEventListener("abort", cancel),
    };
    this.run = run;
    requestSignal?.addEventListener("abort", cancel, { once: true });
    // No timer is armed until provider-reported usage establishes real economics.
    return (message) => {
      if (this.run !== run || message.stopReason === "error" || message.stopReason === "aborted") return;
      run.promptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
      this.schedule(run, run.startedAt);
    };
  }

  stop(): void {
    const run = this.run;
    this.run = undefined;
    if (!run) return;
    if (run.timer !== undefined) this.clock.clearTimeout(run.timer);
    run.removeAbort();
    run.controller.abort();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    activeWarmers.delete(this);
    this.deps.signal.removeEventListener("abort", this.abort);
  }

  private schedule(run: WarmRun, cacheWrittenAt: number): void {
    const nextAt = cacheWrittenAt + run.delayMs;
    run.deadlineAt = nextAt + Math.floor((run.ttlMs - run.delayMs) / 2);
    const economics = cacheWarmingEconomics({ cost: run.cost }, run.promptTokens);
    if (this.run !== run) return;
    if (!economics || economics.expectedSavings < MIN_SAVINGS_USD || nextAt > run.startedAt + MAX_AGE_MS || this.clock.now() > run.deadlineAt) { this.stop(); return; }
    run.timer = this.clock.setTimeout(() => void this.refresh(run), Math.max(0, nextAt - this.clock.now()));
  }

  private current(run: WarmRun): boolean {
    return this.run === run && !run.controller.signal.aborted && !this.deps.signal.aborted && this.clock.now() <= run.deadlineAt && this.clock.now() <= run.startedAt + MAX_AGE_MS;
  }

  private async refresh(run: WarmRun): Promise<void> {
    run.timer = undefined;
    try {
      if (!this.current(run) || !(await this.deps.enabled())) { if (this.run === run) this.stop(); return; }
      const runtime = await this.deps.resolveRuntime(run.controller.signal);
      if (!this.current(run) || modelIdentity(runtime.model) !== run.identity || !(await this.deps.enabled())) { if (this.run === run) this.stop(); return; }
      if (!this.current(run)) { if (this.run === run) this.stop(); return; }
      const dispatchedAt = this.clock.now();
      const message = await runtime.streams.streamSimple(runtime.model, run.context, {
        ...run.options, apiKey: runtime.apiKey, headers: runtime.headers,
        maxTokens: 1, maxRetries: 0, timeoutMs: 30_000, signal: run.controller.signal,
      }).result();
      // Account provider usage even when cancellation races a completed response.
      await this.deps.recordUsage(message, runtime);
      if (message.stopReason === "error" || message.stopReason === "aborted") { if (this.run === run) this.stop(); return; }
      if (this.run === run) this.schedule(run, dispatchedAt);
    } catch {
      // Warming cannot fail the foreground turn and does not retry a failed refresh.
      if (this.run === run) this.stop();
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
