import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ANALYTICS_STATE,
  analyticsSendStatus,
  disableAnalytics,
  enableAnalytics,
  ensureInstallId,
  envDisablesAnalytics,
  markNoticeShown,
  parseAnalyticsState,
} from "./analytics-consent.js";

const INSTALL_ID = "0b6f4a6e-3c1d-4f8e-9a2b-7c5d1e0f9a8b";
const NOW = new Date("2026-10-30T12:00:00.000Z");
const ready = { enabled: true, noticeShownAt: NOW.toISOString() };

test("analytics is on by default but nothing is sent before the notice", () => {
  const state = parseAnalyticsState(undefined);

  assert.equal(state.enabled, true);
  assert.deepEqual(analyticsSendStatus(state, { env: {}, hasKey: true }), { canSend: false, reason: "notice_pending" });
  assert.deepEqual(analyticsSendStatus(markNoticeShown(state, NOW), { env: {}, hasKey: true }), { canSend: true });
});

test("builds without a key never send", () => {
  assert.deepEqual(analyticsSendStatus(ready, { env: {}, hasKey: false }), { canSend: false, reason: "no_key" });
});

test("the environment overrides the saved setting", () => {
  for (const env of [{ DO_NOT_TRACK: "1" }, { DO_NOT_TRACK: "true" }, { AIDEN_ANALYTICS: "0" }, { AIDEN_ANALYTICS: "off" }]) {
    assert.equal(envDisablesAnalytics(env), true, JSON.stringify(env));
    assert.deepEqual(analyticsSendStatus(ready, { env, hasKey: true }), { canSend: false, reason: "environment" });
  }
  for (const env of [{}, { DO_NOT_TRACK: "0" }, { DO_NOT_TRACK: "" }, { AIDEN_ANALYTICS: "1" }]) {
    assert.equal(envDisablesAnalytics(env), false, JSON.stringify(env));
  }
});

test("turning analytics off deletes the install id, and back on starts a new one", () => {
  const withId = ensureInstallId(ready, () => INSTALL_ID);
  assert.equal(withId.installId, INSTALL_ID);

  const off = disableAnalytics(withId);
  assert.equal(off.enabled, false);
  assert.equal(off.installId, undefined);
  assert.deepEqual(analyticsSendStatus(off, { env: {}, hasKey: true }), { canSend: false, reason: "disabled" });
  assert.equal(ensureInstallId(off, () => INSTALL_ID).installId, undefined);

  const on = ensureInstallId(enableAnalytics(off), () => "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
  assert.equal(on.installId, "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
});

test("re-enabling an already enabled state keeps its install id", () => {
  const withId = ensureInstallId(ready, () => INSTALL_ID);
  assert.equal(enableAnalytics(withId).installId, INSTALL_ID);
});

test("an install id must be a random UUID v4", () => {
  assert.throws(() => ensureInstallId(ready, () => "jane-macbook"));
});

test("a damaged settings record falls back field by field", () => {
  assert.deepEqual(parseAnalyticsState({
    enabled: "nope",
    installId: "not-a-uuid",
    noticeShownAt: "yesterday-ish",
    lastActiveDay: "2026-10-30",
    lastVersion: "1.2.3",
  }), { enabled: true, lastActiveDay: "2026-10-30", lastVersion: "1.2.3" });
  assert.deepEqual(parseAnalyticsState([]), DEFAULT_ANALYTICS_STATE);
});

test("a disabled record never yields an install id", () => {
  assert.equal(parseAnalyticsState({ enabled: false, installId: INSTALL_ID }).installId, undefined);
});
