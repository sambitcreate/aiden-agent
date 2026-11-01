// What each local chat is waiting on, for the Inbox's Needs you section and
// Working shelf (docs/plans/inbox-sidebar-plan.md). Live prompts come from the
// host run registry. A prompt the host settled because its window left the
// chat is kept here, in memory, until the chat runs again or the person
// dismisses it. Waits a quit or crash cut short come from the interrupted-wait
// store. Summaries are the bounded approval summary or the question text,
// never tool details or file contents.

import type { InterruptedWaitV1 } from "../../renderer/shared/interrupted-reply.js";
import {
  clipPendingAttentionSummary,
  type ChatPendingAttention,
} from "../../renderer/shared/chat-pending-attention.js";
import type { HostRunPendingPrompt, HostRunRegistry, HostRunSummary } from "./host-run-registry.js";
import { latestInterruptedRun, type InterruptedWaitStore } from "./interrupted-reply.js";
import type { DurablePiRuntimeOperation } from "./pi-runtime-effect-core.js";

export type PendingAttentionRuns = Pick<
  HostRunRegistry,
  "currentRunForChat" | "pendingPrompt" | "promptRaisedAt" | "runForPrompt" | "summary"
>;

export interface DetachedPrompt {
  chatId: string;
  promptId: string;
  kind: "approval" | "question";
  summary: string;
  since: number;
  runStartedAt: number;
}

/** Memory only: a restart drops these, as it drops the runs they came from. */
const MAX_DETACHED_CHATS = 200;
const MAX_DETACHED_PER_CHAT = 10;

export class DetachedPromptLog {
  private readonly chats = new Map<string, DetachedPrompt[]>();

  record(entry: DetachedPrompt): void {
    const kept = (this.chats.get(entry.chatId) ?? []).filter((item) => item.promptId !== entry.promptId);
    kept.push(entry);
    // Re-insert so the map's order is least recently recorded first.
    this.chats.delete(entry.chatId);
    this.chats.set(entry.chatId, kept.slice(-MAX_DETACHED_PER_CHAT));
    while (this.chats.size > MAX_DETACHED_CHATS) {
      const oldest = this.chats.keys().next().value;
      if (oldest === undefined) break;
      this.chats.delete(oldest);
    }
  }

  clearChat(chatId: string): void {
    this.chats.delete(chatId);
  }

  forChat(chatId: string): readonly DetachedPrompt[] {
    return this.chats.get(chatId) ?? [];
  }
}

function promptSummary(prompt: HostRunPendingPrompt): string {
  if (prompt.type === "approval_required") return clipPendingAttentionSummary(prompt.payload.summary);
  const questions = prompt.payload.questions;
  const first = Array.isArray(questions) ? (questions[0] as { question?: unknown } | undefined) : undefined;
  return clipPendingAttentionSummary(first?.question);
}

function epoch(iso: string): number | undefined {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : undefined;
}

export interface PendingAttentionRecorder {
  /**
   * The run's window left the chat, so the host is about to settle every
   * prompt it waits on as unavailable. Call before they settle.
   */
  runDetached(runId: string): void;
  /**
   * The run asked for an approval or answer after its window had left, so the
   * host refused it unpublished and told the model it was unavailable.
   */
  promptShortCircuited(runId: string, prompt: HostRunPendingPrompt & { id: string }): void;
  /** A new run started in the chat: what was left unanswered is moot. */
  runBegan(chatId: string): void;
}

export function createPendingAttentionRecorder(input: {
  runs: PendingAttentionRuns;
  log: DetachedPromptLog;
  now?: () => number;
  /**
   * A wait changed with no activity change to report it: a short-circuited
   * prompt never reaches the activity registry, so nothing else tells the
   * renderer to reread `chats:pendingAttention`.
   */
  onChange?: () => void;
}): PendingAttentionRecorder {
  const now = input.now ?? Date.now;
  const promptDetached = (promptId: string): void => {
    const prompt = input.runs.pendingPrompt(promptId);
    const runId = input.runs.runForPrompt(promptId);
    const run = runId === undefined ? undefined : input.runs.summary(runId);
    if (!prompt || !run) return;
    input.log.record({
      chatId: run.chatId,
      promptId,
      kind: prompt.type === "approval_required" ? "approval" : "question",
      summary: promptSummary(prompt),
      since: input.runs.promptRaisedAt(promptId) ?? epoch(run.updatedAt) ?? now(),
      runStartedAt: epoch(run.startedAt) ?? now(),
    });
  };
  return {
    runDetached(runId) {
      const run = input.runs.summary(runId);
      for (const id of [...(run?.pendingApprovalIds ?? []), ...(run?.pendingQuestionIds ?? [])]) {
        promptDetached(id);
      }
    },
    promptShortCircuited(runId, prompt) {
      const run = input.runs.summary(runId);
      if (!run) return;
      input.log.record({
        chatId: run.chatId,
        promptId: prompt.id,
        kind: prompt.type === "approval_required" ? "approval" : "question",
        summary: promptSummary(prompt),
        since: now(),
        runStartedAt: epoch(run.startedAt) ?? now(),
      });
      input.onChange?.();
    },
    runBegan(chatId) {
      input.log.clearChat(chatId);
    },
  };
}

