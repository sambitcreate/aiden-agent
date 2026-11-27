// A paired host's Bot conversation as this Mac's Bot chat renders it. The host
// sends the Remote session projection (`GET /bots/{botId}/session` and its
// event stream); this maps it onto the local `BotLiveSnapshot` so the same
// transcript rows, cards and composer draw it.

import { BOT_ACTIVITY_PHASES, type BotActivityPhase } from "../../shared/bot-activity";
import type { BotPendingAccessRequest } from "../../shared/bot-access-requests";
import type { BotLiveSnapshot, BotQueuedMessage, BotSessionState, BotTranscriptEntry } from "../../shared/bot-live";
import type { BotPlanView } from "../../shared/bot-plans";
import type { BotRoutineProposalEntryData } from "../../shared/bot-routine-proposals";
import type { PeerHostView } from "../../shared/peer-host";
import type {
  AidenRemoteBotAccessRequest,
  AidenRemoteBotApproval,
  AidenRemoteBotHandoff,
  AidenRemoteBotPlan,
  AidenRemoteBotQueuedMessage,
  AidenRemoteBotSession,
  AidenRemoteBotSessionActivity,
  AidenRemoteBotSessionEntriesPage,
  AidenRemoteBotSessionEntry,
  AidenRemoteBotSessionEvent,
  AidenRemoteBotSessionStateView,
} from "../../../main/services/aiden-remote-protocol";

/** The host's session, mapped for display, plus the cards it is waiting on. */
export interface RemoteBotSessionView {
  snapshot: BotLiveSnapshot;
  /** The oldest tool call waiting for a yes or no, answered by `waitId`. */
  approval: AidenRemoteBotApproval | null;
  /**
   * Contract revision 37 (`bot:handoffs`): the step the Bot handed back to the
   * person, answered by `waitId`, or null. A host only sends it to a Mac that
   * negotiated `bot:handoffs`; others get a "needs you on your Mac" line.
   */
  handoff: AidenRemoteBotHandoff | null;
  /**
   * Contract revision 37: the person paused the Bot (on its own Mac, a phone
   * or here). Nothing runs until the pause is lifted, so the turn reads idle;
   * the wire carries no pause time or origin. A turn the pause cut short reads
   * interrupted again once it is lifted.
   */
  paused: boolean;
  /** Contract revision 67: the host holds entries older than the oldest one here. */
  hasOlder: boolean;
  /** While `hasOlder`, the host's id of the oldest entry here, drawn or not: where the next older page ends. */
  olderCursor: string | null;
  /**
   * Of the entries shown, how many came before the newest snapshot's own
   * (loaded pages, or entries kept across a snapshot), and how many host
   * entries those span, drawn or not. A snapshot re-reads that span.
   */
  olderLoaded?: number;
  olderHostSpan?: number;
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
    case "peer":
      return withTime({
        id: entry.id, type: "peer" as const, exchangeId: entry.exchangeId,
        direction: entry.direction, peerBotId: entry.peerBotId, peerName: entry.peerName,
        messageKind: entry.messageKind, ...(entry.final ? { final: true as const } : {}),
      }, entry.createdAt);
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
    // Revision 45 (`bot:images`): the bytes stay on the host until the transcript reads them
    // (`useRemoteBotImages`); empty `data` marks an image not read yet.
    case "shared_image":
      return { id: entry.id, type: "shared_image", name: entry.name, mimeType: entry.mimeType, size: entry.size, data: "" };
    // Revision 27 (`bot:cards`): the host names neither what changed nor why, so the line only says so.
    case "memory_update":
      return withTime({ id: entry.id, type: "memory_update" as const, targets: [], source: "turn" as const }, entry.createdAt);
    case "routine_proposal":
      return withTime(
        {
          id: entry.id,
          type: "routine_proposal" as const,
          // The host's own label already says when it runs; its schedule and timezone stay on the host.
          proposal: { proposalId: entry.proposalId, name: entry.name, prompt: entry.prompt, label: entry.label } as BotRoutineProposalEntryData,
          status: entry.status,
          ...(entry.routineId ? { routineId: entry.routineId } : {}),
        },
        entry.createdAt,
      );
    // Cards this Mac does not opt into (the revision-61 `bot:settings-changes`
    // and `bot:suggestions`); the host never sends them here.
    case "settings_change":
    case "skill_proposal":
    case "lesson":
    case "memory_tidy":
      return null;
  }
}

