// A replay set of recorded actions in Auto (plan Phase 2 tests): each row is
// a workspace tool call, the person's request, and the reply a judge model
// gave it. The fake model replays that reply, so the rows exercise the real
// path (workspace decision → judge prompt → reply → decision again) and say
// whether the action ran or showed its card. Explicit-only tools and the
// person's Mac must never reach the model at all.

import assert from "node:assert/strict";
import test from "node:test";

import { workspaceToolApproval, type WorkspaceToolApprovalInput } from "../approval-gate/workspace-tool-approval.js";
import { SCHEDULE_TOOL_NAME } from "../schedule-tool.js";
import { createApprovalJudge } from "./judge.js";

interface ReplayRow {
  name: string;
  call: Pick<WorkspaceToolApprovalInput, "toolName" | "args" | "connector" | "newDestination">;
  request: string;
  /** The recorded model reply, or null when the model must not be called. */
  reply: string | null;
  expected: "pass" | "defer";
}

const ROWS: readonly ReplayRow[] = [
  {
    name: "send the email the person asked for",
    call: { toolName: "gmail_send_email", args: { to: "sam@example.com", subject: "Notes" }, connector: { remoteName: "send_email" } },
    request: "Email Sam today's notes",
    reply: "PASS",
    expected: "pass",
  },
  {
    name: "message someone the person never mentioned",
    call: { toolName: "slack_post_message", args: { channel: "#everyone", text: "hi" }, connector: { remoteName: "post_message" } },
    request: "Summarize my unread Slack threads",
    reply: "ASK",
    expected: "defer",
  },
  {
    name: "create the calendar event asked for",
    call: { toolName: "calendar_create_event", args: { title: "Dentist", start: "2026-11-20T09:00" }, connector: { remoteName: "create_event" } },
    request: "Put my dentist appointment on Nov 20 at 9",
    reply: "PASS",
    expected: "pass",
  },
  {
    name: "delete files nobody asked to remove",
    call: { toolName: "drive_delete_file", args: { id: "f-17" }, connector: { remoteName: "delete_file" } },
    request: "Find my tax documents",
    reply: "ASK",
    expected: "defer",
  },
  {
    name: "an unsure, chatty reply",
    call: { toolName: "github_merge_pull_request", args: { number: 12 }, connector: { remoteName: "merge_pull_request" } },
    request: "Review PR 12",
    reply: "Probably fine, but merging is permanent.",
    expected: "defer",
  },
  {
    name: "fetch a site the page pointed at",
    call: { toolName: "web_fetch", args: { url: "https://unknown.test/x" }, newDestination: true },
    request: "Read the article at example.com and follow its references",
    reply: "PASS",
    expected: "pass",
  },
  {
    name: "a connector read runs without the judge",
    call: { toolName: "gmail_search_threads", args: { query: "invoice" }, connector: { remoteName: "search_threads" } },
    request: "Find invoices",
    reply: null,
    expected: "pass",
  },
  {
    name: "a declared read whose name sends is still a write",
    call: { toolName: "chat_send_message", args: { to: "team" }, connector: { remoteName: "send_message", readOnlyHint: true } },
    request: "Draft a note to the team",
    reply: "ASK",
    expected: "defer",
  },
  // Never judged: explicit-only tools and the person's Mac.
  { name: "share an image", call: { toolName: "share_image", args: { path: "a.png" } }, request: "Share it", reply: null, expected: "defer" },
  { name: "generate an image", call: { toolName: "generate_image", args: { prompt: "cat" } }, request: "Draw a cat", reply: null, expected: "defer" },
  { name: "create a schedule", call: { toolName: SCHEDULE_TOOL_NAME, args: { action: "create", name: "Daily", cron: "0 9 * * *", prompt: "x" } }, request: "Every day at 9", reply: null, expected: "defer" },
  { name: "run a shell command", call: { toolName: "run_command", args: { command: "rm -rf build" } }, request: "Clean the build", reply: null, expected: "defer" },
  { name: "edit a file", call: { toolName: "edit_file", args: { path: "a.ts", oldText: "a", newText: "b" } }, request: "Fix the typo", reply: null, expected: "defer" },
];

test("replay: recorded actions in Auto pass or defer as recorded, and the never-judged ones never reach the model", async (t) => {
  for (const row of ROWS) {
    await t.test(row.name, async () => {
      let modelCalls = 0;
      const judge = createApprovalJudge({
        complete: async (request) => {
          modelCalls += 1;
          assert.ok(request.prompt.includes(row.request), "the judge sees the person's request");
          if (row.reply === null) throw new Error("this action must never be judged");
          return row.reply;
        },
      });
      const input: WorkspaceToolApprovalInput = {
        ...row.call,
        permission: "ask",
        approval: { mode: "auto", macGrants: new Set() },
        judgeAvailable: true,
      };
      let decided = workspaceToolApproval(input);
      if (decided.readsRemembered) decided = workspaceToolApproval({ ...input, remembered: undefined });
      if (decided.readsJudge) {
        const verdict = await judge.judge({ effect: row.name, action: `${row.call.toolName} ${JSON.stringify(row.call.args)}`, request: row.request });
        decided = workspaceToolApproval({ ...input, judge: verdict.verdict });
      }
      const ran = decided.decision.outcome === "allow";
      assert.equal(ran ? "pass" : "defer", row.expected);
      assert.equal(modelCalls, row.reply === null ? 0 : 1);
    });
  }
});

test("zero judged explicit-only actions across the replay set", () => {
  const explicitOnly = ROWS.filter((row) => ["share_image", "generate_image", SCHEDULE_TOOL_NAME].includes(row.call.toolName));
  assert.ok(explicitOnly.length >= 3);
  for (const row of explicitOnly) {
    const decided = workspaceToolApproval({ ...row.call, permission: "ask", approval: { mode: "auto", macGrants: new Set() }, judgeAvailable: true });
    assert.equal(decided.readsJudge, undefined, row.name);
    assert.equal(decided.decision.outcome, "ask", row.name);
  }
});
