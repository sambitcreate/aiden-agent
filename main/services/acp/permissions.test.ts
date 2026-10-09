import assert from "node:assert/strict";
import test from "node:test";
import type { RequestPermissionRequest, ToolKind } from "@agentclientprotocol/sdk";

import { answerPermission } from "./permissions.js";
import { RecordingHost } from "./test-support.js";

function request(kind: ToolKind, options = ["allow_once", "allow_always", "reject_once"] as const): RequestPermissionRequest {
  return {
    sessionId: "s",
    toolCall: { toolCallId: "t1", title: "Do it", kind, locations: [{ path: "/w/file.ts" }] },
    options: options.map((option) => ({ optionId: option, name: option, kind: option })),
  };
}

const signal = new AbortController().signal;

async function decide(kind: ToolKind, permission: RecordingHost["currentPermission"], answer = "allow_once" as RecordingHost["approvalAnswer"]) {
  const host = new RecordingHost("c", "/w");
  host.currentPermission = permission;
  host.approvalAnswer = answer;
  const response = await answerPermission(request(kind), { kind: "approval" }, host, signal);
  return { host, chosen: response.outcome.outcome === "selected" ? response.outcome.optionId : "cancelled" };
}

test("local read-like operations are allowed in every mode without asking", async () => {
  for (const permission of ["ask", "read-only", "none"] as const) {
    for (const kind of ["read", "search", "think"] as const) {
      const { host, chosen } = await decide(kind, permission);
      assert.equal(chosen, "allow_once", `${kind} in ${permission}`);
      assert.equal(host.approvals.length, 0);
    }
  }
});

test("Full allows mutations and fetches; read-only and no-access refuse them without asking", async () => {
  for (const kind of ["edit", "execute", "delete", "move", "fetch", "other"] as const) {
    assert.equal((await decide(kind, "full")).chosen, "allow_once");
    for (const permission of ["read-only", "none"] as const) {
      const { host, chosen } = await decide(kind, permission);
      assert.equal(chosen, "reject_once", `${kind} in ${permission}`);
      assert.equal(host.approvals.length, 0);
    }
  }
});

test("Ask shows Aiden's approval and maps each answer to the agent's own option", async () => {
  const allowOnce = await decide("execute", "ask", "allow_once");
  assert.equal(allowOnce.chosen, "allow_once");
  assert.equal(allowOnce.host.approvals[0]?.kind, "command");
  assert.deepEqual(allowOnce.host.approvals[0]?.paths, ["file.ts"]);
  assert.equal((await decide("edit", "ask", "allow_always")).chosen, "allow_always");
  assert.equal((await decide("edit", "ask", "reject")).chosen, "reject_once");
  // Network fetches can exfiltrate data, so Ask asks for them too.
  const fetchAsk = await decide("fetch", "ask", "allow_once");
  assert.equal(fetchAsk.host.approvals[0]?.kind, "fetch");
  // Deletes and moves are file changes the card can name precisely; edits carry no marker.
  assert.equal((await decide("delete", "ask")).host.approvals[0]?.fileChange, "delete");
  assert.equal((await decide("move", "ask")).host.approvals[0]?.fileChange, "move");
  assert.equal((await decide("edit", "ask")).host.approvals[0]?.fileChange, undefined);
  // A dismissed card (not a Stop) is a refusal, never an implicit allow.
  assert.equal((await decide("edit", "ask", "cancelled")).chosen, "reject_once");
});

test("an approval that throws is a refusal", async () => {
  const host = new RecordingHost("c", "/w");
  host.requestApproval = async () => {
    throw new Error("card failed");
  };
  const response = await answerPermission(request("edit"), { kind: "approval" }, host, signal);
  assert.deepEqual(response.outcome, { outcome: "selected", optionId: "reject_once" });
});

test("a stopped turn cancels instead of answering", async () => {
  const controller = new AbortController();
  controller.abort();
  const response = await answerPermission(request("edit"), { kind: "approval" }, new RecordingHost("c", "/w"), controller.signal);
  assert.deepEqual(response.outcome, { outcome: "cancelled" });
});

test("questions return the chosen option, or cancel when unanswered", async () => {
  const host = new RecordingHost("c", "/w");
  const question = { kind: "question" as const, question: { title: "Pick", options: [{ id: "allow_once", label: "A" }] } };
  host.questionAnswer = "allow_once";
  assert.deepEqual((await answerPermission(request("other"), question, host, signal)).outcome, {
    outcome: "selected",
    optionId: "allow_once",
  });
  host.questionAnswer = "not-an-option";
  assert.deepEqual((await answerPermission(request("other"), question, host, signal)).outcome, { outcome: "cancelled" });
});
