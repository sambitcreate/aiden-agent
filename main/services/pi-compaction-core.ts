import { compactionEngineFrom, type CompactionEngine } from "../../renderer/shared/compaction.js";
import { compileVccInWorker } from "./pi-vcc/worker-client.js";
import { VccError } from "./pi-vcc/errors.js";
import { writeDiagnosticEvent } from "./diagnostic-journal.js";
import {
  DEFAULT_COMPACTION_SETTINGS,
  CompactionError,
  calculateContextTokens,
  compact,
  estimateContextTokens,
  estimateTokens,
  prepareCompaction,
  shouldCompact,
  uuidv7,
  type AgentMessage,
  type CompactionSettings,
  type CompactionPreparation,
  type CompactResult,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Models,
  type RetryCallbacks,
  type RetryPolicy,
  type Usage,
} from "@earendil-works/pi-ai";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";
import type { PiSessionEntry, PiSessionPort } from "./pi-session-port.js";

export type PiCompactionReason = "threshold" | "overflow" | "manual";

export interface PiCompactionDetails {
  engine?: CompactionEngine;
  version?: number;
  readFiles: string[];
  modifiedFiles: string[];
}

export interface PiCompactionResult {
  engine?: CompactionEngine;
  durationMs?: number;
  summary: string;
  retainedTail: AgentMessage[];
  tokensBefore: number;
  estimatedTokensAfter: number;
  usage?: Usage;
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
  engine?: CompactionEngine;
  /** Deterministic seam for worker failure/cancellation tests. */
  compileVcc?: typeof compileVccInWorker;
  session: PiSessionPort;
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
  summaryRetry?: RetryPolicy;
  /** Native Pi retry lifecycle callbacks for the isolated summary request. */
  summaryRetryCallbacks?: RetryCallbacks;
}

class PiCompactionSessionError extends Error {
  constructor() {
    super("The Pi compaction journal operation failed.");
    this.name = "PiCompactionSessionError";
  }
}

export class CompactionSummaryBudgetError extends Error {
  readonly name = "CompactionSummaryBudgetError";

  constructor(
    readonly inputTokens: number,
    readonly outputTokens: number,
    readonly safetyTokens: number,
    readonly contextWindowTokens: number,
  ) {
    super("Compaction summary exceeds the selected model context window; use a larger-context model to compact this history.");
  }

  get overBudgetTokens(): number {
    return this.inputTokens + this.outputTokens + this.safetyTokens - this.contextWindowTokens;
  }
}

function budgetDiagnosticFields(error: CompactionSummaryBudgetError) {
  return {
    inputTokens: error.inputTokens,
    outputTokens: error.outputTokens,
    safetyTokens: error.safetyTokens,
    contextWindowTokens: error.contextWindowTokens,
    overBudgetTokens: error.overBudgetTokens,
  };
}

type CompactionRecoveryStage = "local-compiler" | "semantic-summary" | "checkpoint";

/**
 * Closed diagnostic fields for a failed compaction. The caught error's own
 * cause wins; an attempted budget recovery is reported through the recovery
 * stage and budget token counts, and is the top-level cause only when nothing
 * more specific is known.
 */
export function compactionFailureDiagnosticFields(input: {
  error: unknown;
  reason: string;
  sessionFailed: boolean;
  hostFailure?: "inference" | "policy";
  budgetFailure?: CompactionSummaryBudgetError;
  recoveryStage?: CompactionRecoveryStage;
}): Record<string, string | number> {
  const { error, hostFailure, budgetFailure, recoveryStage } = input;
  const budget = error instanceof CompactionSummaryBudgetError ? error : budgetFailure;
  return {
    compactionReason: input.reason,
    compactionFailure: input.sessionFailed ? "journal" :
      error instanceof CompactionSummaryBudgetError ? "summary-budget" :
        error instanceof CompactionError && error.code === "summarization_failed" ? "summary-provider" :
          error instanceof VccError ? "local-compiler" :
            hostFailure === "inference" ? "host-inference" :
              hostFailure === "policy" ? "host-policy" :
                budgetFailure ? "budget-recovery" : "other",
    ...(budget ? budgetDiagnosticFields(budget) : {}),
    ...(recoveryStage ? { recoveryStage } : {}),
    ...(error instanceof VccError ? { localCompilerCause: error.code } : {}),
  };
}

