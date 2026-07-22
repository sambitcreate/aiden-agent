import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { FileArtificialAnalysisCacheStore } from "./artificial-analysis-cache.js";
import { buildArtificialAnalysisUserCache } from "./artificial-analysis-runtime-core.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(
  onInvalid?: (error: Error) => void,
  durability?: {
    onWarning(error: Error): void;
    syncDirectory(directory: string): Promise<void>;
  },
  maxBytes?: number,
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-aa-cache-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "nested", "cache.json");
  return {
    file,
    store: new FileArtificialAnalysisCacheStore({
      filePath: () => file,
      maxBytes,
      onInvalid,
      onDurabilityWarning: durability?.onWarning,
      syncDirectory: durability?.syncDirectory,
    }),
  };
}

function cache() {
  return buildArtificialAnalysisUserCache(
    [
      {
        tier: "free",
        intelligence_index_version: 4.1,
        pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false },
        data: [
          {
            id: "model-a",
            slug: "model-a",
            name: "Model A",
            release_date: "2026-07-01",
            model_creator: { id: "creator-a", name: "Example" },
            evaluations: {
              artificial_analysis_intelligence_index: 50,
              artificial_analysis_coding_index: 48,
              artificial_analysis_agentic_index: 45,
            },
            performance: {
              median_output_tokens_per_second: 100,
              median_time_to_first_token_seconds: 0.5,
              median_end_to_end_response_time_seconds: 5,
            },
          },
        ],
      },
    ],
    "2026-07-22T18:00:00.000Z",
  );
}

test("writes and reads a validated cache atomically with private file permissions", async () => {
  const { file, store } = await fixture();
  const expected = cache();
  assert.equal(await store.read(), null);
  await store.write(expected);
  assert.deepEqual(await store.read(), expected);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const raw = await fs.readFile(file, "utf8");
  assert.match(raw, /Artificial Analysis/u);
  assert.doesNotMatch(raw, /x-api-key|credential|secret/u);
});

test("a post-commit directory sync failure warns without rejecting or rolling back the cache", async () => {
  const warnings: Error[] = [];
  const { store } = await fixture(undefined, {
    syncDirectory: async () => {
      throw new Error("directory sync unsupported");
    },
    onWarning: (error) => warnings.push(error),
  });
  const expected = cache();
  await store.write(expected);
  assert.deepEqual(await store.read(), expected);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /unsupported/u);
});

test("a throwing durability reporter cannot turn a committed cache write into a failure", async () => {
  const { store } = await fixture(undefined, {
    syncDirectory: async () => {
      throw new Error("directory sync unsupported");
    },
    onWarning: () => {
      throw new Error("diagnostic failure");
    },
  });
  const expected = cache();
  await store.write(expected);
  assert.deepEqual(await store.read(), expected);
});

test("ignores a malformed local cache without deleting it and reports the validation failure", async () => {
  const invalid: Error[] = [];
  const { file, store } = await fixture((error) => invalid.push(error));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "not json", "utf8");
  assert.equal(await store.read(), null);
  assert.equal(invalid.length, 1);
  assert.equal(await fs.readFile(file, "utf8"), "not json");
});

test("rejects an oversized local cache before buffering the whole file", async () => {
  const invalid: Error[] = [];
  const { file, store } = await fixture((error) => invalid.push(error), undefined, 64);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "x".repeat(65), "utf8");
  assert.equal(await store.read(), null);
  assert.equal(invalid.length, 1);
  assert.match(invalid[0].message, /size limit/u);
});

test("rejects an oversized serialized cache before replacing the destination", async () => {
  const { file, store } = await fixture(undefined, undefined, 128);
  await assert.rejects(store.write(cache()), /size limit/u);
  await assert.rejects(fs.stat(file), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  });
});

test("deletes the local cache without failing when it is already absent", async () => {
  const { file, store } = await fixture();
  await store.delete();
  await store.write(cache());
  await store.delete();
  await assert.rejects(fs.stat(file), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  });
  await store.delete();
});
