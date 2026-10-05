import {
  generateBranchSummary,
  TODO_CONTEXT,
  withAbortSignal,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  MAX_FORK_SUMMARY_FILES,
  MAX_FORK_SUMMARY_INSTRUCTIONS_CHARS,
  MAX_FORK_SUMMARY_TEXT_CHARS,
  type ChatForkLineageV1,
  type ChatForkSummaryV1,
} from "../../renderer/shared/chat-copy-contract.js";
import { chatMessageToPiMessage } from "./generation-messages.js";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";
import { createPiCompactionModels } from "./pi-compaction-core.js";
import type { PiSessionEntry } from "./pi-session-port.js";
import type { Chat, ChatMessage } from "./types.js";

export interface ForkSummaryServiceDeps {
  getChat(chatId: string): Promise<Chat | null>;
  updateForkSummary(
    chatId: string,
    next: (summary: ChatForkSummaryV1 | undefined, chat: Chat) => ChatForkSummaryV1 | undefined | null,
  ): Promise<Chat | null>;
  /** Source journal entries after a copied message, when the journal can prove that boundary. */
  journalEntriesAfter(chatId: string, messageId: string): Promise<PiSessionEntry[] | undefined>;
  skillsEnabled(): Promise<boolean>;
  resolveRuntime(
    providerId: string,
    model: string,
    signal?: AbortSignal,
    conversationId?: string,
  ): Promise<ResolvedModelRuntime>;
  recordUsage?(message: AssistantMessage, runtime: ResolvedModelRuntime): void | Promise<void>;
  /** Tell every surface about a summary state change. */
  published?(chat: Chat): void;
  /** A summary could not be settled at all (its fork stays pending until restart). */
  reportFailure?(error: unknown): void;
}

/** A failure whose message is safe and useful to show on the summary card. */
class ForkSummaryFailure extends Error {}

/** pi frames a branch summary as a detour; a fork's card and context say what it really is. */
const PI_BRANCH_PREAMBLE = /^The user explored a different conversation branch before returning here\.\nSummary of that exploration:\n\n/u;
const PI_FILE_SECTIONS = /(?:\n\n<(read-files|modified-files)>\n[\s\S]*?\n<\/\1>)+$/u;

function boundedFailure(message: string): string {
  const text = message.trim() || "The summary could not be generated.";
  return text.length > MAX_FORK_SUMMARY_INSTRUCTIONS_CHARS
    ? `${text.slice(0, MAX_FORK_SUMMARY_INSTRUCTIONS_CHARS - 1)}…`
    : text;
}

function boundedPaths(paths: readonly string[]): string[] {
  return paths.filter((item) => item.length > 0 && item.length <= 1_024).slice(0, MAX_FORK_SUMMARY_FILES);
}

/**
 * The source messages after the fork point and the last copied source message.
 * `after` keeps the chosen reply, so what follows starts after it; `before`
 * dropped the chosen prompt, so what follows starts with it.
 */
export function sourceMessagesAfterCut(
  source: Pick<Chat, "messages">,
  lineage: Pick<ChatForkLineageV1, "messageId" | "position">,
): { lastCopiedId?: string; after: ChatMessage[] } | undefined {
  const index = source.messages.findIndex((message) => message.id === lineage.messageId);
  if (index < 0) return undefined;
  const start = lineage.position === "after" ? index + 1 : index;
  return { lastCopiedId: source.messages[start - 1]?.id, after: source.messages.slice(start) };
}

function visibleEntries(messages: readonly ChatMessage[], runtime: ResolvedModelRuntime): PiSessionEntry[] {
  return messages.map((message, index) => ({
    type: "message",
    id: `fork-summary-visible-${message.id}`,
    parentId: index === 0 ? null : `fork-summary-visible-${messages[index - 1]!.id}`,
    seq: index,
    timestamp: message.createdAt,
    message: chatMessageToPiMessage(message, runtime.model, false),
  }));
}

/**
 * Summarizes what happened in a source chat after a fork point, on the
 * source's own provider and model, and settles the fork's summary state.
 * Only one attempt runs per fork; a cancelled or failed attempt leaves the
 * fork `failed` so its held sends wait for Retry or Continue without summary.
 */
export class ForkSummaryService {
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(private readonly deps: ForkSummaryServiceDeps) {}

  isRunning(chatId: string): boolean {
    return this.running.has(chatId);
  }

  /** Summarize a fork whose summary is pending. Resolves once it settles. */
  run(chatId: string): Promise<void> {
    const existing = this.running.get(chatId);
    if (existing) return existing.done;
    const controller = new AbortController();
    const done = this.attempt(chatId, controller.signal).catch((error) => {
      this.deps.reportFailure?.(error);
    }).finally(() => {
      if (this.running.get(chatId)?.controller === controller) this.running.delete(chatId);
    });
    this.running.set(chatId, { controller, done });
    return done;
  }

  /** Stop a running attempt; the fork's summary becomes `failed`. */
  cancel(chatId: string): boolean {
    const operation = this.running.get(chatId);
    if (!operation) return false;
    operation.controller.abort(new DOMException("Summary cancelled.", "AbortError"));
    return true;
  }

