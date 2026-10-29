import type { Chat, ChatMessage, ChatReadResponse } from "./types";
import { persistedChatWorkspaceId } from "../shared/chat-workspace";
import {
  isSafeSubagentIdentifier,
  parseSubagentRunSnapshot,
  type SubagentRunSnapshot,
} from "../shared/subagent-runs";
import { parseGenerationTimeline, type GenerationTimeline } from "../shared/generation-timeline";
import { chatArtifactIdentity, parseChatArtifactEventV1, type ChatArtifactV1 } from "../shared/chat-artifacts";
import type { ChatUiVisualV1 } from "../shared/aiden-ui/types";
import { reduceUiVisuals } from "./ui-visual-transcript";
import { mergeSubagentSnapshots } from "./subagent-view-state";
import {
  restoreUndeliveredGuidance,
  undeliveredGuidanceFromTerminal,
} from "./composer-draft-store";

const MAX_DETACHED_STREAMS = 64;
const MAX_OWN_GENERATION_STREAMS = 256;
const MAX_DETACHED_CONTENT_CHARS = 1_000_000;
const MAX_DETACHED_REASONING_CHARS = 250_000;
const MAX_DETACHED_ARTIFACTS = 8;
const FALLBACK_RETRY_DELAY_MS = 100;
/** Retry pauses double from 100 ms and stop growing here. */
const MAX_RETRY_DELAY_MS = 5_000;
/**
 * Failed attempts a reconciliation makes before it gives up and leaves the
 * chat to its own read (about 20 s of backoff), so a chat whose read keeps
 * failing is not polled forever and does not stay draining until a reload.
 */
export const MAX_RECONCILIATION_ATTEMPTS = 10;
const detachedLifecycleStreams = new Map<string, DetachedLifecycleStreamOwner>();
const fallbackLifecycleStreams = new Map<string, DetachedLifecycleStreamOwner>();
const detachedLifecycleProjections = new Map<string, DetachedLifecycleProjection>();
/** Runs this window watches but did not start (a phone's turn), one per chat. */
const observedRunProjections = new Map<string, DetachedLifecycleProjection>();
/**
 * Runs this document started, bounded and oldest-first. A detached marker
 * clears at its terminal, but a watcher started on revisit can still report
 * the run's end afterwards; the run stays this window's own and is never
 * mirrored back as someone else's.
 */
const ownGenerationStreams = new Set<string>();
const fallbackSettlementInFlight = new Set<string>();
const terminalSettlementInFlight = new Set<string>();
const chatReadReconciliations = new Map<string, ChatReadReconciliation>();
const chatReadReconciliationInFlight = new Set<string>();
const registryListeners = new Set<() => void>();
/** Failed fallback / read-reconciliation settlements per retained owner key. */
const fallbackRetryAttempts = new Map<string, number>();
const chatReadReconciliationRetryAttempts = new Map<string, number>();
const fallbackListeners = new Set<(owner: DetachedLifecycleStreamOwner) => void | Promise<void>>();
const chatReadReconciliationListeners = new Set<
  (owner: ChatReadReconciliation) => void | Promise<void>
>();

export interface DetachedLifecycleStreamOwner {
  streamId: string;
  chatId: string;
  workspaceId: string;
}

/** Renderer-safe state retained while a route-detached generation remains main-owned. */
export interface DetachedLifecycleProjection extends DetachedLifecycleStreamOwner {
  content: string;
  /** Wall-clock time of the most recent prose delta, retained across route handoff. */
  lastTextDeltaAt: number | null;
  reasoning: string;
  timeline: GenerationTimeline | null;
  artifacts: readonly ChatArtifactV1[];
  /** Native (render_ui) visuals, kept beside the artifacts. */
  uiVisuals?: readonly ChatUiVisualV1[];
  subagents: readonly SubagentRunSnapshot[];
  /**
   * Mirrored from this Mac's run journal for a run this window did not start.
   * Stop uses host authority; Steer is not offered because run input is owner-checked.
   */
  observed?: true;
  /**
   * The saved reply a mirrored run reported when it finished. A text-only
   * reply carries no timeline, so this id is what marks it as the run's own.
   */
  doneMessageId?: string;
  /** A mirrored run has finished: its text is final and nothing more streams. */
  finished?: true;
}

/** What a watching window knows about a run it mirrors. */
export interface ObservedRunSnapshot {
  text: string;
  reasoning: string;
  timeline: GenerationTimeline | null;
  /** The newest content was a text delta. */
  textStreaming: boolean;
  /** The assistant message the run saved, once it has finished. */
  doneMessageId?: string | null;
  /** The run finished (done, failed or cancelled). */
  finished?: boolean;
}

export type DetachedLifecycleProjectionSeed = Omit<
  DetachedLifecycleProjection,
  keyof DetachedLifecycleStreamOwner | "lastTextDeltaAt"
> & { lastTextDeltaAt?: number | null };

interface TerminalChatNotification {
  streamId: string;
  chat?: Chat;
}

export interface ChatSettlementNotification {
  chatId: string;
  workspaceId: string;
}

export interface DetachedLifecycleChatReconciliation extends ChatSettlementNotification {
  streamIds: readonly string[];
}

export interface ChatReadReconciliation {
  chatId: string;
  workspaceId: string;
}

