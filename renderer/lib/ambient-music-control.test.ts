import assert from "node:assert/strict";
import test from "node:test";

import {
  activeAmbientMusicPrompts,
  ambientMusicPromptError,
  ambientMusicPromptSignature,
  ambientMusicRowsMatchAppliedMix,
  LatestAmbientMusicControl,
  newestAmbientMusicSnapshot,
  normalizeAmbientMusicPrompts,
  OrderedAmbientMusicPersistence,
  setAmbientMusicPromptWeight,
} from "./ambient-music-control.js";
import type { AmbientMusicFeatureSnapshot } from "../shared/ambient-music.js";

const prompts = [
  { id: "one", text: " warm pads ", weight: 0.5 },
  { id: "two", text: "soft piano", weight: 0.3 },
  { id: "three", text: "rain texture", weight: 0.2 },
];

test("prompt normalization preserves ratios without mutating the input", () => {
  const input = prompts.map((prompt) => ({ ...prompt, weight: prompt.weight * 2 }));
  const normalized = normalizeAmbientMusicPrompts(input);
  assert.deepEqual(normalized.map((prompt) => prompt.weight), [0.5, 0.3, 0.2]);
  assert.equal(input[0].weight, 1);
});

test("setting a prompt percentage redistributes the remainder proportionally", () => {
  const next = setAmbientMusicPromptWeight(prompts, "one", 0.7);
  assert.equal(next[0].weight, 0.7);
  assert.ok(Math.abs(next[1].weight - 0.18) < 1e-12);
  assert.ok(Math.abs(next[2].weight - 0.12) < 1e-12);
  assert.ok(Math.abs(next.reduce((sum, prompt) => sum + prompt.weight, 0) - 1) < 1e-12);
  assert.equal(prompts[0].weight, 0.5);
});

test("a new zero-weight style can be raised to an exact percentage", () => {
  const next = setAmbientMusicPromptWeight([
    { id: "one", text: "pads", weight: 1 },
    { id: "two", text: "piano", weight: 0 },
  ], "two", 0.25);
  assert.deepEqual(next.map((prompt) => prompt.weight), [0.75, 0.25]);
});

test("prompt signatures track text structure, not live weights", () => {
  const signature = ambientMusicPromptSignature(prompts);
  assert.equal(signature, ambientMusicPromptSignature(prompts.map((prompt) => ({ ...prompt, weight: 0 }))));
  assert.notEqual(signature, ambientMusicPromptSignature([{ ...prompts[0], text: "brass" }, ...prompts.slice(1)]));
});

function snapshot(revision: number): AmbientMusicFeatureSnapshot {
  return {
    revision,
    supported: true,
    helper: "ready",
    playback: "paused",
    promptReady: true,
    models: [],
    storage: { sharedBytes: 0, locationLabel: "Aiden application data" },
  };
}

test("renderer snapshot commits never move backward across remote events", () => {
  assert.equal(newestAmbientMusicSnapshot(snapshot(5), snapshot(4)).revision, 5);
  assert.equal(newestAmbientMusicSnapshot(snapshot(5), snapshot(5)).revision, 5);
  assert.equal(newestAmbientMusicSnapshot(snapshot(5), snapshot(6)).revision, 6);
});

test("prompt validation follows the persisted UTF-8 and control-character contract", () => {
  assert.equal(ambientMusicPromptError("  "), "Enter a music style prompt.");
  assert.equal(ambientMusicPromptError("  ", 0), undefined);
  assert.equal(ambientMusicPromptError("  ", 0.1), "Enter a music style prompt.");
  assert.equal(ambientMusicPromptError("🎵".repeat(51)), "Keep this prompt to 200 UTF-8 bytes or fewer.");
  assert.equal(ambientMusicPromptError("pads\u0000piano"), "Remove control characters from this prompt.");
  assert.equal(ambientMusicPromptError("warm pads"), undefined);
});

test("zero-weight blank draft rows are inactive and row compatibility ignores draft text", () => {
  const draft = [
    { id: "one", text: "new pad text", weight: 0.75 },
    { id: "two", text: "", weight: 0.25 },
  ];
  assert.deepEqual(activeAmbientMusicPrompts([
    { ...draft[0] },
    { ...draft[1], weight: 0 },
  ]), [draft[0]]);
  assert.equal(ambientMusicRowsMatchAppliedMix(draft, [
    { id: "one", text: "old pad text", weight: 0.5 },
    { id: "two", text: "old piano text", weight: 0.5 },
  ]), true);
  assert.equal(ambientMusicRowsMatchAppliedMix(draft.slice(0, 1), prompts.slice(0, 2)), false);
});

test("continuous controls run at most one request with one latest pending value", async () => {
  const values: number[] = [];
  let releaseFirst: (() => void) | undefined;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const control = new LatestAmbientMusicControl<number>(1, async (value) => {
    values.push(value);
    if (values.length === 1) await first;
  });
  control.push(1);
  control.push(2);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(values, [2]);
  control.push(3);
  control.push(4);
  releaseFirst?.();
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.deepEqual(values, [2, 4]);
  control.dispose();
});

test("continuous control failures are reported and do not strand the latest value", async () => {
  const values: number[] = [];
  const errors: unknown[] = [];
  const control = new LatestAmbientMusicControl<number>(1, async (value) => {
    values.push(value);
    if (value === 1) throw new Error("helper stopped");
  }, (error) => errors.push(error));
  control.push(1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  control.push(2);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(values, [1, 2]);
  assert.equal((errors[0] as Error).message, "helper stopped");
  control.dispose();
});

test("discrete settings writes cancel older debounce values and follow in-flight writes", async () => {
  const writes: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const persistence = new OrderedAmbientMusicPersistence<string, string>(5, async (value) => {
    writes.push(value);
    if (value === "volume") await first;
    return value;
  });
  persistence.schedule("stale-volume");
  assert.equal(await persistence.writeNow("model"), "model");
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.deepEqual(writes, ["model"]);

  persistence.schedule("volume");
  await new Promise((resolve) => setTimeout(resolve, 8));
  const discrete = persistence.writeNow("drumless");
  assert.deepEqual(writes, ["model", "volume"]);
  releaseFirst?.();
  assert.equal(await discrete, "drumless");
  assert.deepEqual(writes, ["model", "volume", "drumless"]);
  persistence.dispose();
});