/** The turn's state; a person's pause is `remoteBotSessionPaused` and reads idle here. */
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
      // The host cannot run the Bot right now. A host without `bot:handoffs`
      // also reads a person's pause this way.
      return { kind: "unavailable", reason: "held_by_live_process" };
    case "paused":
      return { kind: "idle" };
  }
}

/** Whether the person paused the Bot (revision 37, only sent to `bot:handoffs` devices). */
export function remoteBotSessionPaused(view: AidenRemoteBotSessionStateView): boolean {
  return view.state === "paused";
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

/**
 * A plan's revision from what the card shows: the same plan read again (a
 * reload, a reconnect) keeps it, so the card keeps its busy and error state,
 * and any change gives a new one, so the updated card replaces the old.
 */
function remoteBotPlanRevision(plan: AidenRemoteBotPlan): number {
  const shown = JSON.stringify([
    plan.planId, plan.status, plan.title, plan.why,
    plan.steps.map((step) => [step.text, step.status]),
    plan.items.map((item) => [item.line, item.details, item.used ?? null, item.max ?? null]),
    plan.expiresAt ?? null, plan.from ?? null,
  ]);
  // FNV-1a, 32-bit.
  let hash = 0x811c9dc5;
  for (let index = 0; index < shown.length; index++) {
    hash ^= shown.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Revision 56 (`bot:plans`): the host's plan as the plan card draws it. Its
 * items carry no ids, so their place stands in; `revision` follows what the
 * card shows (`remoteBotPlanRevision`), not the frame that carried it.
 */
export function remoteBotPlanView(botId: string, plan: AidenRemoteBotPlan): BotPlanView {
  const revision = remoteBotPlanRevision(plan);
  const expiresAt = time(plan.expiresAt);
  return {
    planId: plan.planId,
    botId,
    status: plan.status,
    title: plan.title,
    why: plan.why,
    steps: plan.steps.map((step) => ({ text: step.text, status: step.status })),
    items: plan.items.map((item, index) => ({
      id: `item-${index}`,
      line: item.line,
      details: [...item.details],
      ...(item.used !== undefined ? { used: item.used } : {}),
      ...(item.max !== undefined ? { max: item.max } : {}),
    })),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    revision,
    ...(plan.from !== undefined ? { from: plan.from } : {}),
  };
}

/**
 * Revision 55 (`bot:access-requests`): the folder or whole-computer access
 * the Bot is waiting on. The host keeps the tool call; `waitId` answers it.
 */
export function remoteBotAccessRequest(botId: string, request: AidenRemoteBotAccessRequest): BotPendingAccessRequest {
  return {
    botId,
    waitId: request.waitId,
    toolCallId: request.waitId,
    target: request.target,
    label: request.label,
    ...(request.place !== undefined ? { place: request.place } : {}),
    why: request.why,
    choices: [...request.choices],
    ...(request.approvalCount !== undefined ? { approvalCount: request.approvalCount } : {}),
  };
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
      accessRequest: session.accessRequest ? remoteBotAccessRequest(session.botId, session.accessRequest) : null,
      plan: session.plan ? remoteBotPlanView(session.botId, session.plan) : null,
    },
    approval: session.approval,
    handoff: session.handoff ?? null,
    paused: remoteBotSessionPaused(session),
    hasOlder: session.hasOlder,
    // Only a transcript with more before it needs a place to page back from.
    olderCursor: session.hasOlder ? (session.entries[0]?.id ?? null) : null,
  };
}

/**
 * A page of older entries as the host supervisor returns it: the wire page
 * plus `olderCursor`, the oldest entry the host sent (read or not), where the
 * next page starts, and `hostCount`, how many entries the host sent. Entries
 * this Mac can't read are already left out, so the page's own oldest entry may
 * be newer than that, or missing, and it may hold fewer than `hostCount`.
 */
export type RemoteBotSessionEntriesPage = AidenRemoteBotSessionEntriesPage & { olderCursor?: string; hostCount?: number };

/**
 * A fresh read or a reconnect's snapshot of the same session keeps the older
 * pages this Mac already loaded, when the snapshot's window starts inside
 * them. Anything else (another epoch, a gap, a whole transcript) is the
 * snapshot as sent. A snapshot can also mean the host rewrote its history
 * (removed or reordered entries) within the same epoch, so what this keeps is
 * provisional: the follower reads those entries again and replaces them
 * (`withRereadOlderRemoteBotEntries`), or drops them if it can't.
 */
export function carryOlderRemoteBotEntries(
  previous: RemoteBotSessionView | null,
  next: RemoteBotSessionView,
): RemoteBotSessionView {
  if (!previous || !next.hasOlder || previous.snapshot.epoch !== next.snapshot.epoch) return next;
  const first = next.snapshot.entries[0];
  if (!first) return next;
  const index = previous.snapshot.entries.findIndex((entry) => entry.id === first.id);
  if (index <= 0) return next;
  // The kept part is what earlier pages loaded plus the old snapshot's own entries before `first`.
  const loaded = previous.olderLoaded ?? 0;
  return {
    ...next,
    snapshot: { ...next.snapshot, entries: [...previous.snapshot.entries.slice(0, index), ...next.snapshot.entries] },
    hasOlder: previous.hasOlder,
    olderCursor: previous.olderCursor,
    olderLoaded: index,
    olderHostSpan: (previous.olderHostSpan ?? 0) + Math.max(0, index - loaded),
  };
}

/**
 * Contract revision 67: one page of entries older than the view's oldest,
 * placed before it. A page from another epoch is not this transcript's: the
 * view is returned unchanged and the caller reads the session again.
 */
export function withOlderRemoteBotEntries(
  view: RemoteBotSessionView,
  page: RemoteBotSessionEntriesPage,
): RemoteBotSessionView {
  if (page.botId !== view.snapshot.botId || page.epoch !== view.snapshot.epoch) return view;
  const held = new Set(view.snapshot.entries.map((entry) => entry.id));
  const older = entries(page.entries).filter((entry) => !held.has(entry.id));
  return {
    ...view,
    snapshot: { ...view.snapshot, entries: [...older, ...view.snapshot.entries] },
    olderLoaded: (view.olderLoaded ?? 0) + older.length,
    olderHostSpan: (view.olderHostSpan ?? 0) + (page.hostCount ?? page.entries.length),
    hasOlder: page.hasOlder,
    olderCursor: page.hasOlder ? (page.olderCursor ?? page.entries[0]?.id ?? view.olderCursor) : null,
  };
}

/**
 * The first `carried` entries of `view` were kept from before a snapshot
 * (`carryOlderRemoteBotEntries`); `pages` are that history read again from the
 * host, newest page first, each just older than the one before it, starting
 * just older than the snapshot's own entries. The kept entries are replaced
 * with the pages, so history the host removed or reordered doesn't stay, and
 * cut back to the earliest kept entry the host still has when they reach past
 * it. Pages
 * that stop short of the kept range (a later page failed) leave Load older
 * where the last one ends. Without a page, or with one from another epoch, the
 * kept entries are dropped and the snapshot's own "older" state comes back.
 */
export function withRereadOlderRemoteBotEntries(
  view: RemoteBotSessionView,
  carried: number,
  snapshot: Pick<RemoteBotSessionView, "hasOlder" | "olderCursor">,
  pages: readonly RemoteBotSessionEntriesPage[] | null,
): RemoteBotSessionView {
  const own: RemoteBotSessionView = {
    ...view,
    snapshot: { ...view.snapshot, entries: view.snapshot.entries.slice(carried) },
    olderLoaded: 0,
    olderHostSpan: 0,
  };
  if (
    !pages ||
    pages.length === 0 ||
    pages.some((page) => page.botId !== view.snapshot.botId || page.epoch !== view.snapshot.epoch)
  ) {
    return { ...own, ...snapshot };
  }
  const reread = pages.reduce(withOlderRemoteBotEntries, own);
  // Pages that reached past the kept entries are cut back to the earliest one
  // the host still has, so history older than what was shown before isn't
  // added. At the oldest kept entry Load older resumes where it was; at another
  // (the host removed or moved the older ones), it resumes from that entry.
  // The boundary is whichever kept entry comes first in the host's order now,
  // so a reorder doesn't cut off a kept entry that moved earlier.
  const kept = new Set(view.snapshot.entries.slice(0, Math.max(0, carried)).map((entry) => entry.id));
  const at = reread.snapshot.entries.findIndex((entry) => kept.has(entry.id));
  if (at <= 0) return reread;
  const boundary = reread.snapshot.entries[at]!.id;
  const same = boundary === view.snapshot.entries[0]?.id;
  return {
    ...reread,
    snapshot: { ...reread.snapshot, entries: reread.snapshot.entries.slice(at) },
    hasOlder: same ? view.hasOlder : true,
    olderCursor: same ? view.olderCursor : boundary,
    olderLoaded: (reread.olderLoaded ?? 0) - at,
    olderHostSpan: view.olderHostSpan ?? 0,
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
      return { ...next({ state: remoteBotSessionState(event.payload) }), paused: remoteBotSessionPaused(event.payload) };
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
      return { ...next({}), handoff: event.payload.handoff };
    // Only sent to a Mac holding `bot:plans` or `bot:access-requests`; others read the host's notice line.
    case "plan":
      return next({ plan: event.payload.plan ? remoteBotPlanView(snapshot.botId, event.payload.plan) : null });
    case "access_request":
      return next({
        accessRequest: event.payload.accessRequest ? remoteBotAccessRequest(snapshot.botId, event.payload.accessRequest) : null,
      });
    case "issues":
      // Contract revision 42: Bot issue cards are a phone surface in this
      // revision; the Mac reads the same cards from its own Bot transcript.
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

/**
 * Why a host's Bot conversation can't open here, for a host that fails
 * `hostSharesBotSessions`:
 * - `repair`: the host shares durable sessions, but this Mac's pairing lacks
 *   the grants; pairing again from the host fixes it.
 * - `enable_durable`: an `aiden serve` host with durable Bot sessions off. It
 *   has Bots (every revision 25+ host advertises `bot-delete-v1`) but no
 *   durable session, which every desktop since then serves. Updating Aiden
 *   would not change that; the server's owner turns it on with
 *   `aiden bots enable-durable`. Its Bots still open in their workspace chat.
 * - `update`: a host older than contract revision 25.
 */
export type RemoteBotSessionGap = "repair" | "enable_durable" | "update";

export function remoteBotSessionGap(view: Pick<PeerHostView, "features">): RemoteBotSessionGap {
  if (view.features.includes("bot-durable-session-v1")) return "repair";
  if (view.features.includes("bot-delete-v1")) return "enable_durable";
  return "update";
}

/** The empty state's line for a host whose Bot conversation can't open here. */
export function remoteBotSessionGapDescription(view: Pick<PeerHostView, "features">, hostName: string): string {
  switch (remoteBotSessionGap(view)) {
    case "repair":
      return `This device can see ${hostName}'s Bots but can't chat with them. Pair it again from ${hostName} to update its access.`;
    case "enable_durable":
      return `${hostName} keeps its Bots' chats in workspace chats, so open this Bot from All Bots to chat with it. To get the full Bot chat here, run “aiden bots enable-durable” on ${hostName} and restart the server.`;
    case "update":
      return `Update Aiden on ${hostName} to chat with its Bots here.`;
  }
}

/**
 * The host sends this Mac its Bots' hand-off cards and pauses, and takes
 * their answers and Pause and Resume (contract revision 37, `bot:handoffs`).
 */
export function hostServesBotHandoffs(view: Pick<PeerHostView, "capabilities">): boolean {
  return view.capabilities.includes("bot:handoffs");
}
