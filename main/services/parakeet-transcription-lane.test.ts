import assert from "node:assert/strict";
import test from "node:test";
import { ParakeetTranscriptionLane } from "./parakeet-transcription-lane.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("cancelling queued Parakeet work leaves the active request running", async () => {
  const lane = new ParakeetTranscriptionLane();
  const firstResult = deferred<string>();
  const started: string[] = [];
  let activeCancellationCount = 0;

  const first = lane.run(async () => {
    started.push("first");
    return firstResult.promise;
  });
  const queuedController = new AbortController();
  const queued = lane.run(
    async () => {
      started.push("queued");
      return "queued";
    },
    {
      signal: queuedController.signal,
      onCancelActive: () => {
        activeCancellationCount += 1;
      },
    },
  );
  const afterQueued = lane.run(async () => {
    started.push("after-queued");
    return "after-queued";
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first"]);
  queuedController.abort();
  await assert.rejects(queued, { name: "AbortError" });
  assert.equal(activeCancellationCount, 0);
  assert.deepEqual(started, ["first"]);

  firstResult.resolve("first");
  assert.equal(await first, "first");
  assert.equal(await afterQueued, "after-queued");
  assert.deepEqual(started, ["first", "after-queued"]);
});

test("cancelling active Parakeet work restarts the lane for queued requests", async () => {
  const lane = new ParakeetTranscriptionLane();
  const activeResult = deferred<string>();
  const activeController = new AbortController();
  const started: string[] = [];
  let activeCancellationCount = 0;

  const active = lane.run(
    async () => {
      started.push("active");
      return activeResult.promise;
    },
    {
      signal: activeController.signal,
      onCancelActive: () => {
        activeCancellationCount += 1;
        activeResult.reject(new Error("worker exited"));
      },
    },
  );
  const next = lane.run(async () => {
    started.push("next");
    return "restarted";
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["active"]);
  activeController.abort();
  activeController.abort();
  await assert.rejects(active, { name: "AbortError" });
  assert.equal(activeCancellationCount, 1);
  assert.equal(await next, "restarted");
  assert.deepEqual(started, ["active", "next"]);
});
