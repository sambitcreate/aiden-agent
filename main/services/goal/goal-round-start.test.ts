// A goal round is an attended turn Aiden starts: built from the last run,
// with the chat's own approval mode, and refusing what a round may not do.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_BACK_TOOL_NAME } from "../../../renderer/shared/check-backs.js";
import { chatTurnArgsToolRefusal, chatTurnAudienceFor } from "../chat-turn-tool-policy.js";
import { goalRoundStartRequest } from "./goal-round-start.js";

const context = {
  workspaceId: "ws-1",
  providerId: "anthropic",
  model: "claude-sonnet",
  thinkingLevel: "high" as const,
  excludeToolNames: new Set(["browser"]),
};

test("a round carries the last run's provider, model, folder, thinking and withheld tools, and no access of its own", () => {
  const { params, options } = goalRoundStartRequest("chat-1", context, "stream-1");
  assert.equal(params.chatId, "chat-1");
  assert.equal(params.workspaceId, "ws-1");
  assert.equal(params.providerId, "anthropic");
  assert.equal(params.model, "claude-sonnet");
  assert.equal(params.thinkingLevel, "high");
  assert.deepEqual(params.messages, []);
  assert.equal("permission" in params, false, "the chat's approval mode applies, as for the person's turns");
  assert.equal(options.turnId, "stream-1");
  assert.deepEqual([...(options.excludeToolNames ?? [])], ["browser"]);
  assert.notEqual(options.excludeToolNames, context.excludeToolNames, "the round's set is its own copy");
  assert.equal(options.unattended, undefined, "a round is attended");
});

test("a round refuses to set a check-back, while the person's own turn may", () => {
  const { params, options } = goalRoundStartRequest("chat-1", context, "stream-1");
  const round = chatTurnArgsToolRefusal(chatTurnAudienceFor(options, params));
  assert.match(round(CHECK_BACK_TOOL_NAME, { action: "set" }) ?? "", /cannot set a check-back/);
  assert.equal(round(CHECK_BACK_TOOL_NAME, { action: "list" }), undefined);

  const personTurn = chatTurnArgsToolRefusal(chatTurnAudienceFor({}, params));
  assert.equal(personTurn(CHECK_BACK_TOOL_NAME, { action: "set" }), undefined);
});
