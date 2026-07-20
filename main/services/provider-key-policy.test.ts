import assert from "node:assert/strict";
import test from "node:test";
import { canUseStoredProviderKey, sameProviderConnection } from "./provider-key-policy.js";

const saved = {
  id: "openai",
  kind: "openai",
  baseUrl: "https://api.openai.com/v1",
  needsKey: true,
};

test("only reuses a saved key for the same provider connection", () => {
  assert.equal(canUseStoredProviderKey(saved, { ...saved }), true);
  assert.equal(sameProviderConnection(saved, { ...saved }), true);
  assert.equal(
    canUseStoredProviderKey(saved, { ...saved, baseUrl: "https://example.invalid/v1" }),
    false,
  );
  assert.equal(
    sameProviderConnection(saved, { ...saved, baseUrl: "https://example.invalid/v1" }),
    false,
  );
  assert.equal(canUseStoredProviderKey(saved, { ...saved, kind: "anthropic" }), false);
  assert.equal(canUseStoredProviderKey(saved, { ...saved, needsKey: false }), false);
  assert.equal(canUseStoredProviderKey(null, saved), false);
});
