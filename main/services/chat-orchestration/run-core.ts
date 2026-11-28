/**
 * The chat-run core: what any caller that starts chat turns through the
 * Remote chat and stream services needs in order to follow them.
 *
 * - a run snapshot (running, waiting for the person, done or failed),
 * - a bounded wait that answers as soon as the run stops running,
 * - the runs each owner started, and
 * - request dedupe, so a retried request joins or replays the first one.
 *
 * Runs are grouped by an owner key (the stream audience: an outside app's id
 * today). The core admits everything: rate limits, run caps and pending-request
 * caps belong to the caller, which can read the counts it needs from here.
 */
import type {
  AidenRemoteChatService,
  AidenRemoteMessageProjection,
} from "../aiden-remote-chats.js";
import type { AidenRemoteStreamService, AidenRemoteStreamState } from "../aiden-remote-streams.js";

export interface ChatRunCoreServices {
  chats: Pick<AidenRemoteChatService, "messagesWindow">;
  streams: Pick<
    AidenRemoteStreamService,
    "status" | "pendingApproval" | "pendingQuestion" | "watch"
  >;
}

export interface ChatRunCoreDependencies {
  /** Where the person answers an approval or a question, for example "Aiden on Studio". */
  answerIn(): Promise<string>;
  /** The error for a run the stream service no longer tracks, or one in another chat. */
  untrackedRun(): Error;
}

export const CHAT_RUN_TERMINAL_STATES: ReadonlySet<AidenRemoteStreamState> = new Set([
  "done",
  "error",
  "cancelled",
  "interrupted",
]);

/** One message's text, as a caller reads it; longer text is cut and flagged. */
export const CHAT_RUN_MESSAGE_TEXT_LIMIT = 20_000;
/** Answered requests remembered for replay; unanswered ones are never evicted. */
const REQUEST_CACHE_LIMIT = 128;

export type ChatRunMessage = {
  id: string;
  role: AidenRemoteMessageProjection["role"];
  text: string;
  truncated?: true;
  createdAt: string;
  outcome?: NonNullable<AidenRemoteMessageProjection["outcome"]>["status"];
};

export type ChatRunSnapshot =
  | { chatId: string; runId: string; state: "running" }
  | { chatId: string; runId: string; state: "waiting_for_input"; answerIn: string }
  | {
      chatId: string;
      runId: string;
      state: "waiting_for_approval";
      approveIn: string;
      approval?: { toolName: string; summary: string; expiresAt: string };
    }
  | {
      chatId: string;
      runId: string;
      state: "done";
      outcome: "completed" | "stopped";
      reply?: ChatRunMessage;
    }
  | { chatId: string; runId: string; state: "failed"; reason: "interrupted" | "error" };

export type ChatRunWaitOutcome =
  /** The run stopped running, or is still running when the wait timed out. */
  | { kind: "snapshot"; snapshot: ChatRunSnapshot }
  /** The owner was forgotten (revoked) or the run's stream closed while waiting. */
  | { kind: "closed" }
  /** The caller's signal aborted while waiting. */
  | { kind: "aborted" };

export interface ChatRunPendingRequests {
  /** Unanswered requests of this owner. */
  owner: number;
  /** Unanswered requests of every owner, forgotten ones whose work still runs included. */
  total: number;
}

interface RequestEntry {
  promise: Promise<unknown>;
  settled: boolean;
}

export class ChatRunCore {
  private readonly runs = new Map<string, Set<string>>();
  private readonly waits = new Map<string, Set<AbortController>>();
  /** Requests by owner and request id; `settled` marks the ones a newer request may evict. */
  private readonly requests = new Map<string, RequestEntry>();

  constructor(private readonly dependencies: ChatRunCoreDependencies) {}

  /** Records a run this owner started. */
  track(owner: string, runId: string): void {
    const runs = this.runs.get(owner) ?? new Set<string>();
    runs.add(runId);
    this.runs.set(owner, runs);
  }