type Subscribe = (
  channel:
    | "chat:delta"
    | "chat:reasoning-delta"
    | "chat:timeline"
    | "chat:artifact"
    | "chat:subagents"
    | "chat:done"
    | "chat:error",
  handler: (payload: unknown) => void,
) => () => void;
type SettlementSubscribe = (
  channel: "chats:settled",
  handler: (payload: unknown) => void,
) => () => void;

/** The backoff before retry `attempt` (1-based): 100 ms doubling, capped at 5 s. */
export function reconciliationRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(16, Math.floor(attempt) - 1));
  return Math.min(MAX_RETRY_DELAY_MS, FALLBACK_RETRY_DELAY_MS * 2 ** exponent);
}

type FrameHandle = { cancel: () => void };
let pendingRegistryFrame: FrameHandle | null = null;

function scheduleFrame(callback: () => void): FrameHandle {
  if (typeof globalThis.requestAnimationFrame === "function") {
    const id = globalThis.requestAnimationFrame(() => callback());
    return { cancel: () => globalThis.cancelAnimationFrame(id) };
  }
  const id = globalThis.setTimeout(callback, 16);
  return { cancel: () => globalThis.clearTimeout(id) };
}

function emitRegistryChange(): void {
  // A structural change notifies now and carries any streamed text with it.
  pendingRegistryFrame?.cancel();
  pendingRegistryFrame = null;
  for (const listener of registryListeners) listener();
}

/**
 * Streamed text and reasoning change the projection on every delta. The
 * projection itself updates at once (a render for any other reason reads it),
 * but subscribers hear about it at most once a frame, like an owned stream's
 * flush, so a detached or mirrored run does not re-render the pane per token.
 */
function scheduleRegistryChange(): void {
  if (pendingRegistryFrame !== null) return;
  pendingRegistryFrame = scheduleFrame(() => {
    pendingRegistryFrame = null;
    for (const listener of registryListeners) listener();
  });
}

function deleteDetachedProjection(streamId: string): void {
  detachedLifecycleProjections.delete(streamId);
}

function appendBounded(current: string, delta: string, maximum: number): string {
  if (current.length >= maximum) return current;
  // Concatenation alone stays a cheap rope; only crossing the cap needs a slice.
  if (current.length + delta.length <= maximum) return current + delta;
  return (current + delta).slice(0, maximum);
}

export function detachedTextStreamingRemaining(
  lastTextDeltaAt: number | null,
  now: number,
  idleMs: number,
): number {
  if (
    lastTextDeltaAt === null ||
    !Number.isFinite(lastTextDeltaAt) ||
    !Number.isFinite(now) ||
    !Number.isFinite(idleMs) ||
    idleMs <= 0
  ) {
    return 0;
  }
  return Math.max(0, idleMs - Math.max(0, now - lastTextDeltaAt));
}

function updateDetachedProjection(
  streamId: string,
  update: (current: DetachedLifecycleProjection) => DetachedLifecycleProjection,
  notify: "now" | "frame" = "now",
): void {
  const current = detachedLifecycleProjections.get(streamId);
  if (!current || !detachedLifecycleStreams.has(streamId)) return;
  const next = update(current);
  if (next === current) return;
  detachedLifecycleProjections.set(streamId, next);
  if (notify === "frame") scheduleRegistryChange();
  else emitRegistryChange();
}

function chatReadReconciliationKey(owner: ChatReadReconciliation): string {
  return `${owner.workspaceId}\u0000${owner.chatId}`;
}

function requestFallback(owner: DetachedLifecycleStreamOwner): void {
  fallbackLifecycleStreams.set(owner.streamId, owner);
  emitRegistryChange();
  if (fallbackSettlementInFlight.has(owner.streamId) || fallbackListeners.size === 0) return;
  fallbackSettlementInFlight.add(owner.streamId);
  const settlements: Promise<void>[] = [];
  for (const listener of fallbackListeners) {
    try {
      const settlement = listener(owner);
      if (settlement) settlements.push(settlement);
    } catch (error) {
      settlements.push(Promise.reject(error));
    }
  }
  if (settlements.length === 0) {
    fallbackSettlementInFlight.delete(owner.streamId);
    fallbackLifecycleStreams.delete(owner.streamId);
    deleteDetachedProjection(owner.streamId);
    emitRegistryChange();
    return;
  }
  void Promise.allSettled(settlements).then((results) => {
    fallbackSettlementInFlight.delete(owner.streamId);
    if (results.some((result) => result.status === "rejected")) {
      // A rejected renderer/cache handoff is not settlement. Retain the drain
      // marker and retry, backing off, while this exact owner is still pending.
      if (fallbackLifecycleStreams.get(owner.streamId) !== owner) {
        fallbackRetryAttempts.delete(owner.streamId);
        emitRegistryChange();
        return;
      }
      const attempt = (fallbackRetryAttempts.get(owner.streamId) ?? 0) + 1;
      if (attempt < MAX_RECONCILIATION_ATTEMPTS) {
        fallbackRetryAttempts.set(owner.streamId, attempt);
        globalThis.setTimeout(() => requestFallback(owner), reconciliationRetryDelayMs(attempt));
        emitRegistryChange();
        return;
      }
      // Out of attempts: release the drain marker so the composer recovers;
      // the chat's own read (and its error state) takes over.
    }
    fallbackRetryAttempts.delete(owner.streamId);
    fallbackLifecycleStreams.delete(owner.streamId);
    deleteDetachedProjection(owner.streamId);
    emitRegistryChange();
  });
}

