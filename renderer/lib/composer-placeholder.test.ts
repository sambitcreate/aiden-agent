import assert from "node:assert/strict";
import test from "node:test";
import {
  FOLLOW_UP_COMPOSER_PLACEHOLDER,
  NEW_CHAT_COMPOSER_PLACEHOLDERS,
  UNAVAILABLE_COMPOSER_PLACEHOLDER,
  composerPlaceholder,
} from "./composer-placeholder.js";

test("keeps ten distinct prompts available for empty chats", () => {
  assert.equal(NEW_CHAT_COMPOSER_PLACEHOLDERS.length, 10);
  assert.equal(new Set(NEW_CHAT_COMPOSER_PLACEHOLDERS).size, 10);
});

test("uses a stable approved prompt for an empty ready chat", () => {
  const input = {
    ready: true,
    hasMessages: false,
    chatId: "chat-6ea3b",
  };

  const placeholder = composerPlaceholder(input);
  assert.ok(NEW_CHAT_COMPOSER_PLACEHOLDERS.some((candidate) => candidate === placeholder));
  assert.equal(composerPlaceholder(input), placeholder);
});

test("shows Follow up after the chat has been initiated", () => {
  assert.equal(
    composerPlaceholder({
      ready: true,
      hasMessages: true,
      chatId: "chat-6ea3b",
    }),
    FOLLOW_UP_COMPOSER_PLACEHOLDER,
  );
});

test("keeps unavailable-model guidance ahead of conversational prompt copy", () => {
  assert.equal(
    composerPlaceholder({
      ready: false,
      hasMessages: false,
      chatId: "chat-6ea3b",
    }),
    UNAVAILABLE_COMPOSER_PLACEHOLDER,
  );
  assert.equal(
    composerPlaceholder({
      ready: false,
      readinessMessage: "Sign in to continue",
      hasMessages: true,
      chatId: "chat-6ea3b",
    }),
    "Sign in to continue",
  );
});
