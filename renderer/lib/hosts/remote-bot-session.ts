// A paired host's Bot conversation as this Mac's Bot chat renders it. The host
// sends the Remote session projection (`GET /bots/{botId}/session` and its
// event stream); this maps it onto the local `BotLiveSnapshot` so the same
// transcript rows, cards and composer draw it.

import { BOT_ACTIVITY_PHASES, type BotActivityPhase } from "../../shared/bot-activity";
import type { BotLiveSnapshot, BotQueuedMessage, BotSessionState, BotTranscriptEntry } from "../../shared/bot-live";
import type { PeerHostView } from "../../shared/peer-host";
import type {
  AidenRemoteBotApproval,
  AidenRemoteBotQueuedMessage,
  AidenRemoteBotSession,
  AidenRemoteBotSessionActivity,
  AidenRemoteBotSessionEntry,
  AidenRemoteBotSessionEvent,
  AidenRemoteBotSessionStateView,
} from "../../../main/services/aiden-remote-protocol";

/** The host's session, mapped for display, plus the approval it is waiting on. */
export interface RemoteBotSessionView {
  snapshot: BotLiveSnapshot;
  /** The oldest tool call waiting for a yes or no, answered by `waitId`. */
  approval: AidenRemoteBotApproval | null;
}

/**
 * Stands in for the host's submission id, which the Remote state does not
 * carry. Only `kind` drives this Mac's view; the host keeps the real one.
 */
const REMOTE_SUBMISSION = "remote";

