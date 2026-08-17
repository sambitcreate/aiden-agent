import {
  DEFAULT_COMPACTION_SETTINGS,
  calculateContextTokens,
  compact,
  estimateContextTokens,
  estimateTokens,
  prepareCompaction,
  shouldCompact,
  uuidv7,
  type AgentMessage,
  type CompactionSettings,
  type Session,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Models,
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
  /** The checked assistant was removed from the durable branch. */
  assistantAbandoned?: boolean;
  /** Pi-reconstructed state to install on the live Agent after compaction. */
  messages?: AgentMessage[];
  errorMessage?: string;
  failureCode?:
    | "context-overflow"
    | "retry-exhausted"
    | "compaction-failed"
    | "host-inference"
    | "host-policy"
    | "session-failed"
    | "unsafe-rollback";
  retryDelayMs?: number;
}

export interface PiCompactionCoordinatorOptions {
  session: Session;
  models: Models;
  model: ResolvedModelRuntime["model"];
  thinkingLevel: ThinkingLevel;
  consumeHostFailure?: () => "inference" | "policy" | undefined;
  settings?: CompactionSettings;
  signal?: AbortSignal;
  onEvent?: (event: PiCompactionEvent) => void;
  /** Bounded host backoff for transient provider/transport retries. */
  retryDelayMs?: number;
  /** Current-Pi-compatible retry policy for each standalone hidden summary request. */
  summaryRetry?: {
    enabled: boolean;
    maxRetries: number;
    baseDelayMs: number;
  };
}

class PiCompactionSessionError extends Error {
  constructor() {
    super("The Pi compaction journal operation failed.");
    this.name = "PiCompactionSessionError";
  }
}

async function sessionOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new PiCompactionSessionError();
  }
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