function parseTerminalStreamId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const streamId = (payload as Record<string, unknown>).streamId;
  return isSafeSubagentIdentifier(streamId) ? streamId : null;
}

function isChatSnapshot(candidate: unknown): candidate is Chat {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return false;
  }
  const chat = candidate as Record<string, unknown>;
  return (
    typeof chat.id === "string" &&
    isSafeSubagentIdentifier(chat.id) &&
    typeof chat.title === "string" &&
    typeof chat.createdAt === "number" &&
    Number.isFinite(chat.createdAt) &&
    typeof chat.updatedAt === "number" &&
    Number.isFinite(chat.updatedAt) &&
    Array.isArray(chat.messages)
  );
}

function parseTerminalChatNotification(payload: unknown): TerminalChatNotification | null {
  const streamId = parseTerminalStreamId(payload);
  if (!streamId || typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  if (candidate.chat === undefined) return { streamId };
  if (!isChatSnapshot(candidate.chat)) return null;
  return { streamId, chat: candidate.chat as Chat };
}

/** Validate the bounded, content-free reconciliation metadata from main. */
export function parseChatReadResponse(payload: unknown): ChatReadResponse | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const candidate = payload as Record<string, unknown>;
  if (
    (candidate.chat !== null && !isChatSnapshot(candidate.chat)) ||
    typeof candidate.imageArtifactRecoveryPending !== "boolean" ||
    typeof candidate.imageArtifactRecoveryUnavailable !== "boolean"
  ) {
    return null;
  }
  if (candidate.reconciliation === null) {
    return {
      chat: candidate.chat as Chat | null,
      imageArtifactRecoveryPending: candidate.imageArtifactRecoveryPending,
      imageArtifactRecoveryUnavailable: candidate.imageArtifactRecoveryUnavailable,
      reconciliation: null,
    };
  }
  if (
    typeof candidate.reconciliation !== "object" ||
    candidate.reconciliation === null ||
    Array.isArray(candidate.reconciliation)
  ) {
    return null;
  }
  const reconciliation = candidate.reconciliation as Record<string, unknown>;
  if (
    !isSafeSubagentIdentifier(reconciliation.chatId) ||
    !isSafeSubagentIdentifier(reconciliation.workspaceId) ||
    (candidate.chat !== null && (candidate.chat as Chat).id !== reconciliation.chatId)
  ) {
    return null;
  }
  return {
    chat: candidate.chat as Chat | null,
    imageArtifactRecoveryPending: candidate.imageArtifactRecoveryPending,
    imageArtifactRecoveryUnavailable: candidate.imageArtifactRecoveryUnavailable,
    reconciliation: {
      chatId: reconciliation.chatId,
      workspaceId: persistedChatWorkspaceId(reconciliation.workspaceId),
    },
  };
}

export function parseChatSettlementNotification(
  payload: unknown,
): ChatSettlementNotification | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.chatId !== "string" ||
    !isSafeSubagentIdentifier(candidate.chatId) ||
    typeof candidate.workspaceId !== "string" ||
    !isSafeSubagentIdentifier(candidate.workspaceId)
  ) {
    return null;
  }
  return {
    chatId: candidate.chatId,
    workspaceId: persistedChatWorkspaceId(candidate.workspaceId),
  };
}

/** Records a run this document started, so its own journal is never mirrored back to it. */
export function rememberOwnGenerationStream(streamId: string): void {
  if (!isSafeSubagentIdentifier(streamId)) return;
  ownGenerationStreams.delete(streamId);
  ownGenerationStreams.add(streamId);
  while (ownGenerationStreams.size > MAX_OWN_GENERATION_STREAMS) {
    const oldest = ownGenerationStreams.values().next().value;
    if (oldest === undefined) break;
    ownGenerationStreams.delete(oldest);
  }
}

/**
 * A route transition deliberately releases every owner-bound interaction
 * listener. Keep bounded renderer-safe presentation state so a revisit stays
 * continuous while the shell reconciles the eventual durable transcript.
 */
export function rememberDetachedLifecycleStream(
  owner: DetachedLifecycleStreamOwner,
  seed?: DetachedLifecycleProjectionSeed,
): void {
  if (
    !isSafeSubagentIdentifier(owner.streamId) ||
    !isSafeSubagentIdentifier(owner.chatId) ||
    !isSafeSubagentIdentifier(owner.workspaceId)
  ) {
    return;
  }
  rememberOwnGenerationStream(owner.streamId);
  detachedLifecycleStreams.delete(owner.streamId);
  detachedLifecycleStreams.set(owner.streamId, owner);
  const content = (seed?.content ?? "").slice(0, MAX_DETACHED_CONTENT_CHARS);
  const timeline = seed?.timeline
    ? parseGenerationTimeline(seed.timeline, content.length)
    : undefined;
  detachedLifecycleProjections.set(owner.streamId, {
    ...owner,
    content,
    lastTextDeltaAt:
      typeof seed?.lastTextDeltaAt === "number" && Number.isFinite(seed.lastTextDeltaAt)
        ? seed.lastTextDeltaAt
        : null,
    reasoning: (seed?.reasoning ?? "").slice(0, MAX_DETACHED_REASONING_CHARS),
    timeline: timeline?.generationId === owner.streamId ? timeline : null,
    artifacts: (seed?.artifacts ?? []).slice(0, MAX_DETACHED_ARTIFACTS),
    uiVisuals: (seed?.uiVisuals ?? []).slice(0, MAX_DETACHED_ARTIFACTS),
    subagents: mergeSubagentSnapshots([], seed?.subagents ?? [], owner),
  });
  while (detachedLifecycleStreams.size > MAX_DETACHED_STREAMS) {
    const oldest = detachedLifecycleStreams.values().next().value;
    if (!oldest) break;
    detachedLifecycleStreams.delete(oldest.streamId);
    deleteDetachedProjection(oldest.streamId);
    // Capacity is a resilience boundary, not permission to silently lose a
    // durable terminal handoff. Ask the shell to discard/refetch that chat.
    requestFallback(oldest);
  }
  emitRegistryChange();
}

