import {
  adaptSubagentRunSnapshotV2ToV1,
  parseSubagentRunSnapshot,
  parseSubagentRunSnapshotV2,
  type SubagentRunSnapshot,
  type SubagentRunSnapshotV1,
  type SubagentRunSnapshotV2,
} from "../../../renderer/shared/subagent-runs.js";
import type { SubagentRunStore } from "./subagent-run-store-core.js";
import type {
  MutableSubagentPrivateRunManifestV2,
  SubagentRunStoreV2,
} from "./subagent-run-store-v2-core.js";

export type SubagentRunStoreSelection = "v1" | "v2";
export type SubagentRunProjection = "native" | "v1";

export interface SubagentRunStoreDispatcherOptions {
  selection: SubagentRunStoreSelection;
  projection?: SubagentRunProjection;
  /** Required for V2: runs prepare/commit or verifies an existing committed migration. */
  prepareV2?: () => Promise<void>;
  /** Required for V2: fresh-reads V1 and advances V2's source checkpoint. */
  checkpointV1Mutation?: () => Promise<void>;
  v1: Pick<
    SubagentRunStore,
    | "initialize"
    | "upsert"
    | "get"
    | "listByChat"
    | "deleteChat"
    | "pendingChatDeletions"
    | "completeChatDeletion"
    | "flush"
    | "close"
  >;
  v2: Pick<
    SubagentRunStoreV2,
    | "reserveRun"
    | "releaseRunReservation"
    | "initialize"
    | "upsert"
    | "get"
    | "listByChat"
    | "prepareEffect"
    | "authorizeEffect"
    | "markEffectDispatchStarted"
    | "cancelEffectBeforeDispatch"
    | "finishEffect"
    | "getEffect"
    | "listEffectsByChat"
    | "listEffectActivityForRun"
    | "preflightChatDeletion"
    | "deleteChat"
    | "pendingChatDeletions"
    | "completeChatDeletion"
    | "flush"
    | "close"
  >;
}

function projectV2(
  snapshot: SubagentRunSnapshotV2,
  projection: SubagentRunProjection,
): SubagentRunSnapshot {
  if (projection === "native") return snapshot;
  const projected = adaptSubagentRunSnapshotV2ToV1(snapshot);
  if (!projected) throw new Error("Subagent V2 history could not be projected safely.");
  return projected;
}

/**
 * Explicit persistence selection. V2 never falls back to V1 after activation,
 * and rollback selection never opens or mutates V2. The only dual-store
 * mutation is privacy deletion, where the rollback-readable V1 marker is
 * installed first and cleared last.
 */
