import type { Chat, ChatReadResponse } from "./types";
import { persistedChatWorkspaceId } from "../shared/chat-workspace";
import { isSafeSubagentIdentifier } from "../shared/subagent-runs";

const MAX_DETACHED_STREAMS = 64;
const FALLBACK_RETRY_DELAY_MS = 100;
const detachedLifecycleStreams = new Map<string, DetachedLifecycleStreamOwner>();
const fallbackLifecycleStreams = new Map<string, DetachedLifecycleStreamOwner>();
const fallbackSettlementInFlight = new Set<string>();
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

interface TerminalChatNotification {
  streamId: string;
  chat?: Chat;
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
  channel: "chat:done" | "chat:error",
  handler: (payload: unknown) => void,
) => () => void;
type SettlementSubscribe = (
  channel: "chats:settled",
  handler: (payload: unknown) => void,
) => () => void;

function emitRegistryChange(): void {
  for (const listener of registryListeners) listener();
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
    typeof candidate.imageArtifactRecoveryPending !== "boolean"
  ) {
    return null;
  }
  if (candidate.reconciliation === null) {
    return {
      chat: candidate.chat as Chat | null,
      imageArtifactRecoveryPending: candidate.imageArtifactRecoveryPending,
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
 * A route transition deliberately releases every per-generation listener. Keep
 * only the bounded stream identity so the shell's two shared terminal listeners
 * can reconcile a response that becomes durable after its chat was left.
 */
export function rememberDetachedLifecycleStream(owner: DetachedLifecycleStreamOwner): void {
  if (
    !isSafeSubagentIdentifier(owner.streamId) ||
    !isSafeSubagentIdentifier(owner.chatId) ||
    !isSafeSubagentIdentifier(owner.workspaceId)
  ) {
    return;
  }
  detachedLifecycleStreams.delete(owner.streamId);
  detachedLifecycleStreams.set(owner.streamId, owner);
  while (detachedLifecycleStreams.size > MAX_DETACHED_STREAMS) {
    const oldest = detachedLifecycleStreams.values().next().value;
    if (!oldest) break;
    detachedLifecycleStreams.delete(oldest.streamId);
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
 * ChatPane; only terminal payloads for lifecycle-detached streams update cache.
 */
export function subscribeDetachedTerminalChats(
  subscribe: Subscribe,
  onChat: (chat: Chat) => void,
  onFallback?: (owner: DetachedLifecycleStreamOwner) => void | Promise<void>,
): () => void {
  const handle = (payload: unknown) => {
    const terminal = parseTerminalChatNotification(payload);
    if (!terminal) {
      const malformedStreamId = parseTerminalStreamId(payload);
      if (malformedStreamId) fallbackDetachedLifecycleStream(malformedStreamId);
      return;
    }
    const owner = detachedLifecycleStreams.get(terminal.streamId);
    if (!owner) return;
    detachedLifecycleStreams.delete(terminal.streamId);
    emitRegistryChange();
    if (
      !terminal.chat ||
      terminal.chat.id !== owner.chatId ||
      persistedChatWorkspaceId(terminal.chat.workspaceId) !== owner.workspaceId
    ) {
      requestFallback(owner);
      return;
    }
    onChat(terminal.chat);
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
  };
}
