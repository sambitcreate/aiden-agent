import {
  DEFAULT_COMPACTION_SETTINGS,
  calculateContextTokens,
  compact,
  estimateContextTokens,
  estimateTokens,
  prepareCompaction,
  shouldCompact,
  type AgentMessage,
  type CompactionSettings,
  type Session,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  createModels,
  createProvider,
  isContextOverflow,
  isRetryableAssistantError,
  type Api,
  type AssistantMessage,
  type Models,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";

export type PiCompactionReason = "threshold" | "overflow";

export interface PiCompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface PiCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter: number;
  details?: PiCompactionDetails;
}

export type PiCompactionEvent =
  | { type: "start"; reason: PiCompactionReason }
  | {
      type: "end";
      reason: PiCompactionReason;
      result?: PiCompactionResult;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    };

export interface PiCompactionCheckResult {
  compacted: boolean;
  shouldRetry: boolean;
  /** Pi-reconstructed state to install on the live Agent after compaction. */
  messages?: AgentMessage[];
  errorMessage?: string;
  retryDelayMs?: number;
}

export interface PiCompactionCoordinatorOptions {
  session: Session;
  models: Models;
  model: ResolvedModelRuntime["model"];
  thinkingLevel: ThinkingLevel;
  settings?: CompactionSettings;
  signal?: AbortSignal;
  onEvent?: (event: PiCompactionEvent) => void;
  /** Bounded host backoff for transient provider/transport retries. */
  retryDelayMs?: number;
}

function latestCompaction(entries: Awaited<ReturnType<Session["getBranch"]>>) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "compaction") return entry;
  }
  return undefined;
}

function estimatedMessageTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
}

/** Large current-turn batches must be summarized before the next provider call. */
export function needsImmediatePiCompaction(
  messages: readonly AgentMessage[],
  contextWindow: number,
): boolean {
  // Pi's fast estimator intentionally caps some tool payloads. Raw serialized
  // size is the conservative backstop for a just-produced current-turn batch.
  const serializedTokenFloor = Math.ceil(JSON.stringify(messages).length / 4);
  return (
    Math.max(estimatedMessageTokens(messages), serializedTokenFloor) >=
    Math.max(1_024, Math.floor(Math.max(1, contextWindow) * 0.25))
  );
}

/**
 * Pi coding-agent's auto-compaction orchestration, expressed against the Pi
 * Core session APIs Aiden already ships. Cut points, prompts, summaries,
 * split-turn behavior, and context reconstruction remain owned by Pi Core.
 */
export class PiCompactionCoordinator {
  private readonly settings: CompactionSettings;
  private retryRecoveryAttempted = false;
  private activeAbortController?: AbortController;

  constructor(private readonly options: PiCompactionCoordinatorOptions) {
    const contextWindow = Math.max(2, Math.floor(options.model.contextWindow));
    const defaultReserveTokens = Math.min(
      DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      Math.max(1_024, Math.floor(contextWindow * 0.2)),
    );
    const reserveTokens = Math.min(
      contextWindow - 1,
      Math.max(
        1,
        Math.floor(options.settings?.reserveTokens ?? defaultReserveTokens),
      ),
    );
    const defaultKeepRecentTokens = Math.min(
      DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
      Math.max(1_024, Math.floor((contextWindow - reserveTokens) * 0.5)),
    );
    this.settings = {
      ...DEFAULT_COMPACTION_SETTINGS,
      ...options.settings,
      reserveTokens,
      keepRecentTokens: Math.min(
        Math.max(1, contextWindow - reserveTokens - 1),
        Math.max(
          1,
          Math.floor(
            options.settings?.keepRecentTokens ?? defaultKeepRecentTokens,
          ),
        ),
      ),
    };
  }

  abort(): void {
    this.activeAbortController?.abort();
  }

  /** Pi resets overflow recovery when a new user prompt enters the agent. */
  beginPrompt(): void {
    this.retryRecoveryAttempted = false;
  }

