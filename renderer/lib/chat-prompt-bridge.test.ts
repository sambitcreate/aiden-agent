import assert from "node:assert/strict";
import test from "node:test";
import { registerChatPromptTarget, sendPromptToChat } from "./chat-prompt-bridge";

test("a prompt reaches only the chat it names, and only while that chat is on screen", () => {
  const sent: string[] = [];
  assert.equal(sendPromptToChat("chat-1", "Which PR is oldest?"), false);
  const unregister = registerChatPromptTarget("chat-1", (text) => sent.push(text));
  assert.equal(sendPromptToChat("chat-2", "elsewhere"), false);
  assert.equal(sendPromptToChat("chat-1", "Which PR is oldest?"), true);
  unregister();
  assert.equal(sendPromptToChat("chat-1", "after close"), false);
  assert.deepEqual(sent, ["Which PR is oldest?"]);
});

test("a remounted chat keeps receiving prompts when its old mount unregisters late", () => {
  const sent: string[] = [];
  const first = registerChatPromptTarget("chat-1", () => sent.push("old"));
  registerChatPromptTarget("chat-1", (text) => sent.push(text));
  first();
  assert.equal(sendPromptToChat("chat-1", "new"), true);
  assert.deepEqual(sent, ["new"]);
});
