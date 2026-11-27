import assert from "node:assert/strict";
import test from "node:test";
import { settleWithin } from "./async-timeout.js";

test("settleWithin resolves promptly when the promise fulfills", async () => {
  const start = Date.now();
  await settleWithin(Promise.resolve("ok"), 5_000);
  assert.ok(Date.now() - start < 1_000);
});

test("settleWithin swallows rejections without throwing", async () => {
  await assert.doesNotReject(() => settleWithin(Promise.reject(new Error("boom")), 5_000));
});

test("settleWithin returns when the timeout elapses before settlement", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  // `settleWithin` unrefs its timer; keep the event loop alive until the test finishes.
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    const start = Date.now();
    await settleWithin(pending, 20);
    assert.ok(Date.now() - start >= 10);
  } finally {
    clearTimeout(keepAlive);
    release();
  }
});