/** Route terminal-free start failures through the same authoritative refetch path. */
export function fallbackDetachedLifecycleStream(streamId: string): boolean {
  const owner = detachedLifecycleStreams.get(streamId);
  if (!owner) return false;
  detachedLifecycleStreams.delete(streamId);
  emitRegistryChange();
  requestFallback(owner);
  return true;
}

export function subscribeDetachedLifecycleStreams(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => registryListeners.delete(listener);
}

export function detachedLifecycleChatProjection(
  chatId: string,
  workspaceId: string | undefined,
): DetachedLifecycleProjection | null {
  const expectedWorkspaceId = persistedChatWorkspaceId(workspaceId);
  // The observed run is the chat's current one on this Mac, so it is the newest.
  const observed = observedRunProjections.get(chatReadReconciliationKey({ chatId, workspaceId: expectedWorkspaceId }));
  if (observed) return observed;
  for (const projection of detachedLifecycleProjections.values()) {
    if (projection.chatId === chatId && projection.workspaceId === expectedWorkspaceId) {
      return projection;
    }
  }
  return null;
}

/**
 * A durable terminal message can reach the cache before detached ownership is
 * cleared; during that handoff the projection is hidden so nothing is offered
 * to stop or steer. A mirrored run (a phone's turn) can start while the cache
 * still ends with the previous turn's reply, so only its own saved reply hides
 * it: one stamped with its timeline, or (a text-only reply has none) the
 * message the run reported saving. The observer clears it once a read holds
 * that reply.
 */
export function visibleDetachedLifecycleProjection(
  projection: DetachedLifecycleProjection | null,
  cachedMessages: readonly ChatMessage[] | undefined,
): DetachedLifecycleProjection | null {
  if (!projection) return null;
  const last = cachedMessages?.[cachedMessages.length - 1];
  if (last?.role !== "assistant") return projection;
  if (
    projection.observed === true &&
    last.timeline?.generationId !== projection.streamId &&
    (projection.doneMessageId === undefined || last.id !== projection.doneMessageId)
  ) {
    return projection;
  }
  return null;
}

/**
 * Whether the pane presents a shown projection's text as final. A route-detached
 * run is shown complete, as it always has been; a mirrored run (a phone's turn)
 * streams live, with the paced reveal, until the run finishes.
 */
export function detachedProjectionStreamComplete(projection: DetachedLifecycleProjection | null): boolean {
  if (!projection) return false;
  return projection.observed !== true || projection.finished === true;
}

export function isDetachedLifecycleChatDraining(
  chatId: string,
  workspaceId: string | undefined,
): boolean {
  const expectedWorkspaceId = persistedChatWorkspaceId(workspaceId);
  return (
    [...detachedLifecycleStreams.values(), ...fallbackLifecycleStreams.values()].some(
      (owner) => owner.chatId === chatId && owner.workspaceId === expectedWorkspaceId,
    ) ||
    [...chatReadReconciliations.values()].some(
      (owner) => owner.chatId === chatId && owner.workspaceId === expectedWorkspaceId,
    ) ||
    observedRunProjections.has(chatReadReconciliationKey({ chatId, workspaceId: expectedWorkspaceId }))
  );
}

/**
 * Shows a run this window is watching but did not start, live, through the
 * same projection a route-detached run uses. A run this window owns keeps its
 * own projection and is ignored here. Returns whether the projection changed.
 */
