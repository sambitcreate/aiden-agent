import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseStoredProviderKey,
  providerTransitionNeedsCredentialAccess,
  sameProviderConnection,
} from "./provider-key-policy.js";

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

test("keyless provider changes do not require a desktop secret store", () => {
  const keyless = { ...saved, needsKey: false };
  assert.equal(providerTransitionNeedsCredentialAccess(undefined, keyless), false);
  assert.equal(
    providerTransitionNeedsCredentialAccess(keyless, {
      ...keyless,
      baseUrl: "http://127.0.0.1:1234/v1",
    }),
    false,
  );
  assert.equal(providerTransitionNeedsCredentialAccess(keyless, undefined), false);
  assert.equal(providerTransitionNeedsCredentialAccess(saved, keyless), true);
  assert.equal(providerTransitionNeedsCredentialAccess(keyless, saved), true);
});
