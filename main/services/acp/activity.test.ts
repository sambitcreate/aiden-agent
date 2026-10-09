import assert from "node:assert/strict";
import test from "node:test";

import { safeToolDescriptor } from "../generation-timeline.js";
import { AcpToolCallTracker, relativeDisplayPath, timelineStepFor } from "./activity.js";

const root = "/work/project";

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
  // The row reads "Ran a command"; the command line itself is never persisted.
  assert.equal(descriptor.detail, "a command");
  assert.doesNotMatch(JSON.stringify(step), /rm -rf/u);

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