  /** How many of this owner's runs are still going; finished or forgotten ones are dropped. */
  liveRuns(services: ChatRunCoreServices, owner: string): number {
    const runs = this.runs.get(owner);
    if (!runs) return 0;
    for (const runId of [...runs]) {
      try {
        if (CHAT_RUN_TERMINAL_STATES.has(services.streams.status(owner, runId).state))
          runs.delete(runId);
      } catch {
        runs.delete(runId);
      }
    }
    return runs.size;
  }

  /** The stream status of a run this owner can see in this chat. */
  status(services: ChatRunCoreServices, owner: string, chatId: string, runId: string) {
    let status;
    try {
      status = services.streams.status(owner, runId);
    } catch {
      throw this.dependencies.untrackedRun();
    }
    if (status.chatId !== chatId) throw this.dependencies.untrackedRun();
    return status;
  }

  /** `withReply: false` skips reading the chat's last reply from disk (a status-only list). */
  async snapshot(
    services: ChatRunCoreServices,
    owner: string,
    chatId: string,
    runId: string,
    options: { withReply?: boolean } = {},
  ): Promise<ChatRunSnapshot> {
    const status = this.status(services, owner, chatId, runId);
    const base = { chatId, runId };
    const answerIn = await this.dependencies.answerIn();
    if (!CHAT_RUN_TERMINAL_STATES.has(status.state)) {
      if (services.streams.pendingQuestion(owner, runId)) {
        return { ...base, state: "waiting_for_input", answerIn };
      }
      const approval = services.streams.pendingApproval(owner, runId);
      if (approval || status.state === "waiting_for_approval") {
        return {
          ...base,
          state: "waiting_for_approval",
          approveIn: answerIn,
          ...(approval
            ? {
                approval: {
                  toolName: approval.toolName,
                  summary: approval.summary,
                  expiresAt: approval.expiresAt,
                },
              }
            : {}),
        };
      }
      return { ...base, state: "running" };
    }
    if (status.state === "done" || status.state === "cancelled") {
      const reply =
        options.withReply === false
          ? undefined
          : await lastAssistantMessage(services, chatId).catch(() => undefined);
      return {
        ...base,
        state: "done",
        outcome: status.state === "cancelled" ? "stopped" : "completed",
        ...(reply ? { reply } : {}),
      };
    }
    return {
      ...base,
      state: "failed",
      reason: status.state === "interrupted" ? "interrupted" : "error",
    };
  }

  /**
   * Waits up to `timeoutMs` for the run to stop running. A timeout never stops
   * the run; it answers with the run's current snapshot.
   */
  async wait(
    services: ChatRunCoreServices,
    owner: string,
    chatId: string,
    runId: string,
    options: { timeoutMs: number; signal: AbortSignal },
  ): Promise<ChatRunWaitOutcome> {
    const { timeoutMs, signal } = options;
    const first = await this.snapshot(services, owner, chatId, runId);
    if (first.state !== "running" || signal.aborted) return { kind: "snapshot", snapshot: first };

    const controller = new AbortController();
    const ownerWaits = this.waits.get(owner) ?? new Set<AbortController>();
    ownerWaits.add(controller);
    this.waits.set(owner, ownerWaits);
    let detach: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The first snapshot that showed the run had stopped running. It answers
    // the wait, so a terminal run evicted afterwards still reads as finished.
    let observed: ChatRunSnapshot | undefined;
    try {
      const outcome = await new Promise<"changed" | "timeout" | "closed" | "aborted">((resolve) => {
        const abort = () => resolve("aborted");
        signal.addEventListener("abort", abort, { once: true });
        controller.signal.addEventListener("abort", () => resolve("closed"), { once: true });
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        // Most events (text deltas, tool output) leave the run running; only a
        // state change answers the wait. The run's status is read before the
        // snapshot's first await, so it is taken while the event is current.
        const look = () => {
          void this.snapshot(services, owner, chatId, runId)
            .then((snapshot) => {
              if (snapshot.state === "running") return;
              observed ??= snapshot;
              resolve("changed");
            })
            .catch(() => resolve("changed"));
        };
        try {
          detach = services.streams.watch(owner, runId, {
            onChange: look,
            onClose: () => resolve("closed"),
          });
        } catch {
          resolve("changed");
          return;
        }
        // The run may have changed after the first snapshot and before the
        // watch attached; the watch reports only later events, so look again.
        look();
      });
      if (outcome === "closed") return { kind: "closed" };
      if (outcome === "aborted") return { kind: "aborted" };
      return {
        kind: "snapshot",
        snapshot: observed ?? (await this.snapshot(services, owner, chatId, runId)),
      };
    } finally {
      if (timer) clearTimeout(timer);
      detach?.();
      ownerWaits.delete(controller);
      if (ownerWaits.size === 0 && this.waits.get(owner) === ownerWaits) this.waits.delete(owner);
    }
  }

