// Approval cards are counted through the real coordinators, filtered by the
// real analytics registry: what a card was, never what it said.

import assert from "node:assert/strict";
import test from "node:test";

import { captureAnalyticsEvents } from "../analytics/test-support.js";
import { createBotApprovals } from "../bot-runtime/bot-approvals.js";
import type { BotApprovalRequest } from "../bot-runtime/bot-extension.js";
import { ToolApprovalCoordinator, type ToolApprovalPrompt } from "../tool-approval.js";
import { ApprovalAnalytics } from "./approval-analytics.js";

function workspaceCoordinator(mode: "ask" | "full" = "ask") {
  const prompts: ToolApprovalPrompt[] = [];
  const coordinator = new ToolApprovalCoordinator(
    (prompt) => prompts.push(prompt),
    undefined,
    undefined,
    new ApprovalAnalytics({ surface: "workspace", mode: () => mode }),
  );
  return { coordinator, prompts };
}

test("a shown command card and its remembered answer are counted by kind, mode and scope only", async (t) => {
  const events = captureAnalyticsEvents(t);
  const { coordinator, prompts } = workspaceCoordinator();
  const pending = coordinator.request({
    streamId: "s1",
    toolCallId: "c1",
    toolName: "run_command",
    summary: "Run command: rm -rf ~/secret-project",
    scopes: ["once", "chat", "always"],
  });
  assert.equal(coordinator.decide(prompts[0]!.approvalId, true, undefined, { scope: "always" }), true);
  assert.equal(await pending, "allowed");
  assert.deepEqual(events, [
    { event: "approval_shown", props: { kind: "command", mode: "ask", chat: "workspace" } },
    { event: "approval_answered", props: { kind: "command", mode: "ask", chat: "workspace", scope: "workspace" } },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /secret-project|rm -rf/u);
});

test("a scope the card never offered is counted as once, and a deny as deny", async (t) => {
  const events = captureAnalyticsEvents(t);
  const { coordinator, prompts } = workspaceCoordinator();
  const allowed = coordinator.request({ streamId: "s1", toolCallId: "c1", toolName: "edit_file", summary: "Edit file: a.ts" });
  coordinator.decide(prompts[0]!.approvalId, true, undefined, { scope: "always" });
  await allowed;
  const denied = coordinator.request({ streamId: "s1", toolCallId: "c2", toolName: "write_file", summary: "Create or replace file: b.ts" });
  coordinator.decide(prompts[1]!.approvalId, false);
  await denied;
  assert.deepEqual(
    events.filter((entry) => entry.event === "approval_answered").map((entry) => entry.props),
    [
      { kind: "file", mode: "ask", chat: "workspace", scope: "once" },
      { kind: "file", mode: "ask", chat: "workspace", scope: "deny" },
    ],
  );
});

test("a card that leaves without the person's answer is shown but never answered", async (t) => {
  const events = captureAnalyticsEvents(t);
  const { coordinator } = workspaceCoordinator("full");
  const controller = new AbortController();
  const pending = coordinator.request(
    { streamId: "s1", toolCallId: "c1", toolName: "computer_use", summary: "click" },
    controller.signal,
  );
  controller.abort();
  assert.equal(await pending, "cancelled");
  assert.deepEqual(events, [{ event: "approval_shown", props: { kind: "computer_use", mode: "full", chat: "workspace" } }]);
});

test("identical parallel calls share one counted card, and a re-ask after Deny is not counted", async (t) => {
  const events = captureAnalyticsEvents(t);
  const { coordinator, prompts } = workspaceCoordinator();
  const card = { streamId: "s1", toolName: "run_command", summary: "Run command: npm test" };
  const first = coordinator.request({ ...card, toolCallId: "c1" });
  const second = coordinator.request({ ...card, toolCallId: "c2" });
  coordinator.decide(prompts[0]!.approvalId, false);
  assert.deepEqual([await first, await second], ["denied", "denied"]);
  assert.equal(await coordinator.request({ ...card, toolCallId: "c3" }), "denied");
  assert.deepEqual(events.map((entry) => entry.event), ["approval_shown", "approval_answered"]);
});

test("a subagent's card is counted as the subagent's", async (t) => {
  const events = captureAnalyticsEvents(t);
  const { coordinator, prompts } = workspaceCoordinator();
  const pending = coordinator.request({
    streamId: "s1",
    toolCallId: "c1",
    toolName: "subagent_run_grant",
    summary: "Allow writes",
    details: { kind: "subagent-run-grant" } as never,
  });
  coordinator.decide(prompts[0]!.approvalId, true);
  await pending;
  assert.deepEqual(events[0], { event: "approval_shown", props: { kind: "subagent", mode: "ask", chat: "subagent" } });
});

const botRequest = (waitId: string): BotApprovalRequest => ({
  botId: "bot-1",
  waitId,
  toolCallId: "call",
  toolName: "mail__send_email",
  summary: "Send email to a person",
  authorizationFingerprint: `fp-${waitId}`,
  signal: undefined,
  always: { key: "k", count: 3 },
});

test("a Bot's Always is counted as the Bot's allow list; an expiry is not the person's answer", async (t) => {
  const events = captureAnalyticsEvents(t);
  const bridge = createBotApprovals({ publish() {} });
  const always = bridge.request(botRequest("w1"));
  bridge.decide("w1", "allow", "always");
  assert.equal((await always).answer, "allow_always");
  const expired = bridge.request(botRequest("w2"));
  bridge.decide("w2", "deny", undefined, "expiry");
  assert.equal((await expired).answer, "deny");
  assert.deepEqual(events, [
    { event: "approval_shown", props: { kind: "tool", mode: "bot", chat: "bot" } },
    { event: "approval_answered", props: { kind: "tool", mode: "bot", chat: "bot", scope: "bot" } },
    { event: "approval_shown", props: { kind: "tool", mode: "bot", chat: "bot" } },
  ]);
});
