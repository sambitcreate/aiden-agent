import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { diagnosticSnapshot } from "./performance-diagnostics.js";
import { trackDiagnosticChild } from "./performance-child.js";

test("owned child diagnostics retain launch, live, duration, and one terminal reason", () => {
  const child = new EventEmitter() as ChildProcess;
  trackDiagnosticChild("git", child);
  let snapshot = diagnosticSnapshot();
  assert.equal(snapshot.counters["child:git"]?.count, 1);
  assert.deepEqual(snapshot.gauges["live:child-git"], { current: 1, peak: 1 });

  child.emit("error", new Error("operation error before close"));
  snapshot = diagnosticSnapshot();
  assert.equal(snapshot.gauges["live:child-git"]?.current, 1);
  assert.equal(snapshot.counters["child-error:git"]?.errors, 1);
  child.emit("close", 0, null);
  snapshot = diagnosticSnapshot();
  assert.equal(snapshot.counters["child-exit:git:error"]?.count, 1);
  assert.equal(snapshot.counters["child-exit:git:clean"], undefined);
  assert.ok((snapshot.counters["child-exit:git:error"]?.durationMs ?? -1) >= 0);
  assert.deepEqual(snapshot.gauges["live:child-git"], { current: 0, peak: 1 });
  assert.deepEqual(snapshot.gauges["live:child"], { current: 0, peak: 1 });
});
