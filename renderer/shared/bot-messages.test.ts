import assert from "node:assert/strict";
import { test } from "node:test";
import {
  botMessageRequestId,
  botReplyRequestId,
  botMessageTurnOf,
  botMessageChainOf,
  botMessagingEnabled,
  botMessageStatusLine,
} from "./bot-messages.js";
const d = "00112233-4455-4677-8899-aabbccddeeff";
test("request ids round-trip colon Bot ids and malformed ids fail closed", () => {
  assert.deepEqual(botMessageTurnOf(botMessageRequestId("bot:1", 2, d)), {
    kind: "message",
    fromBotId: "bot:1",
    hop: 2,
    deliveryId: d,
  });
  for (const id of [`bot:x:3:${d}`, "bot:x:1:not-a-uuid", "botreply:", "routine:t:1", "tg:a:b:c:d", "intro:x"])
    assert.deepEqual(botMessageTurnOf(id), { kind: "unattended" });
  for (const id of [undefined, "abc", "remote:d:k"]) assert.deepEqual(botMessageTurnOf(id), { kind: "person" });
});
test("chains use the strictest input and refuse ambiguous parents", () => {
  assert.deepEqual(botMessageChainOf([undefined]), { canSend: true, hop: 1, chain: [] });
  assert.deepEqual(botMessageChainOf([undefined, botMessageRequestId("J", 1, d)]), {
    canSend: true,
    hop: 2,
    parentDeliveryId: d,
    chain: ["J"],
  });
  for (const ids of [[botMessageRequestId("J", 2, d)], [undefined, botReplyRequestId(d)], ["intro:x"], ["routine:t:1"]])
    assert.equal(botMessageChainOf(ids).canSend, false);
});
test("switches default on and status copy is stable", () => {
  for (const settings of [undefined, {}, { botMessaging: "no" }]) assert.equal(botMessagingEnabled(settings), true);
  assert.equal(botMessagingEnabled({ botMessaging: false }), false);
  const lines = {
    waiting_approval: "COS is waiting for you to approve: send",
    silent: "COS had nothing to add.",
    expired: "COS didn't answer within 30 minutes.",
    gave_up: "COS gave up: nobody approved send.",
    failed: "COS couldn't answer.",
    replied_while_paused: "COS replied",
  } as const;
  for (const [outcome, line] of Object.entries(lines))
    assert.equal(
      botMessageStatusLine({
        deliveryId: d,
        botId: "C",
        botName: "COS",
        summary: "send",
        outcome: outcome as keyof typeof lines,
      }),
      line,
    );
});

test("empty run inputs deny messaging while an actual unlabelled person input permits it", () => {
  assert.deepEqual(botMessageChainOf([]), {
    canSend: false,
    code: "chain_too_deep",
  });
  assert.deepEqual(botMessageChainOf([undefined]), { canSend: true, hop: 1, chain: [] });
});
