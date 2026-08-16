import {
  DEFAULT_COMPACTION_SETTINGS,
  calculateContextTokens,
  compact,
  estimateContextTokens,
  estimateTokens,
  generateSummary,
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
  type AssistantMessageEventStream,
  type Models,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";
import { projectMessagesForModel } from "./generation-context.js";
import { AIDEN_CHAT_MESSAGE_MARKER, AIDEN_PI_TRANSACTION } from "./pi-compaction-session-store.js";

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
  /** The checked assistant was removed from the durable branch. */
  assistantAbandoned?: boolean;
  /** Pi-reconstructed state to install on the live Agent after compaction. */
  messages?: AgentMessage[];
  errorMessage?: string;
  failureCode?:
    | "context-overflow"
    | "retry-exhausted"
    | "compaction-failed"
    | "session-failed"
    | "unsafe-rollback";
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

const SPLIT_SUMMARY_MARKER = "\n\n---\n\n**Turn Context (split turn):**\n\n";
const STRUCTURED_HEADINGS = [
  "Goal",
  "Constraints & Preferences",
  "Progress",
  "Key Decisions",
  "Next Steps",
  "Critical Context",
];
const SPLIT_HEADINGS = ["Original Request", "Early Progress", "Context for Suffix"];

function hasHeadings(summary: string, headings: readonly string[]): boolean {
  return headings.every((heading) => new RegExp(`^## ${heading}`, "mu").test(summary));
}

function validStructuredSummary(summary: string): boolean {
  return hasHeadings(summary, STRUCTURED_HEADINGS);
}

function validFinalCompactionSummary(
  summary: string,
  preparation: { isSplitTurn: boolean; messagesToSummarize: AgentMessage[] },
): boolean {
  if (!preparation.isSplitTurn) return validStructuredSummary(summary);
  const markerIndex = summary.indexOf(SPLIT_SUMMARY_MARKER);
  if (markerIndex < 0 || summary.indexOf(SPLIT_SUMMARY_MARKER, markerIndex + 1) >= 0) {
    return false;
  }
  const history = summary.slice(0, markerIndex).trim();
  const prefix = summary.slice(markerIndex + SPLIT_SUMMARY_MARKER.length);
  return (
    (preparation.messagesToSummarize.length > 0
      ? validStructuredSummary(history)
      : history === "No prior history.") && hasHeadings(prefix, SPLIT_HEADINGS)
  );
}

function requireCompleteSummaryModels(models: Models): Models {
  return new Proxy(models, {
    get(target, property, receiver) {
      if (property === "completeSimple") {
        return async (...args: Parameters<Models["completeSimple"]>) => {
          const message = await target.completeSimple(...args);
          if (message.stopReason === "length" || message.stopReason === "toolUse") {
            throw new Error(
              `The compaction model stopped before completing its summary (${message.stopReason}).`,
            );
          }
          return message;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function compactionTranscript(messages: readonly AgentMessage[]): string {
  return messages
    .map((message) =>
      JSON.stringify(message, (_key, value) =>
        value && typeof value === "object" && (value as { type?: unknown }).type === "image"
          ? {
              type: "image",
              mimeType: (value as { mimeType?: unknown }).mimeType,
              note: "binary image retained in the private journal",
            }
          : value,
      ),
    )
    .join("\n");
}

/** Map-reduce oversized history so the summary request cannot overflow too. */
async function collapseOversizedCompactionInput(options: {
  messages: readonly AgentMessage[];
  models: Models;
  model: import("@earendil-works/pi-ai").Model<Api>;
  reserveTokens: number;
  signal: AbortSignal;
  thinkingLevel: ThinkingLevel;
}): Promise<AgentMessage[]> {
  const fixedPiSafetyTokens = Math.min(4_096, Math.floor(options.model.contextWindow * 0.25));
  const requestedOutputTokens = Math.max(
    1,
    Math.min(
      Math.floor(options.reserveTokens * 0.8),
      options.model.maxTokens > 0 ? options.model.maxTokens : Number.POSITIVE_INFINITY,
    ),
  );
  const promptOverheadTokens = Math.min(1_200, Math.floor(options.model.contextWindow * 0.15));
  const safeInputTokens = Math.max(
    128,
    options.model.contextWindow -
      fixedPiSafetyTokens -
      requestedOutputTokens -
      promptOverheadTokens,
  );
  if (estimatedMessageTokens(options.messages) <= safeInputTokens) {
    return [...options.messages];
  }
  const transcript = compactionTranscript(options.messages);
  let accumulated: string | undefined;
  let offset = 0;
  let index = 0;
  while (offset < transcript.length) {
    const accumulatedTokens = Math.ceil((accumulated?.length ?? 0) / 3);
    const availableSourceTokens = Math.max(128, safeInputTokens - accumulatedTokens);
    const fragmentCharacters = Math.max(384, availableSourceTokens * 3);
    const fragment = transcript.slice(offset, offset + fragmentCharacters);
    const estimatedFragmentCount = Math.max(
      index + 1,
      index + Math.ceil((transcript.length - offset) / fragmentCharacters),
    );
    const result = await generateSummary(
      [
        {
          role: "user",
          content: `Compaction source fragment ${index + 1} of approximately ${estimatedFragmentCount}:\n\n${fragment}`,
          timestamp: Date.now(),
        },
      ],
      options.models,
      options.model,
      options.reserveTokens,
      options.signal,
      "Preserve exact requests, decisions, identifiers, paths, errors, tool outcomes, and unresolved work across every fragment.",
      accumulated,
      options.thinkingLevel,
    );
    if (!result.ok) throw result.error;
    if (!validStructuredSummary(result.value)) {
      throw new Error("The compaction model returned a malformed intermediate summary.");
    }
    accumulated = result.value;
    offset += fragment.length;
    index += 1;
  }
  return [
    {
      role: "user",
      content: `Structured map-reduce summary of oversized journal history:\n\n${accumulated ?? ""}`,
      timestamp: Date.now(),
    },
  ];
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
      Math.max(1, Math.floor(options.settings?.reserveTokens ?? defaultReserveTokens)),
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
        Math.max(1, Math.floor(options.settings?.keepRecentTokens ?? defaultKeepRecentTokens)),
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

  /**
   * Repair or compact the prior durable tail before a new user entry is
   * appended. Retryable/error assistants must still be the journal tail for
   * exact abandonment, so this intentionally runs before beginPrompt().
   */
  async prepareForPrompt(): Promise<PiCompactionCheckResult> {
    const context = await this.options.session.buildContext();
    const previousAssistant = [...context.messages]
      .reverse()
      .find((message): message is AssistantMessage => message.role === "assistant");
    if (!previousAssistant) {
      return { compacted: false, shouldRetry: false, messages: context.messages };
    }
    if (
      previousAssistant.stopReason === "error" ||
      previousAssistant.stopReason === "aborted" ||
      previousAssistant.stopReason === "length"
    ) {
      const abandoned = await this.abandonRetryableAssistant(previousAssistant);
      if (!abandoned.ok) {
        return {
          compacted: false,
          shouldRetry: false,
          errorMessage: abandoned.errorMessage,
          failureCode: "unsafe-rollback",
        };
      }
      return {
        compacted: false,
        shouldRetry: false,
        messages: (await this.options.session.buildContext()).messages,
      };
    }
    const result = await this.check(previousAssistant, {
      includeAborted: true,
    });
    // This check repairs the previous turn; retry admission belongs only to
    // the new top-level operation and is reset by beginPrompt().
    return result.shouldRetry ? { ...result, shouldRetry: false } : result;
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
    const estimate = estimateContextTokens(context.messages);
    const heuristicTokens = estimatedMessageTokens(context.messages);
    const usageMessage =
      estimate.lastUsageIndex === null ? undefined : context.messages[estimate.lastUsageIndex];
    const usageIsStale =
      compactionEntry &&
      usageMessage?.role === "assistant" &&
      usageMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
    const contextTokens = usageIsStale
      ? heuristicTokens
      : Math.max(estimate.tokens, heuristicTokens);
    if (
      !options.forceThreshold &&
      !shouldCompact(contextTokens, this.options.model.contextWindow, this.settings)
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

    if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
      const willRetry = assistantMessage.stopReason !== "stop";
      if (!willRetry) return this.run("overflow", false);
      const abandoned = await this.abandonRetryableAssistant(assistantMessage);
      if (!abandoned.ok) {
        return {
          compacted: false,
          shouldRetry: false,
          errorMessage: abandoned.errorMessage,
          failureCode: "unsafe-rollback",
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
        return {
          compacted: false,
          shouldRetry: false,
          assistantAbandoned: true,
          errorMessage,
          failureCode: "retry-exhausted",
        };
      }
      this.retryRecoveryAttempted = true;
      return { ...(await this.run("overflow", true)), assistantAbandoned: true };
    }

    if (isRetryableAssistantError(assistantMessage)) {
      const abandoned = await this.abandonRetryableAssistant(assistantMessage);
      if (!abandoned.ok) {
        return {
          compacted: false,
          shouldRetry: false,
          errorMessage: abandoned.errorMessage,
          failureCode: "unsafe-rollback",
        };
      }
      let context;
      try {
        context = await sessionOperation(() => this.options.session.buildContext());
      } catch (error) {
        return {
          compacted: false,
          shouldRetry: false,
          assistantAbandoned: true,
          errorMessage: error instanceof Error ? error.message : "Pi journal read failed.",
          failureCode: "session-failed",
        };
      }
      if (this.retryRecoveryAttempted) {
        return {
          compacted: false,
          shouldRetry: false,
          messages: context.messages,
          assistantAbandoned: true,
          errorMessage:
            "The provider failed again after one automatic retry. Try again in a moment or switch models.",
          failureCode: "retry-exhausted",
        };
      }
      this.retryRecoveryAttempted = true;
      return {
        compacted: false,
        shouldRetry: true,
        messages: context.messages,
        assistantAbandoned: true,
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
        contextTokens = estimatedMessageTokens(context.messages);
      } else {
        const usageMessage = context.messages[estimate.lastUsageIndex];
        contextTokens =
          compactionEntry &&
          usageMessage.role === "assistant" &&
          usageMessage.timestamp <= new Date(compactionEntry.timestamp).getTime()
            ? estimatedMessageTokens(context.messages)
            : estimate.tokens;
      }
    }

    return options.forceThreshold || shouldCompact(contextTokens, contextWindow, this.settings)
      ? this.run("threshold", false)
      : { compacted: false, shouldRetry: false };
  }

  private async abandonRetryableAssistant(
    assistantMessage: AssistantMessage,
  ): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
    let originalLeafId: string | null | undefined;
    let moved = false;
    try {
      originalLeafId = await sessionOperation(() => this.options.session.getLeafId());
      const branch = await sessionOperation(() => this.options.session.getBranch());
      let entryIndex = branch.length - 1;
      while (entryIndex >= 0) {
        const candidate = branch[entryIndex];
        if (
          candidate?.type !== "custom" ||
          (candidate.customType !== AIDEN_PI_TRANSACTION &&
            candidate.customType !== AIDEN_CHAT_MESSAGE_MARKER)
        ) {
          break;
        }
        entryIndex -= 1;
      }
      const entry = branch[entryIndex];
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
          errorMessage: "Automatic retry could not isolate the failed model attempt safely.",
        };
      }
      let rollbackTarget = entry.parentId;
      const transactionBegin = branch.find((candidate) => candidate.id === entry.parentId);
      if (
        transactionBegin?.type === "custom" &&
        transactionBegin.customType === AIDEN_PI_TRANSACTION &&
        transactionBegin.data &&
        typeof transactionBegin.data === "object"
      ) {
        const begin = transactionBegin.data as {
          transactionId?: unknown;
          phase?: unknown;
        };
        const hasMatchingCommit = branch.slice(entryIndex + 1).some((candidate) => {
          if (
            candidate.type !== "custom" ||
            candidate.customType !== AIDEN_PI_TRANSACTION ||
            !candidate.data ||
            typeof candidate.data !== "object"
          ) {
            return false;
          }
          const marker = candidate.data as {
            transactionId?: unknown;
            phase?: unknown;
          };
          return (
            begin.phase === "begin" &&
            typeof begin.transactionId === "string" &&
            marker.phase === "commit" &&
            marker.transactionId === begin.transactionId
          );
        });
        if (hasMatchingCommit) rollbackTarget = transactionBegin.parentId;
      }
      const rollbackIndex = branch.findIndex((candidate) => candidate.id === rollbackTarget);
      const prefix = rollbackIndex >= 0 ? branch.slice(0, rollbackIndex + 1) : [];
      const openCommittedTransactions = new Map<string, boolean>();
      for (const candidate of prefix) {
        if (
          candidate.type !== "custom" ||
          candidate.customType !== AIDEN_PI_TRANSACTION ||
          !candidate.data ||
          typeof candidate.data !== "object"
        ) {
          continue;
        }
        const marker = candidate.data as {
          transactionId?: unknown;
          phase?: unknown;
        };
        if (typeof marker.transactionId !== "string") continue;
        if (marker.phase === "begin") {
          openCommittedTransactions.set(marker.transactionId, false);
        } else if (marker.phase === "commit") {
          openCommittedTransactions.delete(marker.transactionId);
        }
      }
      for (const transactionId of openCommittedTransactions.keys()) {
        const wasCommitted = branch.slice(rollbackIndex + 1).some((candidate) => {
          if (
            candidate.type !== "custom" ||
            candidate.customType !== AIDEN_PI_TRANSACTION ||
            !candidate.data ||
            typeof candidate.data !== "object"
          ) {
            return false;
          }
          const marker = candidate.data as {
            transactionId?: unknown;
            phase?: unknown;
          };
          return marker.transactionId === transactionId && marker.phase === "commit";
        });
        openCommittedTransactions.set(transactionId, wasCommitted);
      }
      await this.options.session.moveTo(rollbackTarget);
      moved = true;
      // Rolling back a failed assistant's inner append transaction can also
      // remove a later commit for an enclosing, already-durable visible turn.
      // Re-close only envelopes that were committed on the original branch;
      // the current in-flight visible lease intentionally remains open.
      for (const [transactionId, wasCommitted] of openCommittedTransactions) {
        if (!wasCommitted) continue;
        await this.options.session.appendCustomEntry(AIDEN_PI_TRANSACTION, {
          transactionId,
          phase: "commit",
        });
      }
      return { ok: true };
    } catch (error) {
      let restorationError: unknown;
      if (moved && originalLeafId !== undefined) {
        try {
          await this.options.session.moveTo(originalLeafId);
        } catch (restoreError) {
          restorationError = restoreError;
        }
      }
      return {
        ok: false,
        errorMessage: restorationError
          ? "Automatic retry could not roll back the failed model attempt or restore its original journal leaf."
          : `Automatic retry could not roll back the failed model attempt: ${error instanceof Error ? error.message : String(error)}`,
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
        removeParentAbort = () => this.options.signal?.removeEventListener("abort", abort);
      }
      started = true;
      this.options.onEvent?.({ type: "start", reason });
      // Binary images stay model-neutral in the durable journal, but summary
      // generation needs only a continuity marker and must never resend large
      // historical image payloads to the compaction model.
      const imageProjected = {
        ...preparation,
        messagesToSummarize: projectMessagesForModel(preparation.messagesToSummarize, false),
        turnPrefixMessages: projectMessagesForModel(preparation.turnPrefixMessages, false),
      };
      const summaryModels = requireCompleteSummaryModels(this.options.models);
      const boundedPreparation = {
        ...imageProjected,
        messagesToSummarize: await collapseOversizedCompactionInput({
          messages: imageProjected.messagesToSummarize,
          models: summaryModels,
          model: this.options.model,
          reserveTokens: imageProjected.settings.reserveTokens,
          signal: abortController.signal,
          thinkingLevel: this.options.thinkingLevel,
        }),
        turnPrefixMessages: await collapseOversizedCompactionInput({
          messages: imageProjected.turnPrefixMessages,
          models: summaryModels,
          model: this.options.model,
          reserveTokens: imageProjected.settings.reserveTokens,
          signal: abortController.signal,
          thinkingLevel: this.options.thinkingLevel,
        }),
      };
      const compactResult = await compact(
        boundedPreparation,
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
      if (!result.summary.trim()) {
        throw new Error("The compaction model returned an empty summary.");
      }
      if (!validFinalCompactionSummary(result.summary, boundedPreparation)) {
        throw new Error(
          "The compaction model returned a malformed summary without the required continuity sections.",
        );
      }
      await sessionOperation(() =>
        this.options.session.appendCompaction(
          result.summary,
          result.firstKeptEntryId,
          result.tokensBefore,
          result.details,
        ),
      );
      const context = await sessionOperation(() => this.options.session.buildContext());
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
      const sessionFailed = error instanceof PiCompactionSessionError;
      const errorMessage = sessionFailed
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
        failureCode: sessionFailed
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
  const models = createModels();
  const streamSimple: ProviderStreams["streamSimple"] = (model, context, options) => {
    const stream = runtime.streams.streamSimple(model, context, {
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
