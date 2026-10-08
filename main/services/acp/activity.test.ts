import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { safeToolDescriptor } from "../generation-timeline.js";
import { AcpToolCallTracker, relativeDisplayPath, timelineStepFor } from "./activity.js";
import { shouldReportToolUpdate } from "./tool-updates.js";

const root = "/work/project";

test("large concurrent and completed tool payloads stay bounded without losing final counts", () => {
  // A separate V8 heap makes retention the oracle, including private caches.
  // This reproduced >120 MiB retained before cleanup and payload bounds.
  const script = `
    import { AcpToolCallTracker } from ${JSON.stringify(new URL("./activity.ts", import.meta.url).href)};
    const tracker = new AcpToolCallTracker();
    tracker.apply({ toolCallId: "warm", title: "Edit", status: "completed", content: [{ type: "diff", path: "/a", newText: "warm" }] });
    globalThis.gc();
    const baseline = process.memoryUsage().heapUsed;
    function oversizedCompleted() {
      for (let i = 0; i < 64; i++) {
        const text = Array(2_001).fill("x".repeat(1_000)).join("") + i;
        tracker.apply({ toolCallId: "large-" + i, title: "Edit", status: "completed", rawInput: { text }, rawOutput: { text }, content: [{ type: "diff", path: "/a", newText: text }] });
      }
    }
    oversizedCompleted();
    globalThis.gc();
    const completedBytes = process.memoryUsage().heapUsed - baseline;
    function concurrent() {
      for (let i = 0; i < 32; i++) {
        const text = Array(1_900).fill("y".repeat(1_000)).join("") + i;
        tracker.merge({ toolCallId: "active-" + i, title: "Edit", status: "in_progress", rawInput: { text }, content: [{ type: "diff", path: "/a", newText: text }] });
      }
    }
    concurrent();
    globalThis.gc();
    const activeBytes = process.memoryUsage().heapUsed - baseline;
    const results = Array.from({ length: 32 }, (_, i) => tracker.apply({ toolCallId: "active-" + i, status: "completed" }));
    const repeated = tracker.apply({ toolCallId: "active-0", status: "completed" });
    globalThis.gc();
    console.log(JSON.stringify({ completedBytes, activeBytes, terminalBytes: process.memoryUsage().heapUsed - baseline, results: results.map(item => [item.status, item.lineChanges]), repeated: repeated.lineChanges }));
  `;
  const measured = JSON.parse(execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 })) as {
    completedBytes: number; activeBytes: number; terminalBytes: number;
    results: Array<[string, { additions: number; deletions: number }]>;
    repeated: { additions: number; deletions: number };
  };
  assert.ok(measured.completedBytes < 16 * 1024 * 1024, `completed payloads retained ${measured.completedBytes} bytes`);
  assert.ok(measured.activeBytes < 32 * 1024 * 1024, `active payloads retained ${measured.activeBytes} bytes`);
  assert.ok(measured.terminalBytes < 16 * 1024 * 1024, `terminal payloads retained ${measured.terminalBytes} bytes`);
  assert.equal(measured.results.length, 32);
  for (const [status, counts] of measured.results) {
    assert.equal(status, "completed");
    assert.deepEqual(counts, { additions: 1, deletions: 0 });
  }
  assert.deepEqual(measured.repeated, { additions: 1, deletions: 0 });
});

test("argument-only chunks checkpoint on the tenth update; visible changes and terminals report immediately", () => {
  const tracker = new AcpToolCallTracker();
  const first = tracker.merge({ toolCallId: "stream", title: "Edit", kind: "edit", status: "in_progress" });
  assert.equal(shouldReportToolUpdate(undefined, first, "in_progress", 0), true);
  let previous = first;
  for (let chunk = 1; chunk <= 10; chunk += 1) {
    const next = tracker.merge({ toolCallId: "stream", rawInput: { chunk }, content: [{ type: "diff", path: `${root}/a.ts`, oldText: "", newText: "x".repeat(chunk) }] });
    assert.equal(shouldReportToolUpdate(previous, next, undefined, chunk - 1), chunk === 10);
    previous = next;
  }
  const changes = [
    { title: "Writing another file" },
    { status: "pending" as const },
    { status: "in_progress" as const },
    { content: [{ type: "content" as const, content: { type: "text" as const, text: "output" } }] },
    { rawOutput: { result: "first output" } },
    { rawOutput: { result: "second output" } },
    { detail: "Progress" },
  ];
  for (const change of changes) {
    const next = tracker.merge({ toolCallId: "stream", ...change });
    assert.equal(shouldReportToolUpdate(previous, next, undefined, 0), true);
    previous = next;
    const repeat = tracker.merge({ toolCallId: "stream", ...change });
    assert.equal(shouldReportToolUpdate(previous, repeat, undefined, 0), false);
    previous = repeat;
  }
  for (const status of ["completed", "failed"] as const) {
    const next = tracker.merge({ toolCallId: "stream", status });
    assert.equal(shouldReportToolUpdate(previous, next, status, 1), true);
    // Repeated agent-reported terminal statuses must also bypass the gate.
    assert.equal(shouldReportToolUpdate(next, next, status, 1), true);
    previous = next;
  }
});

