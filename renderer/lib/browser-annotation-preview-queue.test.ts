import assert from "node:assert/strict";
import test from "node:test";
import { BrowserAnnotationPreviewQueue, scheduleBrowserAnnotationPreview } from "./browser-annotation-preview-queue.js";

test("Cancel waits for an in-flight preview and discards its stale snapshot", async () => {
  const queue = new BrowserAnnotationPreviewQueue();
  const events: string[] = [];
  let complete!: () => void;
  const running = queue.run(async () => { events.push("preview"); await new Promise<void>((resolve) => { complete = resolve; }); return "stale image"; });
  await new Promise((resolve) => setImmediate(resolve));
  const skipped = queue.run(async () => { events.push("queued preview"); return "unused"; });
  const reset = queue.reset(async () => { events.push("restore"); });
  complete();
  assert.equal(await running, null); assert.equal(await skipped, null);
  await reset;
  assert.deepEqual(events, ["preview", "restore"]);
});

test("failed previews still restore and the next annotation starts after restoration", async () => {
  const queue = new BrowserAnnotationPreviewQueue();
  const failure = queue.run(async () => { throw new Error("page changed"); });
  await assert.rejects(failure, /page changed/);
  let restored = false;
  await queue.reset(async () => { restored = true; });
  assert.equal(await queue.run(async () => { assert.equal(restored, true); return "fresh snapshot"; }), "fresh snapshot");
});

test("reverting before debounce fires still settles pending with the complete baseline state", async () => {
  const scheduled = new Map<number, () => void>();
  let sequence = 0, pending = true;
  const timer = { schedule: (callback: () => void) => { scheduled.set(++sequence, callback); return sequence; }, cancel: (token: unknown) => { scheduled.delete(token as number); } };
  const applied: string[] = [];
  const cancel = scheduleBrowserAnnotationPreview(async () => { applied.push("temporary"); return "temporary"; }, () => { assert.fail("canceled debounce settled"); }, timer);
  cancel();
  scheduleBrowserAnnotationPreview(async () => { applied.push("baseline"); return "baseline"; }, () => { pending = false; }, timer);
  for (const callback of scheduled.values()) callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, ["baseline"]); assert.equal(pending, false);
});

test("reverting an in-flight preview restores CSS even when the requested baseline was completed before", async () => {
  const queue = new BrowserAnnotationPreviewQueue();
  let css = "baseline", complete!: () => void;
  const pending = queue.run(async () => { css = "temporary"; await new Promise<void>((resolve) => { complete = resolve; }); return "temporary"; });
  await new Promise((resolve) => setImmediate(resolve));
  const baseline = queue.run(async () => { css = "baseline"; return "baseline"; });
  complete(); await pending;
  assert.equal(await baseline, "baseline"); assert.equal(css, "baseline");
});
