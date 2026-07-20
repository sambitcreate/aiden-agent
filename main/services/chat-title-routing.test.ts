import assert from "node:assert/strict";
import test from "node:test";
import { resolveChatTitleRoute } from "./chat-title-routing.js";
import type { FoundationModelsConnectionStatus } from "./types.js";

function status(
  state: FoundationModelsConnectionStatus["state"],
): FoundationModelsConnectionStatus {
  return {
    id: "apple-foundation-models",
    label: "Apple Foundation Models",
    state,
    detail: state,
    local: true,
    titleOnly: true,
    retryable: state === "model_preparing",
  };
}

test("automatic prefers Apple only while the native connection is ready", () => {
  assert.equal(resolveChatTitleRoute("automatic", status("ready")), "apple-foundation-models");
  assert.equal(resolveChatTitleRoute("automatic", status("model_preparing")), "chat-model");
  assert.equal(resolveChatTitleRoute("automatic", null), "chat-model");
});

test("Apple-only mode never falls through to a network chat model", () => {
  assert.equal(resolveChatTitleRoute("apple-foundation-models", status("ready")), "apple-foundation-models");
  assert.equal(resolveChatTitleRoute("apple-foundation-models", status("error")), "seed-only");
  assert.equal(resolveChatTitleRoute("apple-foundation-models", null), "seed-only");
});

test("chat-model mode ignores the native connection", () => {
  assert.equal(resolveChatTitleRoute("chat-model", status("ready")), "chat-model");
});
