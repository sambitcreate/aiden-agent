import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultWebFetchSettings,
  normalizeWebExtractAccountId,
  parseWebFetchSettings,
  webFetchRendererSnapshot,
} from "./web-fetch-settings.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

test("page reading is on by default and extract mode is off", () => {
  const settings = defaultWebFetchSettings();
  assert.equal(settings.enabled, true);
  assert.equal(settings.extract.enabled, false);
  assert.deepEqual(parseWebFetchSettings(settings), settings);
});

test("stored documents parse strictly; a newer or broken one is not read", () => {
  const valid = { version: 1, enabled: false, extract: { enabled: true, model: "cloudflare-clairic", accountId: ACCOUNT_ID } };
  assert.deepEqual(parseWebFetchSettings(valid), valid);
  for (const bad of [
    null,
    { ...valid, version: 2 },
    { ...valid, enabled: "yes" },
    { ...valid, extract: { ...valid.extract, model: "other-model" } },
    { ...valid, extract: { ...valid.extract, accountId: "not-an-account" } },
    // Stored IDs are already lowercase; anything else was not written by Aiden.
    { ...valid, extract: { ...valid.extract, accountId: ACCOUNT_ID.toUpperCase() } },
  ]) {
    assert.equal(parseWebFetchSettings(bad), undefined, JSON.stringify(bad));
  }
});

test("account IDs are 32 hex characters, trimmed and lowercased", () => {
  assert.equal(normalizeWebExtractAccountId(`  ${ACCOUNT_ID.toUpperCase()} `), ACCOUNT_ID);
  for (const bad of [undefined, 42, "", "0123", `${ACCOUNT_ID}0`, "g".repeat(32)]) {
    assert.equal(normalizeWebExtractAccountId(bad), undefined, String(bad));
  }
});

test("extract mode is active only when it is on and its model has an account ID and a key", () => {
  const on = { ...defaultWebFetchSettings(), extract: { enabled: true, model: "cloudflare-clairic" as const, accountId: ACCOUNT_ID } };
  assert.deepEqual(webFetchRendererSnapshot({ settings: on, webSearchEnabled: true, keyCount: 2 }).extract, {
    hasAccountId: true,
    keyCount: 2,
    ready: true,
    active: true,
  });
  assert.equal(webFetchRendererSnapshot({ settings: on, webSearchEnabled: true, keyCount: 0 }).extract.active, false);
  const { accountId: _accountId, ...withoutAccount } = on.extract;
  assert.equal(
    webFetchRendererSnapshot({ settings: { ...on, extract: withoutAccount }, webSearchEnabled: true, keyCount: 2 }).extract.active,
    false,
  );
  const off = { ...on, extract: { ...on.extract, enabled: false } };
  assert.deepEqual(webFetchRendererSnapshot({ settings: off, webSearchEnabled: true, keyCount: 2 }).extract, {
    hasAccountId: true,
    keyCount: 2,
    ready: true,
    active: false,
  });
});