export function publishObservedRunProjection(
  owner: DetachedLifecycleStreamOwner,
  snapshot: ObservedRunSnapshot,
  now: number = Date.now(),
): boolean {
  if (
    !isSafeSubagentIdentifier(owner.streamId) ||
    !isSafeSubagentIdentifier(owner.chatId) ||
    !isSafeSubagentIdentifier(owner.workspaceId)
  ) {
    return false;
  }
  const normalized = {
    streamId: owner.streamId,
    chatId: owner.chatId,
    workspaceId: persistedChatWorkspaceId(owner.workspaceId),
  };
  const key = chatReadReconciliationKey(normalized);
  if (
    detachedLifecycleStreams.has(normalized.streamId) ||
    ownGenerationStreams.has(normalized.streamId)
  ) {
    return clearObservedRunProjection(normalized.chatId, normalized.workspaceId, normalized.streamId);
  }
  const previous = observedRunProjections.get(key);
  const sameRun = previous?.streamId === normalized.streamId;
  const content = snapshot.text.slice(0, MAX_DETACHED_CONTENT_CHARS);
  const reasoning = snapshot.reasoning.slice(0, MAX_DETACHED_REASONING_CHARS);
  // The translator already validated the timeline; keep its identity so an unchanged one is not re-published.
  const timeline = snapshot.timeline;
  const textGrew = content.length > (sameRun ? previous.content.length : 0);
  const next: DetachedLifecycleProjection = {
    ...normalized,
    content,
    lastTextDeltaAt:
      snapshot.textStreaming && textGrew ? now : sameRun ? previous.lastTextDeltaAt : null,
    reasoning,
    timeline: timeline?.generationId === normalized.streamId ? timeline : null,
    artifacts: [],
    uiVisuals: [],
    subagents: [],
    observed: true,
    ...(snapshot.doneMessageId ? { doneMessageId: snapshot.doneMessageId } : {}),
    ...(snapshot.finished ? { finished: true as const } : {}),
  };
  if (
    sameRun &&
    previous.content === next.content &&
    previous.reasoning === next.reasoning &&
    previous.timeline === next.timeline &&
    previous.lastTextDeltaAt === next.lastTextDeltaAt &&
    previous.doneMessageId === next.doneMessageId &&
    previous.finished === next.finished
  ) {
    return false;
  }
  observedRunProjections.set(key, next);
  // Only the streamed text and reasoning grew: tell subscribers once a frame.
  const textOnly =
    sameRun &&
    previous.timeline === next.timeline &&
    previous.doneMessageId === next.doneMessageId &&
    previous.finished === next.finished;
  if (textOnly) scheduleRegistryChange();
  else emitRegistryChange();
  return true;
}

/** Drops a chat's observed run, or only `streamId` when given. */
export function clearObservedRunProjection(
  chatId: string,
  workspaceId: string | undefined,
  streamId?: string,
): boolean {
  const key = chatReadReconciliationKey({ chatId, workspaceId: persistedChatWorkspaceId(workspaceId) });
  const current = observedRunProjections.get(key);
  if (!current || (streamId !== undefined && current.streamId !== streamId)) return false;
  observedRunProjections.delete(key);
  emitRegistryChange();
  return true;
}

function ownsLifecycleChat(
  owner: ChatSettlementNotification,
  chatId: string,
  workspaceId: string,
): boolean {
  return owner.chatId === chatId && owner.workspaceId === workspaceId;
}

/** Capture exact retained streams so recovery cannot clear newer work in the same chat. */
export function pendingDetachedLifecycleChats(): DetachedLifecycleChatReconciliation[] {
  const pending = new Map<string, DetachedLifecycleChatReconciliation>();
  for (const [streamId, owner] of [
    ...detachedLifecycleStreams.entries(),
    ...fallbackLifecycleStreams.entries(),
  ]) {
    const key = chatReadReconciliationKey(owner);
    const retained = pending.get(key);
    if (retained?.streamIds.includes(streamId)) continue;
    pending.set(key, {
      chatId: owner.chatId,
      workspaceId: owner.workspaceId,
      streamIds: [...(retained?.streamIds ?? []), streamId],
    });
  }
  return [...pending.values()];
}

export function captureDetachedLifecycleChat(
  owner: ChatSettlementNotification,
): DetachedLifecycleChatReconciliation | null {
  const workspaceId = persistedChatWorkspaceId(owner.workspaceId);
  return (
    pendingDetachedLifecycleChats().find((candidate) =>
      ownsLifecycleChat(candidate, owner.chatId, workspaceId),
    ) ?? null
  );
}

/** Clear captured ownership only after main's current activity snapshot proves inactivity. */
export function clearInactiveDetachedLifecycleChat(
  owner: DetachedLifecycleChatReconciliation,
  activeChatIds: ReadonlySet<string>,
): boolean {
  if (
    !isSafeSubagentIdentifier(owner.chatId) ||
    !isSafeSubagentIdentifier(owner.workspaceId) ||
    !owner.streamIds.every(isSafeSubagentIdentifier) ||
    activeChatIds.has(owner.chatId)
  ) {
    return false;
  }
  return clearCapturedStreams(owner, owner.streamIds);
}

/**
 * Drops the captured streams that main reports finished for good, even while
 * the chat is busy with a newer run (a phone's turn that followed a
 * route-detached one). Call it only after the chat cache has been re-read, so
 * the transcript already holds what those streams persisted.
 */
export function clearSettledDetachedLifecycleStreams(
  owner: DetachedLifecycleChatReconciliation,
  settledStreamIds: readonly string[],
): boolean {
  if (
    !isSafeSubagentIdentifier(owner.chatId) ||
    !isSafeSubagentIdentifier(owner.workspaceId) ||
    !owner.streamIds.every(isSafeSubagentIdentifier)
  ) {
    return false;
  }
  const settled = new Set(settledStreamIds);
  return clearCapturedStreams(owner, owner.streamIds.filter((streamId) => settled.has(streamId)));
}

export interface SettledStreamRelease {
  /** Which of these streams main reports finished for good. */
  settled(streamIds: readonly string[]): Promise<readonly string[]>;
  /** Re-reads the chat (and its list row) so the cache holds what they persisted. */
  refreshChat(chatId: string): Promise<void>;
}

/** Bound on one settled query, matching main's. */
const MAX_SETTLED_QUERY = 64;
/** Re-reads tried before a release gives way to the chat-level idle path. */
const SETTLED_REFRESH_ATTEMPTS = 3;

