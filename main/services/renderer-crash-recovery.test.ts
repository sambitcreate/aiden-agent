import assert from "node:assert/strict";
import test from "node:test";

import {
  decideRendererRecovery,
  MAX_RENDERER_RECOVERIES_PER_WINDOW,
  RENDERER_CRASH_WINDOW_MS,
} from "./renderer-crash-recovery.js";

test("renderer recovery uses bounded backoff and stops a crash loop", () => {
  let crashes: number[] = [];
  for (let attempt = 1; attempt <= MAX_RENDERER_RECOVERIES_PER_WINDOW; attempt += 1) {
    const decision = decideRendererRecovery(crashes, 1_000 + attempt);
    crashes = decision.recentCrashTimes;
    assert.equal(decision.retry, true);
    assert.equal(decision.attempt, attempt);
    assert.equal(decision.backoffMs, 250 * 2 ** (attempt - 1));
  }
  const stopped = decideRendererRecovery(crashes, 1_010);
  assert.equal(stopped.retry, false);
  assert.equal(stopped.attempt, MAX_RENDERER_RECOVERIES_PER_WINDOW + 1);
  assert.equal(stopped.backoffMs, 0);
});

test("renderer recovery forgets crashes outside the bounded window", () => {
  const decision = decideRendererRecovery([1, 2, 3], RENDERER_CRASH_WINDOW_MS + 4);
  assert.deepEqual(decision.recentCrashTimes, [RENDERER_CRASH_WINDOW_MS + 4]);
  assert.equal(decision.attempt, 1);
});
