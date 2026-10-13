import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKGROUND_RESPONSE_COMPOSER_PLACEHOLDER,
  BACKGROUND_RESPONSE_READINESS_MESSAGE,
  FOLLOW_UP_COMPOSER_PLACEHOLDER,
  READINESS_COMPOSER_PLACEHOLDER,
  NEW_CHAT_COMPOSER_PLACEHOLDERS,
  UNAVAILABLE_COMPOSER_PLACEHOLDER,
  chatReadinessMessage,
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
});

test("a blocked composer never repeats its readiness message as the placeholder", () => {
  // The composer prints the readiness message in its status line, so the
  // placeholder must be a different, shorter cue.
  for (const readinessMessage of [
    "Sign in to continue",
    "Loading chat…",
    BACKGROUND_RESPONSE_READINESS_MESSAGE,
  ]) {
    for (const hasMessages of [false, true]) {
      const placeholder = composerPlaceholder({
        ready: false,
        readinessMessage,
        hasMessages,
        chatId: "chat-6ea3b",
      });
      assert.notEqual(placeholder, readinessMessage);
      assert.ok(!placeholder.includes(readinessMessage.replace(/…$/u, "")));
    }
  }
});

test("a response running in the background reads as waiting, not as a second notice", () => {
  assert.equal(
    composerPlaceholder({
      ready: false,
      readinessMessage: BACKGROUND_RESPONSE_READINESS_MESSAGE,
      hasMessages: true,
      chatId: "chat-6ea3b",
    }),
    BACKGROUND_RESPONSE_COMPOSER_PLACEHOLDER,
  );
  assert.equal(
    composerPlaceholder({
      ready: false,
      readinessMessage: "Sign in to continue",
      hasMessages: true,
      chatId: "chat-6ea3b",
    }),
    READINESS_COMPOSER_PLACEHOLDER,
  );
});

test("chat readiness reports the first blocking reason in priority order", () => {
  const clear = {
    loading: false,
    failed: false,
    missing: false,
    appendReconciliationRequired: false,
    drainingWithoutProjection: false,
  };
  assert.equal(chatReadinessMessage(clear), undefined);
  assert.equal(
    chatReadinessMessage({ ...clear, drainingWithoutProjection: true }),
    BACKGROUND_RESPONSE_READINESS_MESSAGE,
  );
  // An unknown save status outranks the background response: sending must stop
  // until the user reloads, whatever else is running.
  assert.match(
    chatReadinessMessage({ ...clear, appendReconciliationRequired: true, drainingWithoutProjection: true }) ?? "",
    /Reload Aiden/u,
  );
  // A chat that is still loading has no other state to report yet.
  assert.equal(
    chatReadinessMessage({ ...clear, loading: true, missing: true, drainingWithoutProjection: true }),
    "Loading chat…",
  );
  assert.match(chatReadinessMessage({ ...clear, missing: true }) ?? "", /no longer available/u);
});