/**
 * A per-stream settlement for a chat that is still busy (a phone's turn began
 * right after a route-detached one) used to leave the detached marker in
 * place until the whole chat went idle, so the pane said "Response continues
 * in the background…" for a run that had already finished. This releases
 * exactly the captured streams main confirms settled, after a fresh read.
 */
export async function releaseSettledDetachedLifecycleStreams(
  owner: ChatSettlementNotification,
  io: SettledStreamRelease,
): Promise<boolean> {
  const captured = captureDetachedLifecycleChat(owner);
  if (!captured || captured.streamIds.length === 0) return false;
  const settled = await io.settled(captured.streamIds.slice(-MAX_SETTLED_QUERY));
  if (settled.length === 0) return false;
  // A competing read of the same chat (the observer's) cancels this one, so a
  // rejected read is tried again rather than leaving the marker until idle.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await io.refreshChat(captured.chatId);
      break;
    } catch (error) {
      if (attempt >= SETTLED_REFRESH_ATTEMPTS) throw error;
      await new Promise((resolve) => globalThis.setTimeout(resolve, FALLBACK_RETRY_DELAY_MS));
    }
  }
  return clearSettledDetachedLifecycleStreams(captured, settled);
}

function clearCapturedStreams(
  owner: DetachedLifecycleChatReconciliation,
  streamIds: readonly string[],
): boolean {
  const workspaceId = persistedChatWorkspaceId(owner.workspaceId);
  let changed = false;
  for (const streamId of streamIds) {
    const detachedOwner = detachedLifecycleStreams.get(streamId);
    if (detachedOwner && ownsLifecycleChat(detachedOwner, owner.chatId, workspaceId)) {
      detachedLifecycleStreams.delete(streamId);
      changed = true;
    }
    const fallbackOwner = fallbackLifecycleStreams.get(streamId);
    if (fallbackOwner && ownsLifecycleChat(fallbackOwner, owner.chatId, workspaceId)) {
      fallbackLifecycleStreams.delete(streamId);
      changed = true;
    }
    const projection = detachedLifecycleProjections.get(streamId);
    if (projection && ownsLifecycleChat(projection, owner.chatId, workspaceId)) {
      detachedLifecycleProjections.delete(streamId);
      changed = true;
    }
  }
  if (changed) emitRegistryChange();
  return changed;
}

function requestChatReadReconciliation(owner: ChatReadReconciliation): void {
  const key = chatReadReconciliationKey(owner);
  if (
    chatReadReconciliationInFlight.has(key) ||
    chatReadReconciliationListeners.size === 0 ||
    chatReadReconciliations.get(key) !== owner
  ) {
    return;
  }
  chatReadReconciliationInFlight.add(key);
  const settlements: Promise<void>[] = [];
  for (const listener of chatReadReconciliationListeners) {
    try {
      const settlement = listener(owner);
      if (settlement) settlements.push(settlement);
    } catch (error) {
      settlements.push(Promise.reject(error));
    }
  }
  if (settlements.length === 0) {
    chatReadReconciliationInFlight.delete(key);
    chatReadReconciliations.delete(key);
    emitRegistryChange();
    return;
  }
  void Promise.allSettled(settlements).then((results) => {
    chatReadReconciliationInFlight.delete(key);
    if (
      results.some((result) => result.status === "rejected") &&
      chatReadReconciliations.get(key) === owner
    ) {
      const attempt = (chatReadReconciliationRetryAttempts.get(key) ?? 0) + 1;
      if (attempt < MAX_RECONCILIATION_ATTEMPTS) {
        chatReadReconciliationRetryAttempts.set(key, attempt);
        globalThis.setTimeout(
          () => requestChatReadReconciliation(owner),
          reconciliationRetryDelayMs(attempt),
        );
        emitRegistryChange();
        return;
      }
      // Out of attempts: drop the marker rather than keep the chat draining.
    }
    chatReadReconciliationRetryAttempts.delete(key);
    if (chatReadReconciliations.get(key) === owner) {
      chatReadReconciliations.delete(key);
      emitRegistryChange();
    }
  });
}

/**
 * Retain a provisional-read marker until the shell has observed idle and
 * completed an exact authoritative cache refetch. This closes the gap where a
 * settlement broadcast predates passive listener registration.
 */
export function rememberChatReadReconciliation(owner: ChatReadReconciliation): void {
  if (!isSafeSubagentIdentifier(owner.chatId) || !isSafeSubagentIdentifier(owner.workspaceId)) {
    return;
  }
  const normalized = {
    chatId: owner.chatId,
    workspaceId: persistedChatWorkspaceId(owner.workspaceId),
  };
  const key = chatReadReconciliationKey(normalized);
  const retained = chatReadReconciliations.get(key);
  if (retained) {
    requestChatReadReconciliation(retained);
    return;
  }
  chatReadReconciliations.set(key, normalized);
  emitRegistryChange();
  requestChatReadReconciliation(normalized);
}

export function subscribeChatReadReconciliations(
  listener: (owner: ChatReadReconciliation) => void | Promise<void>,
): () => void {
  chatReadReconciliationListeners.add(listener);
  for (const owner of chatReadReconciliations.values()) {
    requestChatReadReconciliation(owner);
  }
  return () => chatReadReconciliationListeners.delete(listener);
}

