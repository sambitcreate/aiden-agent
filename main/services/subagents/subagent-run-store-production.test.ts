import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentRunStoreStorage } from "./subagent-run-store-io.js";
import {
  createProductionSubagentRunStore,
  productionSubagentRunStoreSelection,
} from "./subagent-run-store-production.js";

interface MemoryFile {
  contents?: Buffer;
  generation: "missing" | string;
  counter: number;
}

function memoryStorageFactory(files: Map<string, MemoryFile>) {
  return (directory: string): SubagentRunStoreStorage => {
    const file = files.get(directory) ?? { generation: "missing", counter: 0 };
    files.set(directory, file);
    return {
      async cleanup() {
        return false;
      },
      async read() {
        if (!file.contents) {
          return {
            status: "missing" as const,
            contents: undefined,
            generation: "missing" as const,
          };
        }
        return {
          status: "data" as const,
          contents: Buffer.from(file.contents),
          generation: file.generation as string,
        };
      },
      async write(expected, contents) {
        if (expected !== file.generation) throw new Error("destination changed");
        file.counter += 1;
        file.generation = Array.from({ length: 9 }, () => file.counter.toString(16)).join("-");
        file.contents = Buffer.from(contents, "utf8");
        return file.generation;
      },
      async syncDirectory() {},
      async close() {},
    };
  };
}

test("production V2 switch is effective and either rollback switch selects only V1", () => {
  assert.equal(productionSubagentRunStoreSelection({}), "v2");
  assert.equal(
    productionSubagentRunStoreSelection({ AIDEN_SUBAGENTS_V2_ENABLED: " 0 " }),
    "v1",
  );
  assert.equal(
    productionSubagentRunStoreSelection({
      AIDEN_SUBAGENTS_ENABLED: "0",
      AIDEN_SUBAGENTS_V2_ENABLED: "1",
    }),
    "v1",
  );
});

test("production V1 rollback initializes no V2 evidence", async () => {
  const files = new Map<string, MemoryFile>();
  const store = createProductionSubagentRunStore({
    environment: { AIDEN_SUBAGENTS_V2_ENABLED: "0" },
    resolveUserDataDirectory: async () => "/private/aiden-user-data",
    storageFactory: memoryStorageFactory(files),
    now: () => 100,
  });

  await store.initialize();

  assert.equal(store.selection, "v1");
  assert.equal(files.has("/private/aiden-user-data/subagent-runs"), true);
  assert.equal(files.has("/private/aiden-user-data/subagent-runs-v2"), false);
});

test("production V2 startup migrates once and never falls back after canonical corruption", async () => {
  const files = new Map<string, MemoryFile>();
  const store = createProductionSubagentRunStore({
    environment: {},
    resolveUserDataDirectory: async () => "/private/aiden-user-data",
    storageFactory: memoryStorageFactory(files),
    now: () => 100,
  });

  await store.initialize();
  const v2File = files.get("/private/aiden-user-data/subagent-runs-v2");
  assert.equal(store.selection, "v2");
  assert.match(v2File?.contents?.toString("utf8") ?? "", /"status": "committed"/u);

  v2File!.contents = Buffer.from("{corrupt", "utf8");
  await assert.rejects(store.get("run-any"), /unreadable evidence/u);
});
