import assert from "node:assert/strict";
import test from "node:test";
import { ChatDeletionGate } from "./chat-deletion-gate.js";

test("chat deletion closes admission until cross-store cleanup releases it", () => {
  const gate = new ChatDeletionGate();
  assert.equal(gate.isDeleting("chat-1"), false);

  const release = gate.begin("chat-1");
  assert.equal(gate.isDeleting("chat-1"), true);
  assert.equal(gate.isDeleting("chat-2"), false);
  assert.throws(() => gate.begin("chat-1"), /already being deleted/u);

  release();
  release();
  assert.equal(gate.isDeleting("chat-1"), false);
});