export interface InterruptedRunWaits {
  runStartedAt: number;
  waits: readonly InterruptedWaitV1[];
}

/**
 * Saved waits from each listed chat's interrupted run, read only for chats
 * that hold a wait at all. The wait file is read once per call. Unreadable
 * history yields none, as `chats:interruptedWaits` does: it only hides the
 * Interrupted rows; `onError` hears why.
 */
export async function readInterruptedRunWaits(
  chatIds: readonly string[],
  sources: {
    waits: Pick<InterruptedWaitStore, "snapshot">;
    operations: {
      initialize(): Promise<void>;
      listOperationsByChat(chatId: string): Promise<DurablePiRuntimeOperation[]>;
    };
    onError?: (error: unknown) => void;
  },
): Promise<Map<string, InterruptedRunWaits>> {
  const result = new Map<string, InterruptedRunWaits>();
  try {
    const saved = await sources.waits.snapshot();
    const candidates = chatIds.filter((id) => saved.chatIds.has(id));
    if (candidates.length === 0) return result;
    await sources.operations.initialize();
    for (const chatId of candidates) {
      const run = await latestInterruptedRun(sources.operations, chatId);
      if (!run) continue;
      const waits = saved.forRun(chatId, run.startedAt);
      if (waits.length > 0) result.set(chatId, { runStartedAt: run.startedAt, waits });
    }
  } catch (error) {
    sources.onError?.(error);
    return new Map();
  }
  return result;
}

function isLive(run: HostRunSummary | undefined): run is HostRunSummary {
  return run !== undefined && (run.state === "working" || run.state === "needs_approval" || run.state === "needs_input");
}

/**
 * One chat's attention, most pressing first: a live approval, a live question,
 * a detached prompt (its run may still be working), an interrupted wait, then
 * a run with nothing to answer. An interrupted wait from a run older than the
 * live one is moot: the chat is working again.
 * Undefined when the chat is waiting on nothing.
 */
export function pendingAttentionForChat(
  chatId: string,
  sources: { runs: PendingAttentionRuns; detached: DetachedPromptLog; interrupted?: InterruptedRunWaits },
): ChatPendingAttention | undefined {
  const run = sources.runs.currentRunForChat(chatId);
  const live = isLive(run) ? run : undefined;
  const runStartedAt = live ? epoch(live.startedAt) : undefined;

  for (const [kind, ids] of [
    ["approval", live?.pendingApprovalIds ?? []],
    ["question", live?.pendingQuestionIds ?? []],
  ] as const) {
    const prompts = ids.flatMap((id) => {
      const prompt = sources.runs.pendingPrompt(id);
      return prompt ? [{ prompt, since: sources.runs.promptRaisedAt(id) }] : [];
    });
    if (prompts.length === 0) continue;
    // Arrival order, so the first is the oldest.
    const oldest = prompts[0]!;
    return {
      chatId,
      kind,
      summary: promptSummary(oldest.prompt),
      since: oldest.since ?? (live ? epoch(live.updatedAt) : undefined),
      runStartedAt,
      count: prompts.length,
    };
  }

  const detached = sources.detached.forChat(chatId);
  if (detached.length > 0) {
    const oldest = detached.reduce((left, right) => (right.since < left.since ? right : left));
    return {
      chatId,
      kind: "detached",
      summary: oldest.summary,
      since: oldest.since,
      runStartedAt: runStartedAt ?? oldest.runStartedAt,
      count: detached.length,
    };
  }

  const interrupted = sources.interrupted;
  const superseded =
    interrupted !== undefined && runStartedAt !== undefined && interrupted.runStartedAt < runStartedAt;
  const waits = superseded ? [] : (interrupted?.waits ?? []);
  if (waits.length > 0) {
    const oldest = waits.reduce((left, right) => (right.askedAt < left.askedAt ? right : left));
    return {
      chatId,
      kind: "interrupted",
      summary: clipPendingAttentionSummary(oldest.kind === "approval" ? oldest.summary : oldest.questions[0]?.question),
      since: oldest.askedAt,
      runStartedAt: interrupted?.runStartedAt,
      count: waits.length,
    };
  }

  if (live) return { chatId, kind: "working", summary: "", runStartedAt, count: 0 };
  return undefined;
}
