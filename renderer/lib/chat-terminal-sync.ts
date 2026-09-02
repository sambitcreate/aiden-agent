import type { Chat, ChatReadResponse } from "./types";
import { persistedChatWorkspaceId } from "../shared/chat-workspace";
import {
  isSafeSubagentIdentifier,
  parseSubagentRunSnapshot,
  type SubagentRunSnapshot,
} from "../shared/subagent-runs";
import { parseGenerationTimeline, type GenerationTimeline } from "../shared/generation-timeline";
import {
  chatArtifactIdentity,
  isChatHtmlArtifact,
  parseChatArtifactEventV1,
  parseChatArtifactV1,
  type ChatArtifactV1,
  type ChatHtmlArtifactV1,
} from "../shared/chat-artifacts";
import { mergeSubagentSnapshots } from "./subagent-view-state";

const MAX_DETACHED_STREAMS = 64;
const MAX_DETACHED_CONTENT_CHARS = 1_000_000;
const MAX_DETACHED_REASONING_CHARS = 250_000;
const MAX_DETACHED_ARTIFACTS = 8;
const FALLBACK_RETRY_DELAY_MS = 100;
const detachedLifecycleStreams = new Map<string, DetachedLifecycleStreamOwner>();
const fallbackLifecycleStreams = new Map<string, DetachedLifecycleStreamOwner>();
const detachedLifecycleProjections = new Map<string, DetachedLifecycleProjection>();
const fallbackSettlementInFlight = new Set<string>();
const terminalSettlementInFlight = new Set<string>();
const chatReadReconciliations = new Map<string, ChatReadReconciliation>();
const chatReadReconciliationInFlight = new Set<string>();
const registryListeners = new Set<() => void>();
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
  subagents: readonly SubagentRunSnapshot[];
  /** Retained after terminal cache settlement until Design consumes its project handoff. */
  designPublication?: "published" | "retryable" | "suppressed";
  /** Main-owned terminal explanation retained only for suppressed Design publication. */
  terminalError?: string;
}

export type DetachedLifecycleProjectionSeed = Omit<
  DetachedLifecycleProjection,
  keyof DetachedLifecycleStreamOwner | "lastTextDeltaAt"
> & { lastTextDeltaAt?: number | null };

interface TerminalChatNotification {
  streamId: string;
  chat?: Chat;
  designPublication?: "retryable" | "suppressed";
  terminalError?: string;
}

export interface ChatSettlementNotification {
  chatId: string;
  workspaceId: string;
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

function emitRegistryChange(): void {
  for (const listener of registryListeners) listener();
}

function deleteDetachedProjection(streamId: string): void {
  detachedLifecycleProjections.delete(streamId);
}

function appendBounded(current: string, delta: string, maximum: number): string {
  if (current.length >= maximum) return current;
  return (current + delta).slice(0, maximum);
}

function terminalDesignArtifacts(chat: Chat): ChatHtmlArtifactV1[] {
  const terminalMessage = chat.messages[chat.messages.length - 1];
  if (terminalMessage?.role !== "assistant" || !Array.isArray(terminalMessage.htmlArtifacts)) {
    return [];
  }
  return terminalMessage.htmlArtifacts
    .flatMap((value) => {
      const artifact = parseChatArtifactV1(value);
      return artifact && isChatHtmlArtifact(artifact) && artifact.mediaId.startsWith("design:")
        ? [artifact]
        : [];
    })
    .slice(0, MAX_DETACHED_ARTIFACTS);
}

function mergeBoundedArtifacts(
  current: readonly ChatArtifactV1[],
  incoming: readonly ChatArtifactV1[],
): readonly ChatArtifactV1[] {
  const merged = [...current];
  for (const artifact of incoming) {
    const identity = chatArtifactIdentity(artifact);
    const index = merged.findIndex((candidate) => chatArtifactIdentity(candidate) === identity);
    if (index >= 0) merged[index] = artifact;
    else if (merged.length < MAX_DETACHED_ARTIFACTS) merged.push(artifact);
  }
  return merged;
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
): void {
  const current = detachedLifecycleProjections.get(streamId);
  if (!current || !detachedLifecycleStreams.has(streamId)) return;
  detachedLifecycleProjections.set(streamId, update(current));
  emitRegistryChange();
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
      // marker and retry while this exact owner is still pending.
      if (fallbackLifecycleStreams.get(owner.streamId) === owner) {
        globalThis.setTimeout(() => requestFallback(owner), FALLBACK_RETRY_DELAY_MS);
      }
      emitRegistryChange();
      return;
    }
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
  const designPublication =
    candidate.designPublication === "retryable" || candidate.designPublication === "suppressed"
      ? candidate.designPublication
      : undefined;
  const terminalError =
    typeof candidate.message === "string" && candidate.message.trim()
      ? candidate.message.trim().slice(0, MAX_DETACHED_REASONING_CHARS)
      : undefined;
  if (candidate.designPublication !== undefined && !designPublication) return null;
  if (candidate.chat === undefined) {
    return {
      streamId,
      ...(designPublication ? { designPublication } : {}),
      ...(terminalError ? { terminalError } : {}),
    };
  }
  if (!isChatSnapshot(candidate.chat)) return null;
  return {
    streamId,
    chat: candidate.chat as Chat,
    ...(designPublication ? { designPublication } : {}),
    ...(terminalError ? { terminalError } : {}),
  };
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
  while (detachedLifecycleProjections.size > MAX_DETACHED_STREAMS) {
    const oldest = detachedLifecycleProjections.values().next().value;
    if (!oldest) break;
    deleteDetachedProjection(oldest.streamId);
    const activeOwner = detachedLifecycleStreams.get(oldest.streamId);
    if (activeOwner) {
      detachedLifecycleStreams.delete(oldest.streamId);
      requestFallback(activeOwner);
    }
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
  for (const projection of detachedLifecycleProjections.values()) {
    if (projection.chatId === chatId && projection.workspaceId === expectedWorkspaceId) {
      return projection;
    }
  }
  return null;
}

/** Exact acknowledgement after ChatPane has adopted a detached terminal Design handoff. */
export function acknowledgeDetachedDesignPublication(input: {
  streamId: string;
  chatId: string;
  workspaceId: string;
}): boolean {
  const projection = detachedLifecycleProjections.get(input.streamId);
  if (
    projection?.designPublication === undefined ||
    projection.chatId !== input.chatId ||
    projection.workspaceId !== persistedChatWorkspaceId(input.workspaceId)
  ) {
    return false;
  }
  detachedLifecycleProjections.delete(input.streamId);
  emitRegistryChange();
  return true;
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
    )
  );
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
      globalThis.setTimeout(() => requestChatReadReconciliation(owner), FALLBACK_RETRY_DELAY_MS);
      emitRegistryChange();
      return;
    }
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