type RecoveryChannel = "history" | "turn-prefix";
const RECOVERY_REDUCTION_ATTEMPTS = 3;

function recoveryMessage(content: string): AgentMessage {
  return { role: "user", content, timestamp: Date.now() };
}

/** The Pi preparation whose single summary request covers only `channel`. */
function recoveryChannelRequest(
  channel: RecoveryChannel,
  messages: AgentMessage[],
  preparation: CompactionPreparation,
): CompactionPreparation {
  return channel === "history"
    ? { ...preparation, messagesToSummarize: messages, turnPrefixMessages: [], isSplitTurn: false }
    : { ...preparation, messagesToSummarize: [], turnPrefixMessages: messages, isSplitTurn: true };
}

/** One prepared compaction channel as a self-contained local-compiler input. */
function recoveryChannelInput(
  messages: readonly AgentMessage[],
  preparation: CompactionPreparation,
  contextWindow: number,
) {
  const branch: PiSessionEntry[] = messages.map((message, index) => ({
    type: "message",
    id: `budget-recovery:${index}`,
    seq: index,
    parentId: index === 0 ? null : `budget-recovery:${index - 1}`,
    timestamp: message.timestamp,
    message,
  }));
  return {
    branch,
    preparation: {
      ...preparation,
      messagesToSummarize: [...messages],
      turnPrefixMessages: [],
      isSplitTurn: false,
      retainedTail: [],
      previousSummary: undefined,
    },
    contextWindow,
  };
}

async function sessionOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new PiCompactionSessionError();
  }
}