/** Never let an older detached completion roll a newer chat cache backward. */
export function preferLatestTerminalChat(current: Chat | null | undefined, incoming: Chat): Chat {
  if (!current || current.id !== incoming.id) return incoming;
  if (current.updatedAt > incoming.updatedAt) return current;
  if (
    current.updatedAt === incoming.updatedAt &&
    current.messages.length > incoming.messages.length
  ) {
    return current;
  }
  return incoming;
}

/** Waits between reconciliation attempts; `delayMs` is the backoff for this one. */
export type ReconciliationPause = (delayMs: number) => Promise<void>;

const defaultReconciliationPause: ReconciliationPause = (delayMs) =>
  new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));

/**
 * Retry bounded main-process waits until ownership has actually settled.
 * `false` means main waited out its own bounded grace while the chat stayed
 * busy (a long run), so that keeps waiting. A thrown wait (IPC unavailable)
 * backs off, and after `MAX_RECONCILIATION_ATTEMPTS` consecutive failures
 * this resolves `false` so the caller can give up instead of polling forever.
 */
export async function waitForDetachedLifecycleSettlement(
  waitUntilIdle: () => Promise<boolean>,
  pause: ReconciliationPause = defaultReconciliationPause,
  isCancelled: () => boolean = () => false,
): Promise<boolean> {
  let failures = 0;
  for (;;) {
    if (isCancelled()) return false;
    try {
      if (await waitUntilIdle()) return true;
      failures = 0;
      await pause(FALLBACK_RETRY_DELAY_MS);
    } catch {
      // Renderer/main reconnects are retryable, with backoff. The fallback
      // drain marker stays installed until success or the attempts run out.
      failures += 1;
      if (failures >= MAX_RECONCILIATION_ATTEMPTS) return false;
      await pause(reconciliationRetryDelayMs(failures));
    }
  }
}

/**
 * Reconcile a provisional transcript without trusting one-shot notifications.
 * Individual ownership waits stay bounded in main; this retained renderer task
 * retries, backing off, until the exact transcript and its list metadata are
 * both refreshed. A read that keeps failing ends as `"failed"` after
 * `MAX_RECONCILIATION_ATTEMPTS`, so the caller can surface the chat's own
 * load error instead of leaving it draining.
 */
export async function reconcileChatReadUntilAuthoritative(options: {
  isDeleted: () => boolean;
  waitUntilIdle: () => Promise<boolean>;
  refreshChat: () => Promise<void>;
  refreshChatList: () => Promise<void>;
  pause?: ReconciliationPause;
}): Promise<"deleted" | "reconciled" | "failed"> {
  const pause = options.pause ?? defaultReconciliationPause;
  if (options.isDeleted()) return "deleted";
  const settled = await waitForDetachedLifecycleSettlement(
    options.waitUntilIdle,
    pause,
    options.isDeleted,
  );
  if (options.isDeleted()) return "deleted";
  if (!settled) return "failed";
  for (let attempt = 1; ; attempt += 1) {
    try {
      await options.refreshChat();
      if (options.isDeleted()) return "deleted";
      await options.refreshChatList();
      return options.isDeleted() ? "deleted" : "reconciled";
    } catch {
      if (options.isDeleted()) return "deleted";
      if (attempt >= MAX_RECONCILIATION_ATTEMPTS) return "failed";
      await pause(reconciliationRetryDelayMs(attempt));
    }
  }
}

/** Parse the content-free main-process settlement signal in one shared place. */
export function subscribeChatSettlements(
  subscribe: SettlementSubscribe,
  onSettlement: (settlement: ChatSettlementNotification) => void,
): () => void {
  return subscribe("chats:settled", (payload) => {
    const settlement = parseChatSettlementNotification(payload);
    if (settlement) onSettlement(settlement);
  });
}

/**
 * Subscribe once at the app shell. Ordinary visible generations remain owned by
 * ChatPane; detached streams update only their bounded presentation projection
 * until a terminal payload has reached the authoritative chat cache.
 */
