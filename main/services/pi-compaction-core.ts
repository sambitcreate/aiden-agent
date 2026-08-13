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
  type Api,
  type AssistantMessage,
  type Models,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";

export type PiCompactionReason = "threshold" | "overflow" | "manual";

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
}

export interface PiCompactionCoordinatorOptions {
  session: Session;
  models: Models;
  model: ResolvedModelRuntime["model"];
  thinkingLevel: ThinkingLevel;
  settings?: CompactionSettings;
  signal?: AbortSignal;
  onEvent?: (event: PiCompactionEvent) => void;
}

function latestCompaction(entries: Awaited<ReturnType<Session["getBranch"]>>) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "compaction") return entry;
  }
  return undefined;
}

function estimatedMessageTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

/**
 * Pi coding-agent's auto-compaction orchestration, expressed against the Pi
 * Core session APIs Aiden already ships. Cut points, prompts, summaries,
 * split-turn behavior, and context reconstruction remain owned by Pi Core.
 */
export class PiCompactionCoordinator {
  private readonly settings: CompactionSettings;
  private overflowRecoveryAttempted = false;
  private activeAbortController?: AbortController;

  constructor(private readonly options: PiCompactionCoordinatorOptions) {
    this.settings = {
      ...DEFAULT_COMPACTION_SETTINGS,
      ...options.settings,
    };
  }

  abort(): void {
    this.activeAbortController?.abort();
  }

  /** Pi resets overflow recovery when a new user prompt enters the agent. */
  beginPrompt(): void {
    this.overflowRecoveryAttempted = false;
  }

  /** Run the same Pi-owned compaction path on an explicit operator request. */
  compact(): Promise<PiCompactionCheckResult> {
    return this.run("manual", false);
  }

  async check(
    assistantMessage: AssistantMessage,
    options: { includeAborted?: boolean } = {},
  ): Promise<PiCompactionCheckResult> {
    if (!this.settings.enabled) return { compacted: false, shouldRetry: false };
    if (!options.includeAborted && assistantMessage.stopReason === "aborted") {
      return { compacted: false, shouldRetry: false };
    }

    const branch = await this.options.session.getBranch();
    const compactionEntry = latestCompaction(branch);
    if (
      compactionEntry &&
      assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime()
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
      if (this.overflowRecoveryAttempted) {
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
      this.overflowRecoveryAttempted = true;
      return this.run("overflow", true);
    }

    const directContextTokens = assistantMessage.usage
      ? calculateContextTokens(assistantMessage.usage)
      : 0;
    let contextTokens = directContextTokens;
    if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
      const context = await this.options.session.buildContext();
      const estimate = estimateContextTokens(context.messages);
      if (estimate.lastUsageIndex === null) {
        return { compacted: false, shouldRetry: false };
      }
      const usageMessage = context.messages[estimate.lastUsageIndex];
      if (
        compactionEntry &&
        usageMessage.role === "assistant" &&
        usageMessage.timestamp <= new Date(compactionEntry.timestamp).getTime()
      ) {
        return { compacted: false, shouldRetry: false };
      }
      contextTokens = estimate.tokens;
    }

    return shouldCompact(contextTokens, contextWindow, this.settings)
      ? this.run("threshold", false)
      : { compacted: false, shouldRetry: false };
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
      const preparation = preparationResult.value;
      if (!preparation) return { compacted: false, shouldRetry: false };

      const abortController = new AbortController();
      this.activeAbortController = abortController;
      if (this.options.signal?.aborted) abortController.abort();
      else if (this.options.signal) {
        const abort = () => abortController.abort();
        this.options.signal.addEventListener("abort", abort, { once: true });
        removeParentAbort = () => this.options.signal?.removeEventListener("abort", abort);
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
        ...(result.details ? { details: result.details as PiCompactionDetails } : {}),
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
      const errorMessage = error instanceof Error ? error.message : "compaction failed";
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
export function createPiCompactionModels(runtime: ResolvedModelRuntime): Models {
  const models = createModels();
  const streamSimple: ProviderStreams["streamSimple"] = (model, context, options) =>
    runtime.streams.streamSimple(model, context, {
      ...options,
      apiKey: options?.apiKey ?? runtime.apiKey,
      headers: runtime.headers ? { ...options?.headers, ...runtime.headers } : options?.headers,
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
