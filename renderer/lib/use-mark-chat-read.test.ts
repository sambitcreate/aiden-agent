import assert from "node:assert/strict";
import test from "node:test";
import { latestReadableMessageId } from "./use-mark-chat-read.js";

test("read reports cover the newest persisted conversational message only", () => {
  assert.equal(latestReadableMessageId(undefined), null);
  assert.equal(latestReadableMessageId([]), null);
  assert.equal(
    latestReadableMessageId([
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
      { id: "sys", role: "system" },
    ]),
    "a1",
  );
  assert.equal(latestReadableMessageId([{ id: "tool", role: "tool" }]), null);
});
