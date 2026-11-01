import assert from "node:assert/strict";
import { test } from "node:test";
import { hookEventsForScope, hookMatcherLabel, hookMessagesNotice } from "./hooks-settings";

test("several hook messages become one notice: the first as its title, a few more as lines, the rest counted", () => {
  assert.deepEqual(hookMessagesNotice(["Lint passed", "Tests passed", "Formatted 3 files", "Pushed", "Notified", "Archived"]), {
    title: "Lint passed",
    lines: ["Tests passed", "Formatted 3 files", "Pushed"],
    more: 2,
  });
  assert.deepEqual(hookMessagesNotice(["  Only one  "]), { title: "Only one", lines: [], more: 0 });
});

test("blank hook messages say nothing", () => {
  assert.equal(hookMessagesNotice([]), null);
  assert.equal(hookMessagesNotice(["", "   ", "\n"]), null);
  assert.deepEqual(hookMessagesNotice(["", "Saved"]), { title: "Saved", lines: [], more: 0 });
});

test("Add hook never offers a workspace hook an event that only Bots fire", () => {
  const workspace = hookEventsForScope("workspace");
  assert.ok(workspace.includes("PreToolUse") && workspace.includes("WorktreeSetup"));
  assert.ok(!workspace.includes("RoutineRun") && !workspace.includes("RoutineFailed"));
  assert.ok(hookEventsForScope("global").includes("RoutineRun"), "a global hook still follows Bot routines");
  // Settings lists the events in one stable order, starting from the tool events.
  assert.equal(workspace[0], "PreToolUse");
});

test("a hook row names its matcher where the event filters on it, and never where it is ignored", () => {
  assert.equal(hookMatcherLabel({ event: "PreToolUse", matcher: "" }), "Every tool");
  assert.equal(hookMatcherLabel({ event: "PostToolUse", matcher: "Edit|Write" }), "Edit|Write");
  assert.equal(hookMatcherLabel({ event: "SessionStart", matcher: "resume" }), "resume");
  assert.equal(hookMatcherLabel({ event: "Notification", matcher: "permission_prompt" }), "permission_prompt");
  assert.equal(hookMatcherLabel({ event: "SessionStart", matcher: "" }), undefined);
  assert.equal(hookMatcherLabel({ event: "Stop", matcher: "Bash" }), undefined);
  assert.equal(hookMatcherLabel({ event: "UserPromptSubmit", matcher: "Bash" }), undefined);
});
