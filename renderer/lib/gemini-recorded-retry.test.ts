import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  GEMINI_RECORDED_RETRY_DESCRIPTION,
  GeminiRecordedRetryConsent,
  needsGeminiRecordedRetry,
} from "./gemini-recorded-retry.js";

test("recorded Gemini retries are offered only after an empty Live attempt", () => {
  assert.equal(needsGeminiRecordedRetry(true, ""), true);
  assert.equal(needsGeminiRecordedRetry(true, " committed text "), false);
  assert.equal(needsGeminiRecordedRetry(true, "", false), false);
  assert.equal(needsGeminiRecordedRetry(false, ""), false);
});

test("a recorded retry cannot proceed before explicit approval", async () => {
  const consent = new GeminiRecordedRetryConsent();
  let settled = false;
  const pending = consent.request().then((approved) => {
    settled = true;
    return approved;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  consent.resolve(true);
  assert.equal(await pending, true);
});

test("dismissal and superseding prompts deny the pending paid retry", async () => {
  const consent = new GeminiRecordedRetryConsent();
  const abandoned = consent.request();
  const current = consent.request();
  assert.equal(await abandoned, false);
  consent.resolve(false);
  assert.equal(await current, false);
  assert.match(GEMINI_RECORDED_RETRY_DESCRIPTION, /another Gemini API request and may incur cost/u);
});

test("both voice surfaces ask before constructing a recorded Gemini retry", () => {
  const composer = readFileSync(new URL("../components/composer.tsx", import.meta.url), "utf8");
  const hook = readFileSync(new URL("./use-voice-recorder.ts", import.meta.url), "utf8");
  const pill = readFileSync(new URL("../pill/pill-app.tsx", import.meta.url), "utf8");
  assert.match(composer, /confirmLabel="Retry with recording"/u);
  assert.match(hook, /await recordedRetryConsent\.request\(\)[\s\S]*?transcribeBlob/u);
  assert.match(
    pill,
    /recordedRetryConsent\.request\(\)[\s\S]*?const approved = await consent[\s\S]*?transcribeBlob/u,
  );
  assert.match(pill, /Retry saved audio\? May cost more\./u);
});