/** Retry bounded main-process waits until ownership has actually settled. */
export async function waitForDetachedLifecycleSettlement(
  waitUntilIdle: () => Promise<boolean>,
  pause: () => Promise<void> = () =>
    new Promise<void>((resolve) => window.setTimeout(resolve, 100)),
): Promise<void> {
  for (;;) {
    try {
      if (await waitUntilIdle()) return;
    } catch {
      // Renderer/main reconnects and bounded wait timeouts are retryable. The
      // fallback drain marker stays installed until an authoritative success.
    }
    await pause();
  }
}

/**
 * Reconcile a provisional transcript without trusting one-shot notifications.
 * Individual ownership waits stay bounded in main; this retained renderer task
 * retries until the exact transcript and its list metadata are both refreshed.
 */
export async function reconcileChatReadUntilAuthoritative(options: {
  isDeleted: () => boolean;
  waitUntilIdle: () => Promise<boolean>;
  refreshChat: () => Promise<void>;
  refreshChatList: () => Promise<void>;
  pause?: () => Promise<void>;
}): Promise<"deleted" | "reconciled"> {
  const pause =
    options.pause ?? (() => new Promise<void>((resolve) => window.setTimeout(resolve, 100)));
  if (options.isDeleted()) return "deleted";
  await waitForDetachedLifecycleSettlement(options.waitUntilIdle, pause);
  if (options.isDeleted()) return "deleted";
  for (;;) {
    try {
      await options.refreshChat();
      if (options.isDeleted()) return "deleted";
      await options.refreshChatList();
      return options.isDeleted() ? "deleted" : "reconciled";
    } catch {
      if (options.isDeleted()) return "deleted";
      await pause();
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
      lastTextDeltaAt: reset
        ? null
        : (delta as string).length > 0
          ? Date.now()
          : current.lastTextDeltaAt,
    }));
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
    }));
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
      if (event.operation === "reset") return { ...current, artifacts: [] };
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
  const handle = (payload: unknown, terminalKind: "done" | "error") => {
    const terminal = parseTerminalChatNotification(payload);
    if (!terminal) {
      const malformedStreamId = parseTerminalStreamId(payload);
      if (malformedStreamId) fallbackDetachedLifecycleStream(malformedStreamId);
      return;
    }
    const owner = detachedLifecycleStreams.get(terminal.streamId);
    if (!owner || terminalSettlementInFlight.has(terminal.streamId)) return;
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
        const projection = detachedLifecycleProjections.get(terminal.streamId);
        const persistedDesignArtifacts = terminalDesignArtifacts(terminal.chat!);
        const retainedPublication =
          terminal.designPublication === "suppressed"
            ? "suppressed"
            : terminal.designPublication === "retryable"
              ? "retryable"
              : terminalKind === "done" && persistedDesignArtifacts.length > 0
                ? "published"
                : undefined;
        if (retainedPublication && projection) {
          detachedLifecycleProjections.set(terminal.streamId, {
            ...projection,
            artifacts: mergeBoundedArtifacts(projection.artifacts, persistedDesignArtifacts),
            designPublication: retainedPublication,
            ...(retainedPublication === "suppressed"
              ? {
                  terminalError:
                    terminal.terminalError ??
                    "The response was saved, but its Design revision was not added to project history.",
                }
              : {}),
          });
        } else {
          deleteDetachedProjection(terminal.streamId);
        }
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
  const unsubscribeDone = subscribe("chat:done", (payload) => handle(payload, "done"));
  const unsubscribeError = subscribe("chat:error", (payload) => handle(payload, "error"));
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