export function subscribeDetachedTerminalChats(
  subscribe: Subscribe,
  onChat: (chat: Chat) => unknown,
  onFallback?: (owner: DetachedLifecycleStreamOwner) => void | Promise<void>,
): () => void {
  const streamPayload = (payload: unknown) => {
    const streamId = parseTerminalStreamId(payload);
    if (!streamId || typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return null;
    }
    return { streamId, payload: payload as Record<string, unknown> };
  };
  const unsubscribeDelta = subscribe("chat:delta", (payload) => {
    const parsed = streamPayload(payload);
    if (!parsed) return;
    const delta = parsed.payload.delta;
    const reset = parsed.payload.reset === true;
    if (!reset && typeof delta !== "string") return;
    updateDetachedProjection(parsed.streamId, (current) => ({
      ...current,
      content: reset
        ? ""
        : appendBounded(current.content, delta as string, MAX_DETACHED_CONTENT_CHARS),
      reasoning: reset ? "" : current.reasoning,
      lastTextDeltaAt:
        reset ? null : (delta as string).length > 0 ? Date.now() : current.lastTextDeltaAt,
    }), reset ? "now" : "frame");
  });
  const unsubscribeReasoning = subscribe("chat:reasoning-delta", (payload) => {
    const parsed = streamPayload(payload);
    if (!parsed || typeof parsed.payload.delta !== "string") return;
    updateDetachedProjection(parsed.streamId, (current) => ({
      ...current,
      reasoning: appendBounded(
        current.reasoning,
        parsed.payload.delta as string,
        MAX_DETACHED_REASONING_CHARS,
      ),
    }), "frame");
  });
  const unsubscribeTimeline = subscribe("chat:timeline", (payload) => {
    const parsed = streamPayload(payload);
    if (!parsed) return;
    const timeline = parseGenerationTimeline(parsed.payload.timeline);
    if (!timeline || timeline.generationId !== parsed.streamId) return;
    updateDetachedProjection(parsed.streamId, (current) => ({ ...current, timeline }));
  });
  const unsubscribeArtifact = subscribe("chat:artifact", (payload) => {
    const parsed = streamPayload(payload);
    if (!parsed) return;
    const event = parseChatArtifactEventV1(parsed.payload.event);
    if (!event) return;
    updateDetachedProjection(parsed.streamId, (current) => {
      if (event.operation === "reset") return { ...current, artifacts: [], uiVisuals: [] };
      if (event.operation === "ui") {
        const uiVisuals = reduceUiVisuals(current.uiVisuals ?? [], event);
        return uiVisuals.length > MAX_DETACHED_ARTIFACTS ? current : { ...current, uiVisuals };
      }
      // Detached views show settled artifacts only; live drafts are per-window.
      if (event.operation !== "present") return current;
      const identity = chatArtifactIdentity(event.artifact);
      const index = current.artifacts.findIndex(
        (candidate) => chatArtifactIdentity(candidate) === identity,
      );
      if (index >= 0) {
        return {
          ...current,
          artifacts: current.artifacts.map((candidate, i) =>
            i === index ? event.artifact : candidate,
          ),
        };
      }
      if (current.artifacts.length >= MAX_DETACHED_ARTIFACTS) return current;
      return { ...current, artifacts: [...current.artifacts, event.artifact] };
    });
  });
  const unsubscribeSubagents = subscribe("chat:subagents", (payload) => {
    const parsed = streamPayload(payload);
    if (!parsed) return;
    const snapshot = parseSubagentRunSnapshot(parsed.payload.snapshot);
    if (!snapshot || snapshot.generationId !== parsed.streamId) return;
    updateDetachedProjection(parsed.streamId, (current) => ({
      ...current,
      subagents: mergeSubagentSnapshots(current.subagents, [snapshot], {
        chatId: current.chatId,
        workspaceId: current.workspaceId,
      }),
    }));
  });
  const handle = (payload: unknown) => {
    const terminal = parseTerminalChatNotification(payload);
    if (!terminal) {
      const malformedStreamId = parseTerminalStreamId(payload);
      if (malformedStreamId) fallbackDetachedLifecycleStream(malformedStreamId);
      return;
    }
    const owner = detachedLifecycleStreams.get(terminal.streamId);
    if (!owner || terminalSettlementInFlight.has(terminal.streamId)) return;
    // Accepted Steer text that never reached the chat returns to its draft.
    restoreUndeliveredGuidance(owner.chatId, undeliveredGuidanceFromTerminal(payload));
    if (
      !terminal.chat ||
      terminal.chat.id !== owner.chatId ||
      persistedChatWorkspaceId(terminal.chat.workspaceId) !== owner.workspaceId
    ) {
      detachedLifecycleStreams.delete(terminal.streamId);
      emitRegistryChange();
      requestFallback(owner);
      return;
    }
    terminalSettlementInFlight.add(terminal.streamId);
    const complete = () => {
      terminalSettlementInFlight.delete(terminal.streamId);
      if (detachedLifecycleStreams.get(terminal.streamId) === owner) {
        detachedLifecycleStreams.delete(terminal.streamId);
        deleteDetachedProjection(terminal.streamId);
        emitRegistryChange();
      }
    };
    try {
      const settlement = onChat(terminal.chat);
      if (
        !settlement ||
        typeof settlement !== "object" ||
        typeof (settlement as PromiseLike<unknown>).then !== "function"
      ) {
        complete();
        return;
      }
      void Promise.resolve(settlement).then(complete, () => {
        terminalSettlementInFlight.delete(terminal.streamId);
        if (detachedLifecycleStreams.get(terminal.streamId) === owner) {
          detachedLifecycleStreams.delete(terminal.streamId);
          emitRegistryChange();
          requestFallback(owner);
        }
      });
    } catch {
      terminalSettlementInFlight.delete(terminal.streamId);
      if (detachedLifecycleStreams.get(terminal.streamId) === owner) {
        detachedLifecycleStreams.delete(terminal.streamId);
        emitRegistryChange();
        requestFallback(owner);
      }
    }
  };
  if (onFallback) {
    fallbackListeners.add(onFallback);
    for (const owner of fallbackLifecycleStreams.values()) requestFallback(owner);
  }
  const unsubscribeDone = subscribe("chat:done", handle);
  const unsubscribeError = subscribe("chat:error", handle);
  return () => {
    if (onFallback) fallbackListeners.delete(onFallback);
    unsubscribeDone();
    unsubscribeError();
    unsubscribeDelta();
    unsubscribeReasoning();
    unsubscribeTimeline();
    unsubscribeArtifact();
    unsubscribeSubagents();
  };
}
