import * as React from "react";
import {
  parseSubagentContextUsageNotification,
  type SubagentContextUsageV1,
} from "../shared/subagent-context-usage";
import { onNotification } from "./ipc";
import { isSubagentRunViewStateActive, type SubagentRunView } from "./subagent-view-state";

export type SubagentContextUsageByRunId = ReadonlyMap<string, SubagentContextUsageV1>;

const EMPTY: SubagentContextUsageByRunId = new Map();
const DEFAULT_MAX_CHATS = 32;
const DEFAULT_MAX_RUNS_PER_CHAT = 64;

export interface SubagentContextUsageStore {
  /** Apply one `chat:subagent-context` payload. Malformed payloads are ignored. */
  apply(payload: unknown): boolean;
  /** Stable (reference-equal until changed) readings for one chat. */
  forChat(chatId: string | null | undefined): SubagentContextUsageByRunId;
  subscribe(listener: () => void): () => void;
}

/**
 * Renderer memory of the latest live context reading per child run. Readings
 * are presentation hints: they are bounded, never persisted, and callers only
 * show them for runs whose durable snapshot is still active.
 */
export function createSubagentContextUsageStore(
  options: { maxChats?: number; maxRunsPerChat?: number } = {},
): SubagentContextUsageStore {
  const maxChats = options.maxChats ?? DEFAULT_MAX_CHATS;
  const maxRunsPerChat = options.maxRunsPerChat ?? DEFAULT_MAX_RUNS_PER_CHAT;
  const byChat = new Map<string, SubagentContextUsageByRunId>();
  const listeners = new Set<() => void>();

  return {
    apply(payload) {
      const notification = parseSubagentContextUsageNotification(payload);
      if (!notification) return false;
      const { chatId, runId, usage } = notification;
      const current = byChat.get(chatId);
      const previous = current?.get(runId);
      if (previous && previous.tokens === usage.tokens && previous.window === usage.window) {
        return false;
      }
      const next = new Map(current ?? EMPTY);
      next.delete(runId);
      next.set(runId, usage);
      while (next.size > maxRunsPerChat) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
      }
      // Re-insert so the most recently updated chat is evicted last.
      byChat.delete(chatId);
      byChat.set(chatId, next);
      while (byChat.size > maxChats) {
        const oldest = byChat.keys().next().value;
        if (oldest === undefined) break;
        byChat.delete(oldest);
      }
      for (const listener of [...listeners]) listener();
      return true;
    },
    forChat(chatId) {
      return (chatId && byChat.get(chatId)) || EMPTY;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Keep readings only for runs whose view is still active. A finished, stopped,
 * or interrupted run's last reading describes a context that no longer exists.
 */
export function activeSubagentContextUsage(
  runs: readonly Pick<SubagentRunView, "runId" | "state">[],
  readings: SubagentContextUsageByRunId,
): SubagentContextUsageByRunId {
  if (readings.size === 0) return EMPTY;
  const active = new Map<string, SubagentContextUsageV1>();
  for (const run of runs) {
    if (!isSubagentRunViewStateActive(run.state)) continue;
    const usage = readings.get(run.runId);
    if (usage) active.set(run.runId, usage);
  }
  return active.size === 0 ? EMPTY : active;
}

const sharedStore = createSubagentContextUsageStore();
let sharedConnection: (() => void) | undefined;

function connectSharedStore(): void {
  if (sharedConnection) return;
  try {
    sharedConnection = onNotification<unknown>("chat:subagent-context", (payload) => {
      sharedStore.apply(payload);
    });
  } catch {
    // No preload bridge (tests, static render): readings simply stay empty.
  }
}

/** Latest live context readings for the given chat's child runs. */
export function useSubagentContextUsage(
  chatId: string | null | undefined,
): SubagentContextUsageByRunId {
  const subscribe = React.useCallback((listener: () => void) => {
    connectSharedStore();
    return sharedStore.subscribe(listener);
  }, []);
  const read = React.useCallback(() => sharedStore.forChat(chatId), [chatId]);
  return React.useSyncExternalStore(subscribe, read, () => EMPTY);
}
