import * as path from "node:path";
import { createSubagentRunStore } from "./subagent-run-store-core.js";
import {
  createSubagentRunStoreDispatcher,
  type SubagentRunStoreSelection,
} from "./subagent-run-store-dispatcher.js";
import {
  createSubagentRunStoreV2,
  type SubagentRunStoreV2,
} from "./subagent-run-store-v2-core.js";
import {
  migrateSubagentRunStoreV2,
  readSubagentRunStoreV1CheckpointV2,
} from "./subagent-run-store-v2-migration.js";
import {
  createNativeSubagentRunStoreStorage,
  type SubagentRunStoreStorage,
} from "./subagent-run-store-io.js";
import { subagentV2Enabled } from "./feature-flag.js";

const V1_DIRECTORY = "subagent-runs";
const V2_DIRECTORY = "subagent-runs-v2";

export interface ProductionSubagentRunStoreOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  resolveUserDataDirectory: () => Promise<string>;
  storageFactory?: (directory: string) => SubagentRunStoreStorage;
  now?: () => number;
}

export function productionSubagentRunStoreSelection(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SubagentRunStoreSelection {
  return subagentV2Enabled(environment) ? "v2" : "v1";
}

/**
 * One production-effective lifecycle selector. V2 migration and canonical
 * reads share the exact same directories used by startup, projector writes,
 * history reads, deletion recovery, and shutdown flushing.
 */
export function createProductionSubagentRunStore(
  options: ProductionSubagentRunStoreOptions,
) {
  const selection = productionSubagentRunStoreSelection(options.environment);
  const storageFactory =
    options.storageFactory ?? createNativeSubagentRunStoreStorage;
  let directoriesPromise:
    | Promise<{ userData: string; v1: string; v2: string }>
    | undefined;

  async function directories() {
    directoriesPromise ??= options.resolveUserDataDirectory().then((userData) => {
      if (!path.isAbsolute(userData)) {
        throw new Error("Subagent production storage requires an absolute userData directory.");
      }
      return {
        userData,
        v1: path.join(userData, V1_DIRECTORY),
        v2: path.join(userData, V2_DIRECTORY),
      };
    });
    return directoriesPromise;
  }

  const v1 = createSubagentRunStore(async () => (await directories()).v1, {
    storageFactory,
    now: options.now,
  });
  const v2: SubagentRunStoreV2 = createSubagentRunStoreV2(
    async () => (await directories()).v2,
    {
      storageFactory,
      now: options.now,
    },
  );

  async function withRawStores<T>(
    operation: (
      v1Storage: SubagentRunStoreStorage,
      v2Storage: SubagentRunStoreStorage,
    ) => Promise<T>,
  ): Promise<T> {
    const resolved = await directories();
    const v1Storage = storageFactory(resolved.v1);
    const v2Storage = storageFactory(resolved.v2);
    try {
      return await operation(v1Storage, v2Storage);
    } finally {
      await Promise.allSettled([v1Storage.close(), v2Storage.close()]);
    }
  }

  const dispatcher = createSubagentRunStoreDispatcher({
    selection,
    // V2 snapshots are already a bounded renderer-safe projection. Native
    // reads preserve explicit context/control metadata; rollback still returns
    // exact V1 because that is the selected store.
    projection: "native",
    v1,
    v2,
    ...(selection === "v2"
      ? {
          prepareV2: () =>
            withRawStores((v1Storage, v2Storage) =>
              migrateSubagentRunStoreV2(v1Storage, v2Storage, options.now),
            ).then(() => undefined),
          checkpointV1Mutation: () =>
            withRawStores(async (v1Storage) => {
              const checkpoint =
                await readSubagentRunStoreV1CheckpointV2(v1Storage);
              await v2.updateV1Checkpoint(checkpoint);
            }),
        }
      : {}),
  });

  return dispatcher;
}

export type ProductionSubagentRunStore = ReturnType<
  typeof createProductionSubagentRunStore
>;
