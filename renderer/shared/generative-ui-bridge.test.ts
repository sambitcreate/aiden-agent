import assert from "node:assert/strict";
import test from "node:test";
import { GENERATIVE_UI_ESCAPE_MESSAGE } from "./generative-ui.js";
import {
  GUEST_PROMPT_COOLDOWN_MS,
  MAX_GUEST_PROMPT_CHARS,
  MAX_INLINE_VISUAL_HEIGHT,
  MIN_INLINE_VISUAL_HEIGHT,
  clampInlineVisualHeight,
  admitGuestPrompt,
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

test("a visual's follow-up only ever becomes a confirmation request, never a send", () => {
  const base = { text: "Explain the spike", now: 10_000 };
  assert.deepEqual(admitGuestPrompt(base), { action: "confirm", text: "Explain the spike" });
  assert.deepEqual(admitGuestPrompt({ ...base, text: "  trim me \n" }), { action: "confirm", text: "trim me" });
  assert.deepEqual(admitGuestPrompt({ ...base, text: "   " }), { action: "reject", reason: "empty" });
});

test("follow-up text is bounded before trimming and requests are rate-limited per visual", () => {
  const base = { text: "Again", now: 10_000 };
  assert.equal(admitGuestPrompt({ ...base, text: "x".repeat(MAX_GUEST_PROMPT_CHARS) }).action, "confirm");
  assert.deepEqual(
    admitGuestPrompt({ ...base, text: `${" ".repeat(MAX_GUEST_PROMPT_CHARS)}x` }),
    { action: "reject", reason: "too_long" },
  );
  assert.deepEqual(
    admitGuestPrompt({ ...base, lastAcceptedAt: base.now - GUEST_PROMPT_COOLDOWN_MS + 1 }),
    { action: "reject", reason: "cooldown" },
  );
  assert.equal(admitGuestPrompt({ ...base, lastAcceptedAt: base.now - GUEST_PROMPT_COOLDOWN_MS }).action, "confirm");
});

