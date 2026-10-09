// The Bot memory service (spec 2026-10-09 §6–§8): one place that reads,
// writes and announces a Bot's memory.
//
// - `view` / `edit`: the person's Profile → Memory (desktop IPC and Remote).
//   A person's edit marks the prompt snapshot stale, so "forget that" takes
//   effect on the next request.
// - `apply`: the Bot's own `bot_memory` batches (and the add-only review and
//   compaction flush). They never mark the snapshot stale: that is the
//   frozen-snapshot rule, and the tool result already shows the live state.
// - `snapshot`: the memory the prompt shows, cached per Bot and re-read only
//   when stale (`beginSession` on every harness open, `markStale` after
//   compaction or a person edit).
// - `onChanged`: every successful write, whoever made it.

import type {
  BotMemoryChangedEvent,
  BotMemoryEditInput,
  BotMemoryEditResult,
  BotMemoryTarget,
  BotMemoryView,
} from "../../../renderer/shared/bot-memory.js";
import {
  memoryView,
  type BotMemoryApplyOptions,
  type BotMemoryApplyResult,
  type BotMemoryOperation,
  type BotMemoryStore,
  type LoadedBotMemory,
} from "./store.js";

/** What Remote and IPC use (plan Step 0 contract). */
export interface BotMemoryService {
  view(botId: string): Promise<BotMemoryView>;
  edit(input: BotMemoryEditInput): Promise<BotMemoryEditResult>;
  onChanged(listener: (event: BotMemoryChangedEvent) => void): () => void;
}

export interface BotMemoryRuntime extends BotMemoryService {
  /** The Bot's own batch. */
  apply(
    botId: string,
    target: BotMemoryTarget,
    operations: readonly BotMemoryOperation[],
    options?: BotMemoryApplyOptions,
  ): Promise<BotMemoryApplyResult>;
  /** What the prompt shows: frozen until the next session open, compaction or person edit. */
  snapshot(botId: string): Promise<LoadedBotMemory>;
  /** A harness opened for this Bot: the next prompt re-reads memory. */
  beginSession(botId: string): void;
  markStale(botId: string): void;
  /** The Bot is being deleted: drop its cache and refuse later writes. */
  forgetBot(botId: string): void;
}

export interface BotMemoryServiceDeps {
  store: BotMemoryStore;
  onReport?(botId: string, error: unknown): void;
}

export function createBotMemoryService(deps: BotMemoryServiceDeps): BotMemoryRuntime {
  const listeners = new Set<(event: BotMemoryChangedEvent) => void>();
  const snapshots = new Map<string, LoadedBotMemory>();
  const stale = new Set<string>();

  function announce(loaded: LoadedBotMemory): void {
    const event: BotMemoryChangedEvent = { botId: loaded.botId, revision: loaded.revision };
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        deps.onReport?.(loaded.botId, error);
      }
    }
  }

  function markStale(botId: string): void {
    stale.add(botId);
  }

  return {
    async view(botId) {
      return memoryView(await deps.store.load(botId));
    },

    async edit(input) {
      const outcome = await deps.store.edit(input.botId, input.edit);
      if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message, view: memoryView(outcome.loaded) };
      if (outcome.changed) {
        markStale(input.botId);
        announce(outcome.loaded);
      }
      return { ok: true, view: memoryView(outcome.loaded) };
    },

    async apply(botId, target, operations, options) {
      const result = await deps.store.apply(botId, target, operations, options);
      if (result.ok && result.changed > 0) announce(result.loaded);
      return result;
    },

    async snapshot(botId) {
      const cached = snapshots.get(botId);
      if (cached !== undefined && !stale.has(botId)) return cached;
      stale.delete(botId);
      const loaded = await deps.store.load(botId);
      snapshots.set(botId, loaded);
      return loaded;
    },

    beginSession: markStale,
    markStale,

    forgetBot(botId) {
      deps.store.forgetBot(botId);
      snapshots.delete(botId);
      stale.delete(botId);
    },

    onChanged(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