  /** Check the reconstructed journal before provider I/O, including the new user turn. */
  async checkContextPressure(
    options: {
      forceThreshold?: boolean;
      /** Add a private user boundary when the active oversized tool turn has no native cut point. */
      sealCurrentTurnIfNeeded?: boolean;
    } = {},
  ): Promise<PiCompactionCheckResult> {
    if (!this.settings.enabled) return { compacted: false, shouldRetry: false };
    const branch = await this.options.session.getBranch();
    const compactionEntry = latestCompaction(branch);
    const context = await this.options.session.buildContext();
    const estimate = estimateContextTokens(context.messages);
    const heuristicTokens = estimatedMessageTokens(context.messages);
    const usageMessage =
      estimate.lastUsageIndex === null
        ? undefined
        : context.messages[estimate.lastUsageIndex];
    const usageIsStale =
      compactionEntry &&
      usageMessage?.role === "assistant" &&
      usageMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
    const contextTokens = usageIsStale
      ? heuristicTokens
      : Math.max(estimate.tokens, heuristicTokens);
    if (
      !options.forceThreshold &&
      !shouldCompact(
        contextTokens,
        this.options.model.contextWindow,
        this.settings,
      )
    ) {
      return { compacted: false, shouldRetry: false };
    }
    const result = await this.run("threshold", false);
    if (result.compacted || !options.sealCurrentTurnIfNeeded) return result;

    // Pi cannot cut an oversized tool batch when it is the entire open turn.
    // A private continuation user entry gives native compaction a valid next
    // boundary; it remains in the Pi journal only and never appears in chat.
    const priorLeaf = await this.options.session.getLeafId();
    await this.options.session.appendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: "Continue the same request using the compacted current-turn checkpoint. Do not repeat completed tool calls.",
        },
      ],
      timestamp: Date.now(),
    });
    const sealed = await this.run("threshold", false);
    if (!sealed.compacted) await this.options.session.moveTo(priorLeaf);
    return sealed;
  }

  async check(
    assistantMessage: AssistantMessage,
    options: { includeAborted?: boolean; forceThreshold?: boolean } = {},
  ): Promise<PiCompactionCheckResult> {
    if (!this.settings.enabled) return { compacted: false, shouldRetry: false };
    if (!options.includeAborted && assistantMessage.stopReason === "aborted") {
      return { compacted: false, shouldRetry: false };
    }

    const branch = await this.options.session.getBranch();
    const compactionEntry = latestCompaction(branch);
    if (
      compactionEntry &&
      assistantMessage.timestamp <=
        new Date(compactionEntry.timestamp).getTime()
    ) {
      return { compacted: false, shouldRetry: false };
    }

    const contextWindow = this.options.model.contextWindow;
    const sameModel =
      assistantMessage.provider === this.options.model.provider &&
      assistantMessage.model === this.options.model.id;

    if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
      const willRetry = assistantMessage.stopReason !== "stop";
      if (!willRetry) return this.run("overflow", false);
      const abandoned = await this.abandonRetryableAssistant(assistantMessage);
      if (!abandoned.ok) {
        return {
          compacted: false,
          shouldRetry: false,
          errorMessage: abandoned.errorMessage,
        };
      }
      if (this.retryRecoveryAttempted) {
        const errorMessage =
          "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.";
        this.options.onEvent?.({
          type: "end",
          reason: "overflow",
          aborted: false,
          willRetry: false,
          errorMessage,
        });
        return { compacted: false, shouldRetry: false, errorMessage };
      }
      this.retryRecoveryAttempted = true;
      return this.run("overflow", true);
    }

    if (isRetryableAssistantError(assistantMessage)) {
      const abandoned = await this.abandonRetryableAssistant(assistantMessage);
      if (!abandoned.ok) {
        return {
          compacted: false,
          shouldRetry: false,
          errorMessage: abandoned.errorMessage,
        };
      }
      const context = await this.options.session.buildContext();
      if (this.retryRecoveryAttempted) {
        return {
          compacted: false,
          shouldRetry: false,
          messages: context.messages,
          errorMessage:
            "The provider failed again after one automatic retry. Try again in a moment or switch models.",
        };
      }
      this.retryRecoveryAttempted = true;
      return {
        compacted: false,
        shouldRetry: true,
        messages: context.messages,
        retryDelayMs: Math.max(
          0,
          Math.min(5_000, this.options.retryDelayMs ?? 500),
        ),
      };
    }

    const directContextTokens = assistantMessage.usage
      ? calculateContextTokens(assistantMessage.usage)
      : 0;
    let contextTokens = directContextTokens;
    if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
      const context = await this.options.session.buildContext();
      const estimate = estimateContextTokens(context.messages);
      if (estimate.lastUsageIndex === null) {
        contextTokens = estimatedMessageTokens(context.messages);
      } else {
        const usageMessage = context.messages[estimate.lastUsageIndex];
        contextTokens =
          compactionEntry &&
          usageMessage.role === "assistant" &&
          usageMessage.timestamp <=
            new Date(compactionEntry.timestamp).getTime()
            ? estimatedMessageTokens(context.messages)
            : estimate.tokens;
      }
    }

    return options.forceThreshold ||
      shouldCompact(contextTokens, contextWindow, this.settings)
      ? this.run("threshold", false)
      : { compacted: false, shouldRetry: false };
  }

  private async abandonRetryableAssistant(
    assistantMessage: AssistantMessage,
  ): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
    try {
      const branch = await this.options.session.getBranch();
      const entry = branch[branch.length - 1];
      if (
        entry?.type !== "message" ||
        entry.message.role !== "assistant" ||
        entry.message.timestamp !== assistantMessage.timestamp ||
        entry.message.provider !== assistantMessage.provider ||
        entry.message.model !== assistantMessage.model ||
        entry.message.stopReason !== assistantMessage.stopReason
      ) {
        return {
          ok: false,
          errorMessage:
            "Automatic retry could not isolate the failed model attempt safely.",
        };
      }
      await this.options.session.moveTo(entry.parentId);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        errorMessage: `Automatic retry could not roll back the failed model attempt: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async run(
    reason: PiCompactionReason,
    willRetry: boolean,
  ): Promise<PiCompactionCheckResult> {
    let started = false;
    let removeParentAbort = () => {};
    try {
      const branch = await this.options.session.getBranch();
      const preparationResult = prepareCompaction(branch, this.settings);
      if (!preparationResult.ok) throw preparationResult.error;
      let preparation = preparationResult.value;
      if (!preparation) return { compacted: false, shouldRetry: false };
      if (
        preparation.messagesToSummarize.length === 0 &&
        preparation.turnPrefixMessages.length === 0
      ) {
        // One oversized older turn can exceed the retained-tail budget by
        // itself. Pi's normal cut then keeps everything. Retry its cut-point
        // selection with the smallest tail so a newer turn can become the
        // boundary and the oversized history is summarized instead of pruned
        // on every outbound request.
        const aggressiveResult = prepareCompaction(branch, {
          ...this.settings,
          keepRecentTokens: 1,
        });
        if (!aggressiveResult.ok) throw aggressiveResult.error;
        preparation = aggressiveResult.value;
        if (
          !preparation ||
          (preparation.messagesToSummarize.length === 0 &&
            preparation.turnPrefixMessages.length === 0)
        ) {
          return { compacted: false, shouldRetry: false };
        }
      }

      const abortController = new AbortController();
      this.activeAbortController = abortController;
      if (this.options.signal?.aborted) abortController.abort();
      else if (this.options.signal) {
        const abort = () => abortController.abort();
        this.options.signal.addEventListener("abort", abort, { once: true });
        removeParentAbort = () =>
          this.options.signal?.removeEventListener("abort", abort);
      }
      started = true;
      this.options.onEvent?.({ type: "start", reason });
      const compactResult = await compact(
        preparation,
        this.options.models,
        this.options.model,
        undefined,
        abortController.signal,
        this.options.thinkingLevel,
      );
      if (!compactResult.ok) throw compactResult.error;
      if (abortController.signal.aborted) {
        this.options.onEvent?.({
          type: "end",
          reason,
          aborted: true,
          willRetry: false,
        });
        return { compacted: false, shouldRetry: false };
      }

      const result = compactResult.value;
      if (!result.summary.trim()) {
        throw new Error("The compaction model returned an empty summary.");
      }
      await this.options.session.appendCompaction(
        result.summary,
        result.firstKeptEntryId,
        result.tokensBefore,
        result.details,
      );
      const context = await this.options.session.buildContext();
      const publicResult: PiCompactionResult = {
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
        estimatedTokensAfter: estimatedMessageTokens(context.messages),
        ...(result.details
          ? { details: result.details as PiCompactionDetails }
          : {}),
      };
      this.options.onEvent?.({
        type: "end",
        reason,
        result: publicResult,
        aborted: false,
        willRetry,
      });
      return {
        compacted: true,
        shouldRetry: willRetry,
        messages: context.messages,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "compaction failed";
      if (started) {
        const aborted = this.activeAbortController?.signal.aborted === true;
        this.options.onEvent?.({
          type: "end",
          reason,
          aborted,
          willRetry: false,
          ...(aborted
            ? {}
            : {
                errorMessage:
                  reason === "overflow"
                    ? `Context overflow recovery failed: ${errorMessage}`
                    : `Auto-compaction failed: ${errorMessage}`,
              }),
        });
      }
      return { compacted: false, shouldRetry: false, errorMessage };
    } finally {
      removeParentAbort();
      this.activeAbortController = undefined;
    }
  }
}

/** Use Aiden's resolved, connection-bound transport for Pi's summary call. */
export function createPiCompactionModels(
  runtime: ResolvedModelRuntime,
): Models {
  const models = createModels();
  const streamSimple: ProviderStreams["streamSimple"] = (
    model,
    context,
    options,
  ) =>
    runtime.streams.streamSimple(model, context, {
      ...options,
      apiKey: options?.apiKey ?? runtime.apiKey,
      headers: runtime.headers
        ? { ...options?.headers, ...runtime.headers }
        : options?.headers,
    });
  const streams: ProviderStreams = {
    stream: streamSimple as ProviderStreams["stream"],
    streamSimple,
  };
  models.setProvider(
    createProvider<Api>({
      id: runtime.model.provider,
      name: runtime.provider.label,
      models: [runtime.model],
      auth: {
        apiKey: {
          name: `${runtime.provider.label} runtime`,
          resolve: async () => ({
            auth: {
              apiKey: runtime.apiKey,
              headers: runtime.headers,
            },
            source: "Aiden generation runtime",
          }),
        },
      },
      api: streams,
    }),
  );
  return models;
}