  /** Unanswered requests, for a caller's own caps. */
  pendingRequests(owner: string): ChatRunPendingRequests {
    const prefix = requestPrefix(owner);
    let ownerPending = 0;
    let total = 0;
    for (const [key, { settled }] of this.requests) {
      if (settled) continue;
      total += 1;
      if (key.startsWith(prefix)) ownerPending += 1;
    }
    return { owner: ownerPending, total };
  }

  /**
   * Requests with the same id share one outcome, so a retry joins a running
   * request or replays its answer. `admit` runs only for a new request, before
   * it is cached; whatever it throws rejects the request uncached.
   */
  request<T>(
    owner: string,
    requestId: string,
    run: () => Promise<T>,
    admit?: () => void,
  ): Promise<T> {
    const key = `${requestPrefix(owner)}${requestId}`;
    const existing = this.requests.get(key);
    if (existing) return existing.promise as Promise<T>;
    try {
      admit?.();
    } catch (error) {
      return Promise.reject(error);
    }
    const entry: RequestEntry = { promise: Promise.resolve(), settled: false };
    const promise = run().then(
      (result) => {
        entry.settled = true;
        return result;
      },
      (error: unknown) => {
        // A refusal or failure is not cached: the caller may retry once it clears.
        if (this.requests.get(key) === entry) this.requests.delete(key);
        throw error;
      },
    );
    entry.promise = promise;
    this.requests.set(key, entry);
    // Only answered requests are forgotten. One still running stays, so a retry
    // joins it rather than starting the same work a second time.
    for (const [cached, { settled }] of this.requests) {
      if (this.requests.size <= REQUEST_CACHE_LIMIT) break;
      if (settled) this.requests.delete(cached);
    }
    return promise;
  }

  /** Ends this owner's waits (they answer `closed`) and forgets its runs and requests. */
  forget(owner: string): void {
    for (const controller of this.waits.get(owner) ?? []) controller.abort();
    this.waits.delete(owner);
    this.runs.delete(owner);
    const prefix = requestPrefix(owner);
    for (const key of [...this.requests.keys()]) {
      if (key.startsWith(prefix)) this.requests.delete(key);
    }
  }
}

export function projectRunMessage(message: AidenRemoteMessageProjection): ChatRunMessage {
  const text = [...message.text];
  const truncated = text.length > CHAT_RUN_MESSAGE_TEXT_LIMIT;
  return {
    id: message.id,
    role: message.role,
    text: truncated ? text.slice(0, CHAT_RUN_MESSAGE_TEXT_LIMIT).join("") : message.text,
    ...(truncated ? { truncated: true as const } : {}),
    createdAt: message.createdAt,
    ...(message.outcome ? { outcome: message.outcome.status } : {}),
  };
}

function requestPrefix(owner: string): string {
  return `${owner}\u0000`;
}

async function lastAssistantMessage(services: ChatRunCoreServices, chatId: string) {
  const window = await services.chats.messagesWindow(chatId, { limit: 5 });
  const message = [...window.messages]
    .reverse()
    .find((candidate) => candidate.role === "assistant");
  return message ? projectRunMessage(message) : undefined;
}