function latestCompaction(entries: Awaited<ReturnType<PiSessionPort["getBranch"]>>) {
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
  return tail?.role === "assistant" && (tail.stopReason === "error" || tail.stopReason === "length")
    ? messages.slice(0, -1)
    : [...messages];
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
    // Preserve Pi's defaults when both budgets fit. Small custom/local models
    // otherwise get a non-positive trigger or retain their entire input while
    // repeatedly adding summary checkpoints. Use the existing VCC bounds for
    // those infeasible pairs across every coordinator surface.
    if (
      options.engine === "vcc" ||
      this.settings.reserveTokens >= options.model.contextWindow ||
      this.settings.keepRecentTokens > options.model.contextWindow - this.settings.reserveTokens
    ) {
      this.settings.reserveTokens = Math.min(
        this.settings.reserveTokens,
        Math.floor(options.model.contextWindow / 4),
      );
      this.settings.keepRecentTokens = Math.min(
        this.settings.keepRecentTokens,
        Math.floor((options.model.contextWindow - this.settings.reserveTokens) / 2),
      );
    }
    if (this.settings.enabled && this.settings.reserveTokens < 2) {
      throw new Error("The selected model has insufficient output reserve for compaction.");
    }
  }

  abort(): void {
    this.activeAbortController?.abort();
  }

  private isCurrentModel(message: AssistantMessage): boolean {
    return (
      message.provider === this.options.model.provider &&
      message.model === this.options.model.id
    );
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
  async checkContextPressure(projected?: {
    contextTokens: number;
    compressibleHistoryMessages: number;
    shouldCompact: boolean;
  }): Promise<PiCompactionCheckResult> {
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
    if (projected) {
      if (projected.compressibleHistoryMessages === 0 || !projected.shouldCompact) {
        return { compacted: false, shouldRetry: false, messages: context.messages };
      }
      return this.run("threshold", false, true);
    }
    if (!previousAssistant) return { compacted: false, shouldRetry: false };
    if (!this.isCurrentModel(previousAssistant)) {
      return shouldCompact(estimatedMessageTokens(context.messages), this.options.model.contextWindow, this.settings)
        ? this.run("threshold", false)
        : { compacted: false, shouldRetry: false };
    }
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
        this.isCurrentModel(usageMessage) &&
        usageMessage.timestamp <= new Date(compactionEntry.timestamp).getTime()
      ) {
        return { compacted: false, shouldRetry: false };
      }
      contextTokens = usageMessage?.role === "assistant" && !this.isCurrentModel(usageMessage)
        ? estimatedMessageTokens(context.messages)
        : estimate.tokens;
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
      this.isCurrentModel(assistantMessage) &&
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
          liveMessages = (await sessionOperation(() => this.options.session.buildContext()))
            .messages;
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

    // Provider counters describe the originating model's request. After a
    // switch, measure the actual retained content against the new budget.
    if (!sameModel) {
      try {
        const context = await sessionOperation(() => this.options.session.buildContext());
        return shouldCompact(estimatedMessageTokens(context.messages), contextWindow, this.settings)
          ? this.run("threshold", false)
          : { compacted: false, shouldRetry: false };
      } catch (error) {
        return {
          compacted: false,
          shouldRetry: false,
          failureCode: "session-failed",
          errorMessage: error instanceof Error ? error.message : "Pi journal read failed.",
        };
      }
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
          this.isCurrentModel(usageMessage) &&
          usageMessage.timestamp <= new Date(compactionEntry.timestamp).getTime()
        ) {
          return { compacted: false, shouldRetry: false };
        }
        contextTokens = usageMessage?.role === "assistant" && !this.isCurrentModel(usageMessage)
          ? estimatedMessageTokens(context.messages)
          : estimate.tokens;
      }
    }

    return shouldCompact(contextTokens, contextWindow, this.settings)
      ? this.run("threshold", false)
      : { compacted: false, shouldRetry: false };
  }

  private async run(
    reason: PiCompactionReason,
    willRetry: boolean,
    requireEffectiveInput = false,
  ): Promise<PiCompactionCheckResult> {
    const startedAt = performance.now();
    const engine = compactionEngineFrom(this.options.engine);
    let started = false;
    let budgetFailure: CompactionSummaryBudgetError | undefined;
    let recoveryStage: CompactionRecoveryStage | undefined;
    let removeParentAbort = () => {};
    try {
      const branch = await this.options.session.getBranch();
      const preparationResult = prepareCompaction(branch, this.settings);
      if (!preparationResult.ok) throw preparationResult.error;
      const preparation = preparationResult.value;
      if (!preparation) return { compacted: false, shouldRetry: false };
      if (
        requireEffectiveInput &&
        preparation.messagesToSummarize.length === 0 &&
        preparation.turnPrefixMessages.length === 0
      ) {
        return { compacted: false, shouldRetry: false };
      }

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
      const compileLocal = () => (this.options.compileVcc ?? compileVccInWorker)(
        { branch, preparation, contextWindow: this.options.model.contextWindow },
        abortController.signal,
      );
      const summarize = async (input: CompactionPreparation): Promise<CompactResult> => {
        const compactResult = await compact(
          input,
          boundedCompactionModels(this.options.models),
          this.options.model,
          undefined,
          abortController.signal,
          this.options.thinkingLevel,
          this.options.summaryRetry ?? {
            enabled: true,
            maxRetries: 3,
            baseDelayMs: 2_000,
          },
          this.options.summaryRetryCallbacks,
        );
        if (!compactResult.ok) throw compactResult.error;
        return compactResult.value;
      };
      let result: CompactResult;
      if (engine === "vcc") {
        result = await compileLocal();
      } else {
        try {
          result = await summarize(preparation);
        } catch (error) {
          if (!(error instanceof CompactionSummaryBudgetError)) throw error;
          budgetFailure = error;
          writeDiagnosticEvent({
            level: "warn", area: "generation", event: "compaction-budget-exceeded",
            outcome: "degraded", fields: {
              compactionReason: reason,
              compactionFailure: "summary-budget",
              ...budgetDiagnosticFields(error),
            },
          });
          // The local compiler reduces each prepared channel without publishing
          // a checkpoint. Pi then writes the final semantic summary through its
          // ordinary bounded path, so the prior checkpoint still reaches the
          // update prompt and a split turn still gets its turn-prefix summary.
          recoveryStage = "local-compiler";
          const spareTokensFor = (channel: RecoveryChannel, messages: AgentMessage[]) =>
            summaryRequestSpareTokens(
              recoveryChannelRequest(channel, messages, preparation),
              this.options.model,
              this.options.thinkingLevel,
              abortController.signal,
            );
          const reduceChannel = async (channel: RecoveryChannel, messages: AgentMessage[]): Promise<AgentMessage[]> => {
            // A channel whose own Pi request already fits stays raw.
            if (messages.length === 0 || await spareTokensFor(channel, messages) >= 0) return messages;
            // Budget the reduction against the complete request Pi will send
            // for this channel: its prompt, the preserved prior checkpoint,
            // output allowance and safety reserve all come out of the window.
            let contentBudget = await spareTokensFor(channel, [recoveryMessage("")]);
            for (let attempt = 0; attempt < RECOVERY_REDUCTION_ATTEMPTS && contentBudget > 0; attempt += 1) {
              const local = await (this.options.compileVcc ?? compileVccInWorker)(
                recoveryChannelInput(
                  messages,
                  preparation,
                  contentBudget + preparation.settings.reserveTokens,
                ),
                abortController.signal,
              );
              const reduced = [recoveryMessage(local.summary)];
              const spare = await spareTokensFor(channel, reduced);
              if (spare >= 0) return reduced;
              // The local estimate differs from the request guard (for
              // example on dense Unicode); tighten by the measured overshoot.
              contentBudget += spare;
            }
            throw new VccError("insufficient_reduction");
          };
          const messagesToSummarize = await reduceChannel("history", preparation.messagesToSummarize);
          const turnPrefixMessages = preparation.isSplitTurn
            ? await reduceChannel("turn-prefix", preparation.turnPrefixMessages)
            : preparation.turnPrefixMessages;
          recoveryStage = "semantic-summary";
          result = await summarize({ ...preparation, messagesToSummarize, turnPrefixMessages });
          recoveryStage = "checkpoint";
        }
      }
      if (abortController.signal.aborted) {
        this.options.onEvent?.({
          type: "end",
          reason,
          aborted: true,
          willRetry: false,
        });
        return { compacted: false, shouldRetry: false };
      }

      result.details = { ...(result.details as Record<string, unknown>), engine, version: 1 };
      const priorLeafId = await sessionOperation(() => this.options.session.getLeafId());
      if (priorLeafId !== (branch[branch.length - 1]?.id ?? null)) {
        throw new PiCompactionSessionError();
      }
      const checkpointId = uuidv7();
      const restorePriorLeaf = async () => {
        await sessionOperation(async () => {
          const leafId = await this.options.session.getLeafId();
          // A rejected append may have failed before or after publication.
          if (leafId === priorLeafId) return;
          if (leafId !== checkpointId) {
            throw new Error("The failed compaction checkpoint is no longer the journal leaf.");
          }
          await this.options.session.moveTo(priorLeafId);
        });
      };
      let context;
      try {
        await sessionOperation(() =>
          this.options.session.appendCompaction({
            id: checkpointId,
            summary: result.summary,
            retainedTail: result.retainedTail,
            tokensBefore: result.tokensBefore,
            ...(result.details === undefined ? {} : { details: result.details }),
            ...(result.usage === undefined ? {} : { usage: result.usage }),
          }),
        );
        context = await sessionOperation(() => this.options.session.buildContext());
      } catch (error) {
        // Publication is not successful until its context can be installed.
        // Keep failed checkpoints as history, but restore the active branch.
        await restorePriorLeaf();
        throw error;
      }
      if (abortController.signal.aborted) {
        await restorePriorLeaf();
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
        engine,
        durationMs: Math.round(performance.now() - startedAt),
        summary: result.summary,
        retainedTail: result.retainedTail,
        tokensBefore: result.tokensBefore,
        estimatedTokensAfter: estimatedMessageTokens(context.messages),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        ...(result.details ? { details: result.details as PiCompactionDetails } : {}),
      };
      if (budgetFailure) {
        writeDiagnosticEvent({
          level: "info", area: "generation", event: "compaction-budget-recovered",
          outcome: "recovered", fields: {
            compactionReason: reason,
            compactionFailure: "summary-budget",
            ...budgetDiagnosticFields(budgetFailure),
          },
        });
      }
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
      const aborted = this.activeAbortController?.signal.aborted === true;
      if (!aborted) {
        writeDiagnosticEvent({
          level: "warn", area: "generation", event: "compaction-failed",
          outcome: "failed", fields: compactionFailureDiagnosticFields({
            error, reason, sessionFailed, hostFailure, budgetFailure, recoveryStage,
          }),
        });
      }
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

/** Estimated size of one summary request; this is not a provider tokenizer. */
function summaryRequestTokens(...[model, context, options]: Parameters<Models["completeSimple"]>) {
  // Pi's ASCII heuristic undercounts high-density Unicode. Reserve UTF-8 bytes
  // for non-ASCII text; keep the existing content estimate for the remainder.
  const unicodeAllowance = (text: string) => {
    const nonAscii = text.replace(/\p{ASCII}/gu, "");
    return Buffer.byteLength(nonAscii, "utf8") - nonAscii.length / 4;
  };
  const systemPrompt = context.systemPrompt ?? "";
  const inputTokens = Math.ceil(systemPrompt.length / 4 + unicodeAllowance(systemPrompt)) +
    context.messages.reduce((total, message) => {
      const text = typeof message.content === "string" ? message.content : message.content
        .flatMap((part) => part.type === "text" ? [part.text] : []).join("");
      return total + estimateTokens(message) + Math.ceil(unicodeAllowance(text));
    }, 0);
  const outputTokens = options?.maxTokens ?? model.maxTokens;
  const safetyTokens = Math.max(64, Math.ceil(model.contextWindow * 0.05));
  return { inputTokens, outputTokens, safetyTokens, contextWindow: model.contextWindow };
}

class SummaryRequestProbe extends Error {
  readonly name = "SummaryRequestProbe";

  constructor(readonly spareTokens: number) {
    super("summary request probe");
  }
}

/**
 * Window tokens left over by the one summary request Pi would send for `input`
 * (negative when it would be rejected). Pi builds the real prompt; the probe
 * measures it and stops before any provider I/O.
 */
async function summaryRequestSpareTokens(
  input: CompactionPreparation,
  model: ResolvedModelRuntime["model"],
  thinkingLevel: ThinkingLevel,
  signal: AbortSignal,
): Promise<number> {
  const probe = {
    completeSimple: (...args: Parameters<Models["completeSimple"]>) => {
      const size = summaryRequestTokens(...args);
      throw new SummaryRequestProbe(
        size.contextWindow - size.inputTokens - size.outputTokens - size.safetyTokens,
      );
    },
  } as unknown as Models;
  try {
    await compact(input, probe, model, undefined, signal, thinkingLevel, {
      enabled: false,
      maxRetries: 0,
      baseDelayMs: 0,
    });
  } catch (error) {
    if (error instanceof SummaryRequestProbe) return error.spareTokens;
    throw error;
  }
  signal.throwIfAborted();
  throw new Error("Compaction summary request could not be measured.");
}

/** Fail closed on estimated summary overflow before provider I/O. */
function boundedCompactionModels(models: Models): Models {
  const assertFits = (...args: Parameters<Models["completeSimple"]>) => {
    const { inputTokens, outputTokens, safetyTokens, contextWindow } = summaryRequestTokens(...args);
    if (inputTokens + outputTokens + safetyTokens > contextWindow) {
      throw new CompactionSummaryBudgetError(inputTokens, outputTokens, safetyTokens, contextWindow);
    }
  };
  return new Proxy(models, {
    get(target, property) {
      if (property === "completeSimple") return (...args: Parameters<Models["completeSimple"]>) => {
        assertFits(...args);
        return models.completeSimple(...args);
      };
      if (property === "streamSimple") return (...args: Parameters<Models["streamSimple"]>) => {
        assertFits(...args);
        return models.streamSimple(...args);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Models;
}