test("an unprojected diff survives completion without content and replaces cached line counts", () => {
  const tracker = new AcpToolCallTracker();
  const diff = { type: "diff" as const, path: `${root}/a.ts`, oldText: "keep\nold\n", newText: "keep\nnew\n" };
  const first = tracker.apply({ toolCallId: "stream", title: "Edit", kind: "edit", status: "in_progress", content: [diff] });
  assert.deepEqual(first.lineChanges, { additions: 1, deletions: 1 });
  const unchanged = tracker.apply({ toolCallId: "stream", content: [{ ...diff }, { type: "content", content: { type: "text", text: "working" } }] });
  assert.deepEqual(unchanged.lineChanges, { additions: 1, deletions: 1 });
  tracker.merge({ toolCallId: "stream", content: [{ ...diff, newText: "keep\nnew\nextra\n" }] });
  tracker.apply({ toolCallId: "stream", content: [{ type: "content", content: { type: "text", text: "done writing" } }] });
  const completed = tracker.apply({ toolCallId: "stream", status: "completed" });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.lineChanges, { additions: 2, deletions: 1 });
});

test("updates merge into one activity, keeping fields an update leaves out", () => {
  const tracker = new AcpToolCallTracker();
  tracker.apply({ toolCallId: "1", title: "Edit file", kind: "edit", status: "pending", locations: [{ path: `${root}/a.ts` }] });
  const updated = tracker.apply({
    toolCallId: "1",
    status: "completed",
    content: [{ type: "diff", path: `${root}/a.ts`, oldText: "a\nb\n", newText: "a\nc\nd\n" }],
  });
  assert.equal(updated.kind, "edit");
  assert.equal(updated.title, "Edit file");
  assert.equal(updated.status, "completed");
  assert.deepEqual(updated.locations, [`${root}/a.ts`]);
  assert.deepEqual(updated.lineChanges, { additions: 2, deletions: 1 });
  assert.equal(updated.created, false);
});

test("a diff without previous text is a new file", () => {
  const tracker = new AcpToolCallTracker();
  const activity = tracker.apply({
    toolCallId: "2",
    title: "Create",
    kind: "edit",
    content: [{ type: "diff", path: `${root}/new.ts`, newText: "x\n" }],
  });
  assert.equal(timelineStepFor(activity, [root])?.toolName, "write_file");
});

test("timeline steps use workspace-relative targets and never expose raw commands", () => {
  const tracker = new AcpToolCallTracker();
  const command = tracker.apply({ toolCallId: "3", title: "rm -rf / --no-preserve-root", kind: "execute" });
  const step = timelineStepFor(command, [root]);
  assert.equal(step?.toolName, "run_command");
  const descriptor = safeToolDescriptor(step!.toolName, step!.args);
  assert.equal(descriptor.label, "Run command");
  assert.equal(descriptor.detail, undefined);

  const read = tracker.apply({ toolCallId: "4", title: "Read", kind: "read", locations: [{ path: `${root}/src/a.ts` }] });
  const readStep = timelineStepFor(read, [root]);
  assert.deepEqual(safeToolDescriptor(readStep!.toolName, readStep!.args), { label: "Read file", target: "src/a.ts" });

  const outside = tracker.apply({ toolCallId: "5", title: "Read", kind: "read", locations: [{ path: "/etc/passwd" }] });
  assert.deepEqual(timelineStepFor(outside, [root])?.args, {});
});

test("thinking and mode switches produce no timeline row", () => {
  const tracker = new AcpToolCallTracker();
  assert.equal(timelineStepFor(tracker.apply({ toolCallId: "6", title: "t", kind: "think" }), [root]), undefined);
  assert.equal(timelineStepFor(tracker.apply({ toolCallId: "7", title: "m", kind: "switch_mode" }), [root]), undefined);
});

test("titles are single-line and bounded", () => {
  const tracker = new AcpToolCallTracker();
  const bell = String.fromCharCode(7);
  const activity = tracker.apply({ toolCallId: "8", title: `line one\nline two${bell}${"x".repeat(500)}` });
  assert.ok(!activity.title.includes("\n") && !activity.title.includes(bell));
  assert.ok(activity.title.length <= 240);
});

test("relative display paths stay inside the roots", () => {
  assert.equal(relativeDisplayPath(`${root}/a/b.ts`, [root]), "a/b.ts");
  assert.equal(relativeDisplayPath("/work/projectile/a.ts", [root]), undefined);
  assert.equal(relativeDisplayPath(root, [root]), undefined);
});