function time(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

function withTime<T extends object>(entry: T, createdAt: string | undefined): T & { at?: number } {
  const at = time(createdAt);
  return at === undefined ? entry : { ...entry, at };
}

/** One host entry as a transcript entry, or null for one this Mac does not draw. */
export function remoteBotTranscriptEntry(entry: AidenRemoteBotSessionEntry): BotTranscriptEntry | null {
  switch (entry.type) {
    case "message":
      if (entry.role === "assistant")
        return withTime(
          {
            id: entry.id,
            type: "assistant" as const,
            text: entry.text,
            toolCalls: [],
            stopReason: entry.interrupted ? ("aborted" as const) : ("stop" as const),
          },
          entry.createdAt,
        );
      if (entry.label !== undefined)
        return withTime({ id: entry.id, type: "routine" as const, label: entry.label, text: entry.text }, entry.createdAt);
      return withTime({ id: entry.id, type: "user" as const, text: entry.text, imageCount: 0 }, entry.createdAt);
    case "connect_card":
      return {
        id: entry.id,
        type: "connect_card",
        card: { type: "connect_card", pluginId: entry.pluginId, reason: entry.reason, status: entry.status },
      };
    case "notice":
      return { id: entry.id, type: "notice", notice: entry.notice };
    case "failed_turn":
      return withTime({ id: entry.id, type: "failed_turn" as const, retryText: entry.retryText ?? null }, entry.createdAt);
    // Cards this Mac does not opt into (`bot:cards`); the host never sends them here.
    case "memory_update":
    case "routine_proposal":
      return null;
  }
}

export function remoteBotSessionState(view: AidenRemoteBotSessionStateView): BotSessionState {
  switch (view.state) {
    case "idle":
      return { kind: "idle" };
    case "running":
      return { kind: "running", submissionId: REMOTE_SUBMISSION };
    case "interrupted":
      return {
        kind: "interrupted",
        submissionId: REMOTE_SUBMISSION,
        ...(view.blocked ? { blocked: view.blocked } : {}),
      };
    case "needs_model":
      return { kind: "needs_model" };
    case "unavailable":
      return { kind: "unavailable", reason: "held_by_live_process" };
    case "paused":
      // Sent only to devices holding `bot:handoffs`, which this Mac does not negotiate yet.
      return { kind: "unavailable", reason: "held_by_live_process" };
  }
}

const PHASES: ReadonlySet<string> = new Set(BOT_ACTIVITY_PHASES);

function activity(value: AidenRemoteBotSessionActivity | null | undefined): BotLiveSnapshot["activity"] {
  if (!value) return null;
  // A phase this version does not know reads as `working`, as the contract asks.
  const phase = (PHASES.has(value.phase) ? value.phase : "working") as BotActivityPhase;
  return { phase, startedAt: value.startedAt, ...(value.app ? { app: value.app } : {}) };
}

function queued(value: readonly AidenRemoteBotQueuedMessage[] | undefined): BotQueuedMessage[] {
  return (value ?? []).map((message) => ({
    submissionId: message.submissionId,
    mode: message.mode === "steer" ? "steer" : "followUp",
    text: message.text,
    imageCount: 0,
  }));
}

function entries(value: readonly AidenRemoteBotSessionEntry[]): BotTranscriptEntry[] {
  return value.map(remoteBotTranscriptEntry).filter((entry): entry is BotTranscriptEntry => entry !== null);
}

export function remoteBotSessionView(session: AidenRemoteBotSession): RemoteBotSessionView {
  return {
    snapshot: {
      botId: session.botId,
      epoch: session.epoch,
      seq: session.seq,
      entries: entries(session.entries),
      partial: session.partial ? session.partial : null,
      state: remoteBotSessionState(session),
      question: session.question
        ? {
            botId: session.botId,
            waitId: session.question.waitId,
            toolCallId: session.question.toolCallId,
            questions: session.question.questions,
          }
        : null,
      activity: activity(session.activity),
      queued: queued(session.queued),
    },
    approval: session.approval,
  };
}

/**
 * Apply one stream event. Returns null when it cannot be applied (another
 * epoch, or a gap in `seq`): the caller reads the session again.
 */
export function applyRemoteBotSessionEvent(
  view: RemoteBotSessionView,
  event: AidenRemoteBotSessionEvent,
): RemoteBotSessionView | null {
  const { snapshot } = view;
  if (event.botId !== snapshot.botId) return view;
  if (event.type === "snapshot") return remoteBotSessionView(event.payload.session);
  if (event.epoch !== snapshot.epoch) return null;
  if (event.seq <= snapshot.seq) return view;
  if (event.seq !== snapshot.seq + 1) return null;
  const next = (change: Partial<BotLiveSnapshot>): RemoteBotSessionView => ({
    ...view,
    snapshot: { ...snapshot, ...change, seq: event.seq },
  });
  switch (event.type) {
    case "partial":
      return next({ partial: event.payload.text ? event.payload.text : null });
    case "entry": {
      const entry = remoteBotTranscriptEntry(event.payload.entry);
      if (!entry) return next({});
      // An updated entry keeps its place; only a new one goes at the end.
      const index = snapshot.entries.findIndex((current) => current.id === entry.id);
      if (index < 0) return next({ entries: [...snapshot.entries, entry] });
      const entries = [...snapshot.entries];
      entries[index] = entry;
      return next({ entries });
    }
    case "state":
      return next({ state: remoteBotSessionState(event.payload) });
    case "question": {
      const question = event.payload.question;
      return next({
        question: question
          ? { botId: snapshot.botId, waitId: question.waitId, toolCallId: question.toolCallId, questions: question.questions }
          : null,
      });
    }
    case "approval":
      return { ...next({}), approval: event.payload.approval };
    case "activity":
      return next({ activity: activity(event.payload.activity) });
    case "queued":
      return next({ queued: queued(event.payload.queued) });
    case "closed":
      // The host reopens the stream with a fresh snapshot.
      return next({});
    case "handoff":
      // Sent only to devices holding `bot:handoffs`, which this Mac does not negotiate yet.
      return next({});
  }
}

/**
 * The host serves its Bots' one durable conversation to this Mac: the same
 * transcript its own app, phones and Telegram show. Older hosts only offer
 * Bot chats through the workspace chat routes.
 */
export function hostSharesBotSessions(view: Pick<PeerHostView, "features" | "capabilities">): boolean {
  const grants = new Set(view.capabilities);
  return (
    view.features.includes("bot-durable-session-v1") &&
    ["bot:read", "bot:write", "chat:read", "chat:write"].every((grant) => grants.has(grant))
  );
}
