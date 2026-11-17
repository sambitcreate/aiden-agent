// Rakazo's name heuristic for connector and MCP tools (plan §3.2): send,
// create, delete, pay… are writes; get, list, search, find, read are reads;
// unknown is a write. A declared readOnly:false always counts as a write, and a
// declared read never relaxes the name.

import assert from "node:assert/strict";
import test from "node:test";

import { workspaceToolApproval } from "./workspace-tool-approval.js";
import { connectorToolEffect } from "./tool-classes.js";

const CASES: ReadonlyArray<[string, "read" | "write", { readOnlyHint?: boolean }?]> = [
  ["send_email", "write"],
  ["createIssue", "write"],
  ["delete_file", "write"],
  ["pay_invoice", "write"],
  ["calendar.update_event", "write"],
  ["get_user", "read"],
  ["list_events", "read"],
  ["search_threads", "read"],
  ["findContacts", "read"],
  ["read_document", "read"],
  ["calendar_list_events", "read"],
  // A verb-or-noun at the front acts; elsewhere it names a thing.
  ["post_message", "write"],
  ["get_order", "read"],
  ["list_labels", "read"],
  // A write verb anywhere wins over a read verb.
  ["get_and_delete_message", "write"],
  // Unknown verbs are writes.
  ["sync_contacts", "write"],
  ["notion_query", "write"],
  ["summarize", "write"],
  ["", "write"],
  // Declared hints.
  ["get_user", "write", { readOnlyHint: false }],
  ["send_message", "write", { readOnlyHint: true }],
  ["frobnicate", "write", { readOnlyHint: true }],
  ["list_files", "read", { readOnlyHint: true }],
];

test("connector tool names are classed by their verbs", () => {
  for (const [name, expected, declared] of CASES) {
    assert.equal(connectorToolEffect(name, declared), expected, `${name} ${JSON.stringify(declared ?? {})}`);
  }
});

test("in Ask, a connector write asks and a read runs; legacy (no mode) runs both as before", () => {
  const approval = { mode: "ask" as const, macGrants: new Set<never>() };
  const write = workspaceToolApproval({
    toolName: "gmail_send_email",
    args: {},
    permission: "ask",
    approval,
    connector: { remoteName: "send_email" },
  });
  assert.equal(write.decision.outcome, "ask");
  const read = workspaceToolApproval({
    toolName: "gmail_search",
    args: {},
    permission: "ask",
    approval,
    connector: { remoteName: "search_threads" },
  });
  assert.equal(read.decision.outcome, "allow");
  const declaredWrite = workspaceToolApproval({
    toolName: "gmail_get",
    args: {},
    permission: "ask",
    approval,
    connector: { remoteName: "get_thread", readOnlyHint: false },
  });
  assert.equal(declaredWrite.decision.outcome, "ask");
  // Without a mode the call is a pre-mode one: connectors never asked.
  assert.equal(workspaceToolApproval({ toolName: "gmail_send_email", args: {}, permission: "ask" }).decision.outcome, "allow");
});

test("Never ask runs connector writes; shell asks until allowed in this workspace", () => {
  const never = (grants: ReadonlySet<"shell" | "files" | "computer-use">) => ({ mode: "never" as const, macGrants: grants });
  assert.equal(
    workspaceToolApproval({ toolName: "x_send", args: {}, permission: "ask", approval: never(new Set()), connector: { remoteName: "send" } }).decision.outcome,
    "allow",
  );
  const shell = workspaceToolApproval({ toolName: "run_command", args: { command: "ls" }, permission: "ask", approval: never(new Set()), workspaceId: "w1" });
  assert.equal(shell.decision.outcome, "ask");
  assert.equal(shell.decision.outcome === "ask" && shell.decision.macGrant, "shell");
  assert.equal(
    workspaceToolApproval({ toolName: "run_command", args: { command: "ls" }, permission: "ask", approval: never(new Set(["shell"])), workspaceId: "w1" }).decision.outcome,
    "allow",
  );
  // A file grant does not cover the shell.
  assert.equal(
    workspaceToolApproval({ toolName: "run_command", args: { command: "ls" }, permission: "ask", approval: never(new Set(["files"])), workspaceId: "w1" }).decision.outcome === "allow",
    false,
  );
});
