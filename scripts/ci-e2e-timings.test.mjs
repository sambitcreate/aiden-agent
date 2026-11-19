import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractSpecSeconds,
  mergeTimings,
  mergeTimingArtifacts,
  parseTimingsStore,
  specWeight,
  timingWeights,
} from "./ci-e2e-timings.mjs";
import { FILE_SECONDS, planShards } from "./ci-e2e-shards.mjs";

test("Playwright JSON reports become per-spec seconds and ignore skipped results", () => {
  const seconds = extractSpecSeconds({
    suites: [{
      file: "/checkout/tests/e2e/settings-unification.spec.ts",
      specs: [{
        file: "tests/e2e/settings-unification.spec.ts",
        tests: [
          { results: [{ status: "passed", duration: 4000 }, { status: "skipped", duration: 0 }] },
          { results: [{ status: "passed", duration: 2500 }] },
        ],
      }],
      suites: [{
        file: "tests/e2e/chat-fork.spec.ts",
        specs: [{ tests: [{ results: [{ status: "failed", duration: 1100 }] }] }],
      }],
    }],
  });
  assert.equal(seconds["settings-unification.spec.ts"], 7);
  assert.equal(seconds["chat-fork.spec.ts"], 1);
});

test("nested spec paths stay nested when Playwright omits the tests/e2e prefix", () => {
  const seconds = extractSpecSeconds({
    suites: [{
      file: "nested/future-flow.spec.ts",
      specs: [{ tests: [{ results: [{ status: "passed", duration: 1500 }] }] }],
    }],
  });
  assert.equal(seconds["nested/future-flow.spec.ts"], 2);
});

test("malformed or missing timing stores never fail planning", () => {
  assert.deepEqual(timingWeights(parseTimingsStore(null), "darwin"), {});
  assert.deepEqual(timingWeights(parseTimingsStore({ version: 2 }), "linux"), {});
  assert.equal(specWeight("missing.spec.ts", {}, FILE_SECONDS, 30), 30);
  assert.equal(specWeight("chat-fork.spec.ts", {}, FILE_SECONDS, 30), FILE_SECONDS["chat-fork.spec.ts"]);
});

test("recorded durations fill shards more evenly and still include a new spec", () => {
  const recorded = Object.fromEntries([
    ...["a", "b", "c", "d"].map((name) => [`${name}.spec.ts`, 100]),
    ...["e", "f", "g", "h", "i", "j", "k", "l"].map((name) => [`${name}.spec.ts`, 25]),
  ]);
  const specs = [...Object.keys(recorded), "brand-new.spec.ts"];
  const shards = planShards(specs, 4, { recorded, fallback: {}, defaultSeconds: 25 });
  const files = shards.flatMap((shard) => shard.files);
  assert.equal(files.length, new Set(files).size);
  assert.deepEqual(files.toSorted(), specs.toSorted());
  assert.ok(files.includes("brand-new.spec.ts"));
  const loads = shards.map((shard) => shard.seconds);
  const mean = loads.reduce((sum, value) => sum + value, 0) / loads.length;
  assert.ok(Math.max(...loads) <= mean * 1.15, `loads ${loads} mean ${mean}`);
});

test("merge keeps a median of recent samples per platform", () => {
  const first = mergeTimings(null, { "chat-fork.spec.ts": 10, "chat-top-bar.spec.ts": 20 }, { platform: "darwin", recordedAt: "2026-01-01T00:00:00.000Z" });
  const second = mergeTimings(first, { "chat-fork.spec.ts": 30 }, { platform: "darwin", recordedAt: "2026-01-02T00:00:00.000Z" });
  const linux = mergeTimings(second, { "chat-fork.spec.ts": 8 }, { platform: "linux", recordedAt: "2026-01-02T00:00:00.000Z" });
  assert.equal(timingWeights(linux, "darwin")["chat-fork.spec.ts"], 20);
  assert.equal(timingWeights(linux, "linux")["chat-fork.spec.ts"], 8);
  assert.equal(timingWeights(linux, "darwin")["chat-top-bar.spec.ts"], 20);
});

test("shard timing artifacts merge from a directory without throwing on junk", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "e2e-timings-"));
  try {
    const macos = path.join(directory, "e2e-spec-timings-macOS-1");
    const linux = path.join(directory, "e2e-spec-timings-Linux-1");
    mkdirSync(macos, { recursive: true });
    mkdirSync(linux, { recursive: true });
    writeFileSync(path.join(macos, "e2e-shard-timings.json"), JSON.stringify({ "chat-fork.spec.ts": 12 }));
    writeFileSync(path.join(linux, "e2e-shard-timings.json"), JSON.stringify({ "chat-fork.spec.ts": 9 }));
    writeFileSync(path.join(directory, "notes.txt"), "ignore");
    const storePath = path.join(directory, "store.json");
    const out = path.join(directory, "out.json");
    const merged = mergeTimingArtifacts(storePath, directory, out);
    assert.equal(timingWeights(merged, "darwin")["chat-fork.spec.ts"], 12);
    assert.equal(timingWeights(merged, "linux")["chat-fork.spec.ts"], 9);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
