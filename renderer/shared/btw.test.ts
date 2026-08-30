import assert from "node:assert/strict";
import test from "node:test";
import { parseBtwEvent } from "./btw.js";

test("BTW event parser accepts the bounded protocol and rejects malformed identities", () => {
  const event = {
    version: 1,
    chatId: "chat-1",
    requestId: "btw_request-1",
    sequence: 2,
    type: "terminal",
    status: "completed",
    answer: "A side answer",
    contextTrimmed: false,
  } as const;
  assert.deepEqual(parseBtwEvent(event), event);
  assert.equal(parseBtwEvent({ ...event, chatId: "../private" }), null);
  assert.equal(parseBtwEvent({ ...event, sequence: -1 }), null);
  assert.equal(parseBtwEvent({ ...event, answer: { secret: true } }), null);
});
