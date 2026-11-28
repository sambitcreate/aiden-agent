import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  removeRetiredModelScoringData,
  RETIRED_DESKTOP_MODEL_SCORING,
  RETIRED_SERVER_MODEL_SCORING,
  type RetiredModelScoringCleanupDependencies,
} from "./retired-model-scoring-cleanup-core.js";

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-retired-scoring-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** An in-memory credential store that counts writes, like the encrypted store's delete. */
function credentialStore(initial: Record<string, string>) {
  const entries = new Map(Object.entries(initial));
  let deletes = 0;
  return {
    entries,
    deletes: () => deletes,
    api: {
      has: async (id: string) => entries.has(id),
      delete: async (id: string) => {
        deletes += 1;
        entries.delete(id);
      },
    } satisfies RetiredModelScoringCleanupDependencies["credentials"],
  };
}

test("removes the retired caches and keys and keeps everything else", async () => {
  await withDirectory(async (directory) => {
    for (const name of [
      ...RETIRED_DESKTOP_MODEL_SCORING.files,
      "settings.json",
      "pi-provider-credentials.json",
    ]) {
      await writeFile(path.join(directory, name), "{}\n");
    }
    const store = credentialStore({
      "aiden-internal:model-pad-openrouter-benchmarks-v1": "pad-key",
      "artificial-analysis": "aa-key",
      openai: "sk-openai",
      "aiden-internal:image-gen:fal": "fal-key",
    });

    const result = await removeRetiredModelScoringData({
      directory,
      ...RETIRED_DESKTOP_MODEL_SCORING,
      credentials: store.api,
    });

    assert.deepEqual(result.failed, []);
    assert.deepEqual((await readdir(directory)).sort(), [
      "pi-provider-credentials.json",
      "settings.json",
    ]);
    assert.deepEqual([...store.entries.keys()].sort(), ["aiden-internal:image-gen:fal", "openai"]);
  });
});

test("nothing to remove is not a failure and writes no credential", async () => {
  await withDirectory(async (directory) => {
    const store = credentialStore({ openai: "sk-openai" });
    const result = await removeRetiredModelScoringData({
      directory,
      ...RETIRED_DESKTOP_MODEL_SCORING,
      credentials: store.api,
    });
    assert.deepEqual(result.failed, []);
    assert.equal(store.deletes(), 0);
    assert.deepEqual([...store.entries.keys()], ["openai"]);
  });
});

test("a failed deletion is reported without throwing and the other deletions still run", async () => {
  await withDirectory(async (directory) => {
    for (const name of RETIRED_DESKTOP_MODEL_SCORING.files) {
      await writeFile(path.join(directory, name), "{}\n");
    }
    const store = credentialStore({ "artificial-analysis": "aa-key" });
    const reported: string[] = [];
    const result = await removeRetiredModelScoringData({
      directory,
      ...RETIRED_DESKTOP_MODEL_SCORING,
      credentials: {
        has: async (id) =>
          id === "aiden-internal:model-pad-openrouter-benchmarks-v1" || store.api.has(id),
        delete: async (id) => {
          if (id === "aiden-internal:model-pad-openrouter-benchmarks-v1")
            throw new Error("keychain locked");
          await store.api.delete(id);
        },
      },
      removeFile: async (filePath) => {
        if (path.basename(filePath) === "model-pace.json")
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        await rm(filePath, { force: true });
      },
      onFailure: (item) => {
        reported.push(item);
        throw new Error("a broken logger");
      },
    });

    assert.deepEqual(result.failed.sort(), [
      "aiden-internal:model-pad-openrouter-benchmarks-v1",
      "model-pace.json",
    ]);
    assert.deepEqual(reported.sort(), result.failed);
    assert.deepEqual(await readdir(directory), ["model-pace.json"]);
    assert.equal(store.entries.has("artificial-analysis"), false);
  });
});

test("a second run after a full cleanup removes nothing and fails nothing", async () => {
  await withDirectory(async (directory) => {
    for (const name of RETIRED_SERVER_MODEL_SCORING.files) {
      await writeFile(path.join(directory, name), "null\n");
    }
    const store = credentialStore({ aa: "aa-key", openrouter: "or-key", telegram: "bot-token" });
    const run = () =>
      removeRetiredModelScoringData({
        directory,
        ...RETIRED_SERVER_MODEL_SCORING,
        credentials: store.api,
      });

    assert.deepEqual((await run()).failed, []);
    const deletesAfterFirstRun = store.deletes();
    assert.deepEqual((await run()).failed, []);

    assert.equal(store.deletes(), deletesAfterFirstRun);
    assert.deepEqual(await readdir(directory), []);
    assert.deepEqual([...store.entries.keys()], ["telegram"]);
  });
});
