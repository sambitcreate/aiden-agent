import assert from "node:assert/strict";
import test from "node:test";
import { GENERATIVE_UI_ESCAPE_MESSAGE } from "./generative-ui.js";
import {
  GUEST_PROMPT_COOLDOWN_MS,
  MAX_GUEST_PROMPT_CHARS,
  MAX_INLINE_VISUAL_HEIGHT,
  MIN_INLINE_VISUAL_HEIGHT,
  clampInlineVisualHeight,
  decideGuestPrompt,
  parseGuestBridgeMessage,
} from "./generative-ui-bridge.js";

test("bridge accepts the legacy escape string and typed messages only", () => {
  assert.deepEqual(parseGuestBridgeMessage(GENERATIVE_UI_ESCAPE_MESSAGE), { type: "escape" });
  assert.deepEqual(parseGuestBridgeMessage({ type: "aiden:generative-ui:ready" }), { type: "ready" });
  assert.equal(parseGuestBridgeMessage({ type: "aiden:generative-ui:ready", extra: 1 }), undefined);
  assert.deepEqual(
    parseGuestBridgeMessage({ type: "aiden:generative-ui:resize", height: 412.6 }),
    { type: "resize", height: 412.6 },
  );
  assert.deepEqual(
    parseGuestBridgeMessage({ type: "aiden:generative-ui:prompt", text: "Drill into EMEA" }),
    { type: "prompt", text: "Drill into EMEA" },
  );
  for (const bad of [
    null,
    "aiden:generative-ui:resize",
    { type: "aiden:generative-ui:resize" },
    { type: "aiden:generative-ui:resize", height: "400" },
    { type: "aiden:generative-ui:resize", height: 400, extra: true },
    { type: "aiden:generative-ui:prompt", text: 42 },
    { type: "aiden:generative-ui:theme", vars: {} },
    { type: "aiden:other" },
  ]) {
    assert.equal(parseGuestBridgeMessage(bad), undefined, JSON.stringify(bad));
  }
});

test("inline visual height clamps hostile values into the visible range", () => {
  assert.equal(clampInlineVisualHeight(Number.NaN), MIN_INLINE_VISUAL_HEIGHT);
  assert.equal(clampInlineVisualHeight(-5), MIN_INLINE_VISUAL_HEIGHT);
  assert.equal(clampInlineVisualHeight(Number.POSITIVE_INFINITY), MAX_INLINE_VISUAL_HEIGHT);
  assert.equal(clampInlineVisualHeight(1e9), MAX_INLINE_VISUAL_HEIGHT);
  assert.equal(clampInlineVisualHeight(300.4), 301);
});

test("only a gesture attributed to the visual may auto-send; ungestured prompts stage once until the user sends", () => {
  // A guest can focus itself from a timer, so focus alone proves nothing.
  const base = {
    text: "Again", frameFocused: true, userActivated: false, alreadyStaged: false, chatBusy: false, now: 10_000,
  };
  assert.deepEqual(decideGuestPrompt(base), { action: "stage", text: "Again" });
  assert.deepEqual(decideGuestPrompt({ ...base, alreadyStaged: true }), { action: "reject", reason: "repeat" });
  assert.deepEqual(decideGuestPrompt({ ...base, userActivated: true }), { action: "send", text: "Again" });
  assert.deepEqual(decideGuestPrompt({ ...base, userActivated: true, alreadyStaged: true }), {
    action: "send",
    text: "Again",
  });
});

test("prompt length is checked before any trimming and the limit itself is accepted", () => {
  const base = { frameFocused: true, userActivated: true, alreadyStaged: false, chatBusy: false, now: 10_000 };
  assert.equal(decideGuestPrompt({ ...base, text: "x".repeat(MAX_GUEST_PROMPT_CHARS) }).action, "send");
  assert.deepEqual(
    decideGuestPrompt({ ...base, text: `${" ".repeat(MAX_GUEST_PROMPT_CHARS)}x` }),
    { action: "reject", reason: "too_long" },
  );
});

test("guest prompts need focus, content, size, and cooldown; busy chats stage", () => {
  const base = {
    text: "Explain the spike", frameFocused: true, userActivated: true, alreadyStaged: false, chatBusy: false, now: 10_000,
  };
  assert.deepEqual(decideGuestPrompt(base), { action: "send", text: "Explain the spike" });
  assert.deepEqual(decideGuestPrompt({ ...base, chatBusy: true }), {
    action: "stage",
    text: "Explain the spike",
  });
  assert.deepEqual(decideGuestPrompt({ ...base, frameFocused: false }), {
    action: "reject",
    reason: "unfocused",
  });
  assert.deepEqual(decideGuestPrompt({ ...base, text: "   " }), { action: "reject", reason: "empty" });
  assert.deepEqual(decideGuestPrompt({ ...base, text: "x".repeat(MAX_GUEST_PROMPT_CHARS + 1) }), {
    action: "reject",
    reason: "too_long",
  });
  assert.deepEqual(
    decideGuestPrompt({ ...base, lastAcceptedAt: base.now - GUEST_PROMPT_COOLDOWN_MS + 1 }),
    { action: "reject", reason: "cooldown" },
  );
  assert.equal(
    decideGuestPrompt({ ...base, lastAcceptedAt: base.now - GUEST_PROMPT_COOLDOWN_MS }).action,
    "send",
  );
  assert.deepEqual(decideGuestPrompt({ ...base, text: "  trim me \n" }), {
    action: "send",
    text: "trim me",
  });
});
