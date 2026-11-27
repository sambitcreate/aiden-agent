import assert from "node:assert/strict";
import test from "node:test";
import { AdvisorAttemptStore } from "./advisor-attempt-store.js";
import { temporaryDirectory } from "../shared/temp-dir-test-support.js";

test("advisor attempt journal reconciles prepared and dispatched calls without replay", async (t) => {
  const directory = await temporaryDirectory(t, "aiden-advisor-attempt-");
  let now = 100;
  const first = new AdvisorAttemptStore({ root: () => directory, now: () => now });
  await first.initialize();
  await first.prepare("prepared", "provider", "model");
  await first.prepare("dispatched", "provider", "model");
  await first.markDispatchStarted("dispatched");

  now = 200;
  const restarted = new AdvisorAttemptStore({ root: () => directory, now: () => now });
  await restarted.initialize();
  const attempts = await restarted.list();
  assert.equal(attempts.find(({ attemptId }) => attemptId === "prepared")?.state, "cancelled");
  assert.equal(attempts.find(({ attemptId }) => attemptId === "dispatched")?.state, "unknown");
  assert.equal(
    attempts.every(({ usageRecorded }) => usageRecorded === false),
    true,
  );
});

test("advisor attempt journal enforces ordered settlement and usage evidence", async (t) => {
  const directory = await temporaryDirectory(t, "aiden-advisor-attempt-");
  const store = new AdvisorAttemptStore({ root: () => directory, now: () => 100 });
  await store.initialize();
  await store.prepare("attempt", "provider", "model");
  await assert.rejects(store.settle("attempt", "completed", "none"), /dispatch evidence/u);
  await store.markDispatchStarted("attempt");
  await store.settle("attempt", "completed", "none");
  await store.markUsageRecorded("attempt");
  assert.equal((await store.list())[0]?.usageRecorded, true);
});