  /** Try a failed summary again with the same focus instructions. */
  async retry(chatId: string): Promise<Chat> {
    const chat = await this.deps.updateForkSummary(chatId, (summary) =>
      summary?.state === "failed"
        ? {
            state: "pending",
            afterMessageId: summary.afterMessageId,
            ...(summary.instructions ? { instructions: summary.instructions } : {}),
          }
        : null,
    );
    if (!chat) throw new Error("This fork has no failed summary to retry.");
    this.deps.published?.(chat);
    void this.run(chatId);
    return chat;
  }

  /** Continue without summary: the fork becomes a plain fork and may send. */
  async skip(chatId: string): Promise<Chat> {
    if (this.running.has(chatId)) {
      throw new Error("Cancel the summary before continuing without it.");
    }
    const chat = await this.deps.updateForkSummary(chatId, (summary) =>
      summary && summary.state !== "ready" ? undefined : null,
    );
    if (!chat) throw new Error("This fork has no unfinished summary.");
    this.deps.published?.(chat);
    return chat;
  }

  /**
   * A pending summary with no running attempt was interrupted (Aiden quit
   * mid-summary). Mark it failed so the fork offers Retry instead of waiting.
   */
  async settleInterrupted(chatId: string): Promise<void> {
    if (this.running.has(chatId)) return;
    const chat = await this.deps.updateForkSummary(chatId, (summary) =>
      summary?.state === "pending" && !this.running.has(chatId)
        ? { ...summary, state: "failed", error: "Summarizing stopped before it finished." }
        : null,
    );
    if (chat) this.deps.published?.(chat);
  }

  private async attempt(chatId: string, signal: AbortSignal): Promise<void> {
    let outcome: (summary: ChatForkSummaryV1) => ChatForkSummaryV1;
    try {
      const ready = await this.summarize(chatId, signal);
      if (!ready) return;
      outcome = (summary) => ({
        state: "ready",
        afterMessageId: summary.afterMessageId,
        ...(summary.instructions ? { instructions: summary.instructions } : {}),
        ...ready,
      });
    } catch (cause) {
      const error = signal.aborted
        ? "Summary cancelled."
        : cause instanceof ForkSummaryFailure
          ? boundedFailure(cause.message)
          : "The summary could not be generated.";
      outcome = (summary) => ({ ...summary, state: "failed", error });
    }
    const chat = await this.deps.updateForkSummary(chatId, (summary) =>
      summary?.state === "pending" ? outcome(summary) : null,
    );
    if (chat) this.deps.published?.(chat);
  }

  private async summarize(
    chatId: string,
    signal: AbortSignal,
  ): Promise<Pick<ChatForkSummaryV1, "text" | "files"> | undefined> {
    const fork = await this.deps.getChat(chatId);
    const lineage = fork?.forkedFrom;
    if (lineage?.summary?.state !== "pending") return undefined;
    const source = await this.deps.getChat(lineage.chatId);
    if (!source) throw new ForkSummaryFailure("The original chat is no longer available.");
    if (!source.providerId || !source.model) {
      throw new ForkSummaryFailure("The original chat has no model to summarize with.");
    }
    const cut = sourceMessagesAfterCut(source, lineage);
    if (!cut) throw new ForkSummaryFailure("The fork point is no longer in the original chat.");
    if (cut.after.length === 0) throw new ForkSummaryFailure("Nothing happened after this point to summarize.");

    let runtime: ResolvedModelRuntime;
    try {
      runtime = await this.deps.resolveRuntime(source.providerId, source.model, signal, source.id);
    } catch {
      throw new ForkSummaryFailure("The original chat's model is unavailable.");
    }
    signal.throwIfAborted();
    // The journal adds tool calls and results the transcript does not show.
    // With skills off its older entries may hold skill content, so use the
    // visible transcript instead, as inference does.
    const journal =
      cut.lastCopiedId && (await this.deps.skillsEnabled())
        ? await this.deps.journalEntriesAfter(source.id, cut.lastCopiedId).catch(() => undefined)
        : undefined;
    const entries = journal?.some((entry) => entry.type === "message")
      ? journal
      : visibleEntries(cut.after, runtime);
    const result = await generateBranchSummary(
      entries,
      {
        models: createPiCompactionModels(runtime, (message) => this.deps.recordUsage?.(message, runtime)),
        model: runtime.model,
        ...(lineage.summary.instructions ? { customInstructions: lineage.summary.instructions } : {}),
      },
      withAbortSignal(signal, TODO_CONTEXT),
    );
    signal.throwIfAborted();
    if (!result.ok) throw new ForkSummaryFailure(result.error.message);
    const text = result.value.summary.replace(PI_BRANCH_PREAMBLE, "").replace(PI_FILE_SECTIONS, "").trim();
    if (!text) throw new ForkSummaryFailure("The model returned an empty summary.");
    return {
      text: text.length > MAX_FORK_SUMMARY_TEXT_CHARS ? `${text.slice(0, MAX_FORK_SUMMARY_TEXT_CHARS - 1)}…` : text,
      files: {
        read: boundedPaths(result.value.readFiles),
        modified: boundedPaths(result.value.modifiedFiles),
      },
    };
  }
}
