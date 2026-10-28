import assert from "node:assert/strict";
import test from "node:test";
import type { BotTranscriptEntry } from "../../../renderer/shared/bot-live.js";
import { checkBotTurnClaims, latestBotTurn, unverifiedRoutineLine } from "./bot-claim-check.js";

const connectors = { isConnectorTool: (name: string) => name === "gmail_send_email" };

function turn(status: "ok" | "failed", reply: string, earlier: BotTranscriptEntry[] = []): BotTranscriptEntry[] {
  return [
    ...earlier,
    { id: "u2", type: "routine", label: "Inbox", text: "Email Sam the totals." },
    { id: "a1", type: "assistant", text: "", toolCalls: [{ id: "call-1", name: "gmail_send_email" }] as never, stopReason: "toolUse" },
    { id: "r1", type: "tool_result", toolCallId: "call-1", toolName: "gmail_send_email", isError: status === "failed", status },
    { id: "a2", type: "assistant", text: reply, toolCalls: [], stopReason: "stop" },
  ];
}

test("flags a \"Done\" reply when the send tool failed", () => {
  const result = checkBotTurnClaims(turn("failed", "Done. Sam has the totals."), connectors);
  assert.deepEqual(result?.toolNames, ["gmail_send_email"]);
  assert.deepEqual(result?.claimCheck.stepIds, ["r1"]);
});

test("does not flag when the matching step succeeded", () => {
  assert.equal(checkBotTurnClaims(turn("ok", "Done. Sam has the totals."), connectors), undefined);
});

test("only reads the run's own steps", () => {
  const earlierFailure: BotTranscriptEntry[] = [
    { id: "u1", type: "user", text: "Send it", imageCount: 0 },
    { id: "r0", type: "tool_result", toolCallId: "call-0", toolName: "gmail_send_email", isError: true, status: "failed" },
  ];
  assert.equal(checkBotTurnClaims(turn("ok", "Done, I sent it.", earlierFailure), connectors), undefined);
  assert.equal(latestBotTurn(turn("ok", "x", earlierFailure))[0]?.id, "a1");
});

test("the fixed line names the failed step", () => {
  assert.equal(unverifiedRoutineLine(["gmail_send_email"]), "One step didn't work: gmail_send_email. Check the chat.");
});
