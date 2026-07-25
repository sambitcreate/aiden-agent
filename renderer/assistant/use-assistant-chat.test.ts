import assert from "node:assert/strict";
import test from "node:test";
import { canSendAssistantMessage } from "./use-assistant-chat.js";

test("blocks empty and whitespace-only sends", () => {
  assert.equal(canSendAssistantMessage("", { streaming: false, ready: true }), false);
  assert.equal(canSendAssistantMessage("   \n ", { streaming: false, ready: true }), false);
});

test("blocks while a response is streaming", () => {
  assert.equal(canSendAssistantMessage("hi", { streaming: true, ready: true }), false);
});

test("blocks until a provider and model are known", () => {
  assert.equal(canSendAssistantMessage("hi", { streaming: false, ready: false }), false);
});

test("allows a real message when idle and ready", () => {
  assert.equal(canSendAssistantMessage("hi", { streaming: false, ready: true }), true);
});