function withoutRetryableAssistantTail(messages: readonly AgentMessage[]): AgentMessage[] {
  const tail = messages[messages.length - 1];
  return tail?.role === "assistant" &&
    (tail.stopReason === "error" || tail.stopReason === "length")
    ? messages.slice(0, -1)
    : [...messages];
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const abort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    const timeout = setTimeout(
      () => {
        signal?.removeEventListener("abort", abort);
        resolve(true);
      },
      Math.max(0, delayMs),
    );
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Mirror current Pi's standalone summary request isolation and retry loop. */
function createUpstreamSummaryModels(
  models: Models,
  retry: NonNullable<PiCompactionCoordinatorOptions["summaryRetry"]>,
): Models {
  return new Proxy(models, {
    get(target, property, receiver) {
      if (property === "completeSimple") {
        return async (...args: Parameters<Models["completeSimple"]>) => {
          const [model, context, options] = args;
          const requestOptions = {
            ...options,
            cacheRetention: "none" as const,
            sessionId: uuidv7(),
          };
          const maxRetries = retry.enabled ? Math.max(0, Math.floor(retry.maxRetries)) : 0;
          let attempt = 0;
          for (;;) {
            const message = await target.completeSimple(model, context, requestOptions);
            if (
              message.stopReason !== "error" ||
              !isRetryableAssistantError(message) ||
              attempt >= maxRetries
            ) {
              return message;
            }
            attempt += 1;
            const continued = await abortableDelay(
              Math.max(0, retry.baseDelayMs) * 2 ** (attempt - 1),
              requestOptions.signal,
            );
            if (!continued) {
              return {
                ...message,
                stopReason: "aborted",
                errorMessage: undefined,
              };
            }
          }
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Pi coding-agent's auto-compaction orchestration, expressed against the Pi
 * Core session APIs Aiden already ships. Cut points, prompts, summaries,
 * split-turn behavior, and context reconstruction remain owned by Pi Core.
 */
export class PiCompactionCoordinator {
  private readonly settings: CompactionSettings;
  private overflowRecoveryAttempted = false;
  private providerRetryAttempted = false;
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

  /** Compact the prior durable tail before a new user entry is appended. */
  async prepareForPrompt(): Promise<PiCompactionCheckResult> {
    const context = await this.options.session.buildContext();
    const previousAssistant = [...context.messages]
      .reverse()
      .find((message): message is AssistantMessage => message.role === "assistant");
    if (!previousAssistant) {
      return {
        compacted: false,
        shouldRetry: false,
        messages: context.messages,
      };
    }
    const result = await this.check(previousAssistant, {
      includeAborted: true,
      allowProviderRetry: false,
    });
    // This check repairs the previous turn; retry admission belongs only to
    // the new top-level operation and is reset by beginPrompt().
    const repaired = result.shouldRetry ? { ...result, shouldRetry: false } : result;
    return repaired.messages ? repaired : { ...repaired, messages: context.messages };
  }

  /** Check the reconstructed journal before provider I/O, including the new user turn. */
  async checkContextPressure(): Promise<PiCompactionCheckResult> {
    if (!this.settings.enabled) return { compacted: false, shouldRetry: false };
    let branch;
    let context;
    try {
      branch = await sessionOperation(() => this.options.session.getBranch());
      context = await sessionOperation(() => this.options.session.buildContext());
    } catch (error) {
      return {
        compacted: false,
        shouldRetry: false,
        errorMessage: error instanceof Error ? error.message : "Pi journal read failed.",
        failureCode: "session-failed",
      };
    }
    const compactionEntry = latestCompaction(branch);
    const previousAssistant = [...context.messages]
      .reverse()
      .find((message): message is AssistantMessage => message.role === "assistant");
    if (!previousAssistant) return { compacted: false, shouldRetry: false };
    if (
      compactionEntry &&
      previousAssistant.timestamp <= new Date(compactionEntry.timestamp).getTime()
    ) {
      return { compacted: false, shouldRetry: false };
    }
    const directContextTokens = previousAssistant.usage
      ? calculateContextTokens(previousAssistant.usage)
      : 0;
    let contextTokens = directContextTokens;
    if (previousAssistant.stopReason === "error" || directContextTokens === 0) {
      const estimate = estimateContextTokens(context.messages);
      if (estimate.lastUsageIndex === null) {
        return { compacted: false, shouldRetry: false };
      }
      const usageMessage = context.messages[estimate.lastUsageIndex];
      if (
        compactionEntry &&
        usageMessage?.role === "assistant" &&
        usageMessage.timestamp <= new Date(compactionEntry.timestamp).getTime()
      ) {
        return { compacted: false, shouldRetry: false };
      }
      contextTokens = estimate.tokens;
    }
    if (!shouldCompact(contextTokens, this.options.model.contextWindow, this.settings)) {
      return { compacted: false, shouldRetry: false };
    }
    return this.run("threshold", false);
  }

  async check(
    assistantMessage: AssistantMessage,
    options: {
      includeAborted?: boolean;
      allowProviderRetry?: boolean;
      /** Current in-memory agent context, which may omit durable failed attempts. */
      liveMessages?: readonly AgentMessage[];
    } = {},
  ): Promise<PiCompactionCheckResult> {
    if (!this.settings.enabled) return { compacted: false, shouldRetry: false };
    if (!options.includeAborted && assistantMessage.stopReason === "aborted") {
      return { compacted: false, shouldRetry: false };
    }

    let branch;
    try {
      branch = await sessionOperation(() => this.options.session.getBranch());
    } catch (error) {
      return {
        compacted: false,
        shouldRetry: false,
        errorMessage: error instanceof Error ? error.message : "Pi journal read failed.",
        failureCode: "session-failed",
      };
    }
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
    if (assistantMessage.stopReason !== "error" && assistantMessage.stopReason !== "length") {
      this.overflowRecoveryAttempted = false;
    }
    if (assistantMessage.stopReason !== "error") {
      this.providerRetryAttempted = false;
    }
    const recoverableLength =
      assistantMessage.stopReason === "length" &&
      this.options.model.maxTokens > 0 &&
      assistantMessage.usage.output < this.options.model.maxTokens;

    if (sameModel && (isContextOverflow(assistantMessage, contextWindow) || recoverableLength)) {
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
        return {
          compacted: false,
          shouldRetry: false,
          errorMessage,
          failureCode: "retry-exhausted",
        };
      }
      this.overflowRecoveryAttempted = true;
      return this.run("overflow", true);
    }

    if (options.allowProviderRetry !== false && isRetryableAssistantError(assistantMessage)) {
      let liveMessages = options.liveMessages;
      if (!liveMessages) {
        try {
          liveMessages = (await sessionOperation(() => this.options.session.buildContext())).messages;
        } catch (error) {
          return {
            compacted: false,
            shouldRetry: false,
            errorMessage: error instanceof Error ? error.message : "Pi journal read failed.",
            failureCode: "session-failed",
          };
        }
      }
      const retryMessages = withoutRetryableAssistantTail(liveMessages);
      if (this.providerRetryAttempted) {
        this.providerRetryAttempted = false;
        return {
          compacted: false,
          shouldRetry: false,
          messages: retryMessages,
          errorMessage:
            "The provider failed again after one automatic retry. Try again in a moment or switch models.",
          failureCode: "retry-exhausted",
        };
      }
      this.providerRetryAttempted = true;
      return {
        compacted: false,
        shouldRetry: true,
        messages: retryMessages,
        retryDelayMs: Math.max(0, Math.min(5_000, this.options.retryDelayMs ?? 500)),
      };
    }

    const directContextTokens = assistantMessage.usage
      ? calculateContextTokens(assistantMessage.usage)
      : 0;
    let contextTokens = directContextTokens;
    if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
      let context;
      try {
        context = await sessionOperation(() => this.options.session.buildContext());
      } catch (error) {
        return {
          compacted: false,
          shouldRetry: false,
          errorMessage: error instanceof Error ? error.message : "Pi journal read failed.",
          failureCode: "session-failed",
        };
      }
      const estimate = estimateContextTokens(context.messages);
      if (estimate.lastUsageIndex === null) {
        return { compacted: false, shouldRetry: false };
      } else {
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
      const summaryModels = createUpstreamSummaryModels(
        this.options.models,
        this.options.summaryRetry ?? {
          enabled: true,
          maxRetries: 3,
          baseDelayMs: 2_000,
        },
      );
      const compactResult = await compact(
        preparation,
        summaryModels,
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
      const priorLeafId = await sessionOperation(() => this.options.session.getLeafId());
      const checkpointId = await sessionOperation(() =>
        this.options.session.appendCompaction(
          result.summary,
          result.firstKeptEntryId,
          result.tokensBefore,
          result.details,
        ),
      );
      const context = await sessionOperation(() => this.options.session.buildContext());
      if (abortController.signal.aborted) {
        await sessionOperation(async () => {
          if ((await this.options.session.getLeafId()) !== checkpointId) {
            throw new Error("The cancelled compaction checkpoint is no longer the journal leaf.");
          }
          await this.options.session.moveTo(priorLeafId);
        });
        this.options.onEvent?.({
          type: "end",
          reason,
          aborted: true,
          willRetry: false,
        });
        return { compacted: false, shouldRetry: false };
      }
      const messages = willRetry
        ? withoutRetryableAssistantTail(context.messages)
        : context.messages;
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
        messages,
      };
    } catch (error) {
      const hostFailure = this.options.consumeHostFailure?.();
      const sessionFailed = error instanceof PiCompactionSessionError;
      const errorMessage = hostFailure
        ? hostFailure === "policy"
          ? "The main-owned provider hook failed during compaction."
          : "The isolated inference process failed during compaction."
        : sessionFailed
          ? error.message
          : error instanceof Error
            ? error.message
            : "compaction failed";
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
      return {
        compacted: false,
        shouldRetry: false,
        errorMessage,
        failureCode: hostFailure
          ? hostFailure === "policy"
            ? "host-policy"
            : "host-inference"
          : sessionFailed
            ? "session-failed"
            : reason === "overflow"
              ? "context-overflow"
              : "compaction-failed",
      };
    } finally {
      removeParentAbort();
      this.activeAbortController = undefined;
    }
  }
}

/** Use Aiden's resolved, connection-bound transport for Pi's summary call. */
export function createPiCompactionModels(
  runtime: ResolvedModelRuntime,
  onAssistantMessage?: (message: AssistantMessage) => void | Promise<void>,
): Models {
  const streamSimple: Models["streamSimple"] = (model, context, options) => {
    const stream = runtime.models.getModel(model.provider, model.id)
      ? runtime.models.streamSimple(model, context, options)
      : runtime.streams.streamSimple(model, context, {
          ...options,
          apiKey: options?.apiKey ?? runtime.apiKey,
          headers: runtime.headers ? { ...options?.headers, ...runtime.headers } : options?.headers,
        });
    if (!onAssistantMessage) return stream;
    const accountedResult = stream.result().then(async (message) => {
      await onAssistantMessage(message);
      return message;
    });
    return new Proxy(stream, {
      get(target, property, receiver) {
        if (property === "result") return () => accountedResult;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AssistantMessageEventStream;
  };
  return new Proxy(runtime.models, {
    get(target, property) {
      if (property === "streamSimple") return streamSimple;
      if (property === "completeSimple") {
        return (...args: Parameters<Models["completeSimple"]>) => streamSimple(...args).result();
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Models;
}

