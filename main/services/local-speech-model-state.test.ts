import assert from "node:assert/strict";
import test from "node:test";
import { runWithCrashRetry, WorkerCrashError } from "./local-speech-process-core.js";
import type { LocalSpeechState } from "../../renderer/shared/local-speech-state.js";
import { LocalSpeechModelState } from "./local-speech-model-state.js";

function recorder() {
  const events: LocalSpeechState[] = [];
  const model = new LocalSpeechModelState((state) => events.push(state));
  const seen = () => events.map((event) => `${event.modelId}:${event.state}`);
  return { model, events, seen };
}

test("a cold load reports loading then ready, and a warm request reports nothing", () => {
  const { model, seen } = recorder();
  const cold = model.request("parakeet");
  cold.announceLoad();
  cold.succeed();
  const warm = model.request("parakeet");
  warm.announceLoad();
  warm.succeed();
  assert.deepEqual(seen(), ["parakeet:loading", "parakeet:ready"]);
  assert.equal(model.loaded, "parakeet");
});

test("a user cancel during a load never reports a failure", () => {
  const { model, events, seen } = recorder();
  const request = model.request("parakeet");
  request.announceLoad();
  model.markUnloaded(); // the cancel kills the worker mid-load
  request.fail(new Error("On-device transcription process closed."), { aborted: true });
  assert.deepEqual(seen(), ["parakeet:loading", "parakeet:unloaded"]);
  assert.equal(events.some((event) => event.state === "failed" || event.error), false);
});

test("a real load failure is reported with its message", () => {
  const { model, events } = recorder();
  const request = model.request("parakeet");
  request.announceLoad();
  request.fail(new Error("bad model"), { aborted: false });
  assert.deepEqual(events[events.length - 1], { modelId: "parakeet", state: "failed", error: "bad model" });
  assert.equal(model.loaded, null);
});

test("a crash on an already-loaded model reports unloaded, then a fresh load for the retry", async () => {
  const { model, seen } = recorder();
  const warm = model.request("parakeet");
  warm.announceLoad();
  warm.succeed();

  const request = model.request("parakeet");
  let attempts = 0;
  await runWithCrashRetry(
    async () => {
      request.announceLoad();
      attempts += 1;
      if (attempts === 1) throw new WorkerCrashError("exited");
      return "ok";
    },
    {
      isCancelled: () => false,
      isCrash: (error) => error instanceof WorkerCrashError,
      onCrash: () => model.markUnloaded(),
    },
  );
  request.succeed();
  assert.deepEqual(seen(), [
    "parakeet:loading",
    "parakeet:ready",
    "parakeet:unloaded",
    "parakeet:loading",
    "parakeet:ready",
  ]);
});

test("a crash during the first load does not repeat the loading notice", () => {
  const { model, seen } = recorder();
  const request = model.request("parakeet");
  request.announceLoad();
  model.markUnloaded(); // nothing was loaded yet
  request.announceLoad();
  request.succeed();
  assert.deepEqual(seen(), ["parakeet:loading", "parakeet:ready"]);
});

test("unloading with nothing loaded stays silent", () => {
  const { model, seen } = recorder();
  model.markUnloaded();
  assert.deepEqual(seen(), []);
});