export function createSubagentRunStoreDispatcher(
  options: SubagentRunStoreDispatcherOptions,
) {
  const projection = options.projection ?? "native";
  let initialized = false;

  function requireInitialized(): void {
    if (!initialized) throw new Error("Subagent run-store dispatcher is not initialized.");
  }

  return {
    selection: options.selection,

    async reserveRun(runId: string): Promise<void> {
      requireInitialized();
      if (options.selection === "v2") await options.v2.reserveRun(runId);
    },

    releaseRunReservation(runId: string): void {
      if (options.selection === "v2") options.v2.releaseRunReservation(runId);
    },

    async initialize(): Promise<void> {
      if (initialized) return;
      if (options.selection === "v1") {
        await options.v1.initialize();
      } else {
        if (!options.prepareV2 || !options.checkpointV1Mutation) {
          throw new Error("V2 persistence requires migration preparation and V1 checkpoint coordination.");
        }
        // Do not initialize V1 here: ordinary V1 startup reconciliation is a
        // write and would invalidate the migration source checkpoint.
        await options.prepareV2();
        await options.v2.initialize();
      }
      initialized = true;
    },

    async upsert(
      value: unknown,
      manifest?: MutableSubagentPrivateRunManifestV2,
    ): Promise<SubagentRunSnapshot> {
      requireInitialized();
      if (options.selection === "v1") {
        const parsed = parseSubagentRunSnapshot(value);
        if (!parsed) throw new Error("Invalid subagent snapshot.");
        const v1 = parsed.version === 1 ? parsed : adaptSubagentRunSnapshotV2ToV1(parsed);
        if (!v1) throw new Error("Subagent V2 snapshot cannot be represented by V1 rollback storage.");
        return options.v1.upsert(v1);
      }
      const snapshot = parseSubagentRunSnapshotV2(value);
      if (!snapshot || !manifest) throw new Error("V2 persistence requires an exact snapshot and private manifest.");
      return projectV2(await options.v2.upsert(snapshot, manifest), projection);
    },

    async get(runId: string): Promise<SubagentRunSnapshot | null> {
      requireInitialized();
      if (options.selection === "v1") return options.v1.get(runId);
      const snapshot = await options.v2.get(runId);
      return snapshot ? projectV2(snapshot, projection) : null;
    },

    async listByChat(chatId: string): Promise<SubagentRunSnapshot[]> {
      requireInitialized();
      if (options.selection === "v1") return options.v1.listByChat(chatId);
      return (await options.v2.listByChat(chatId)).map((snapshot) => projectV2(snapshot, projection));
    },

    async prepareEffect(value: unknown) {
      requireInitialized();
      if (options.selection !== "v2") throw new Error("Durable subagent effects require V2 persistence.");
      return options.v2.prepareEffect(value);
    },

    async authorizeEffect(value: unknown) {
      requireInitialized();
      if (options.selection !== "v2") throw new Error("Durable subagent effects require V2 persistence.");
      return options.v2.authorizeEffect(value);
    },

    async markEffectDispatchStarted(value: unknown) {
      requireInitialized();
      if (options.selection !== "v2") throw new Error("Durable subagent effects require V2 persistence.");
      return options.v2.markEffectDispatchStarted(value);
    },

    async cancelEffectBeforeDispatch(value: unknown) {
      requireInitialized();
      if (options.selection !== "v2") throw new Error("Durable subagent effects require V2 persistence.");
      return options.v2.cancelEffectBeforeDispatch(value);
    },

    async finishEffect(value: unknown) {
      requireInitialized();
      if (options.selection !== "v2") throw new Error("Durable subagent effects require V2 persistence.");
      return options.v2.finishEffect(value);
    },

    async getEffect(value: unknown) {
      requireInitialized();
      if (options.selection !== "v2") return null;
      return options.v2.getEffect(value);
    },

    async listEffectsByChat(chatId: string) {
      requireInitialized();
      if (options.selection !== "v2") return [];
      return options.v2.listEffectsByChat(chatId);
    },

    async listEffectActivityForRun(runId: string, chatId: string) {
      requireInitialized();
      if (options.selection !== "v2") return [];
      return options.v2.listEffectActivityForRun(runId, chatId);
    },

    async deleteChat(chatId: string): Promise<void> {
      requireInitialized();
      if (options.selection === "v1") {
        await options.v1.deleteChat(chatId);
        return;
      }
      // A rollback process only understands V1, so its durable deletion marker
      // must win before the canonical V2 history is removed. Advance the
      // shared checkpoint only after both stores carry the tombstone: a crash
      // in either earlier window then blocks V2 activation instead of making
      // deleted canonical history visible again.
      await options.v2.preflightChatDeletion(chatId);
      await options.v1.deleteChat(chatId);
      await options.v2.deleteChat(chatId);
      await options.checkpointV1Mutation!();
    },

    async pendingChatDeletions(): Promise<string[]> {
      requireInitialized();
      if (options.selection === "v1") return options.v1.pendingChatDeletions();
      const [v1, v2] = await Promise.all([
        options.v1.pendingChatDeletions(),
        options.v2.pendingChatDeletions(),
      ]);
      return [...new Set([...v1, ...v2])];
    },

    async completeChatDeletion(chatId: string): Promise<void> {
      requireInitialized();
      if (options.selection === "v1") {
        await options.v1.completeChatDeletion(chatId);
        return;
      }
      // Clearing V1 last keeps rollback fail-closed if either acknowledgement
      // is interrupted after the chat itself has disappeared.
      await options.v2.completeChatDeletion(chatId);
      await options.v1.completeChatDeletion(chatId);
      // A crash between the V1 mutation and this update remains deliberately
      // fail-closed. A later schema phase can remove that availability gap by
      // persisting the cross-store transaction in deletionTransactions.
      await options.checkpointV1Mutation!();
    },

    async flush(): Promise<void> {
      requireInitialized();
      if (options.selection === "v1") await options.v1.flush();
      else await Promise.all([options.v1.flush(), options.v2.flush()]);
    },

    async close(): Promise<void> {
      if (options.selection === "v1") await options.v1.close();
      else await Promise.all([options.v1.close(), options.v2.close()]);
    },
  };
}

export type SubagentRunStoreDispatcher = ReturnType<typeof createSubagentRunStoreDispatcher>;

export type SubagentRunStoreDispatcherSnapshot =
  | SubagentRunSnapshotV1
  | SubagentRunSnapshotV2;
