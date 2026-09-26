import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GEMINI_LIVE_ACCEPTANCE_EVIDENCE_ENV,
  GEMINI_LIVE_ACCEPTANCE_EVIDENCE_FILE,
  createGeminiLiveAcceptanceEvidenceRecorder,
} from "./acceptance-evidence.js";

test("app evidence recorder fails closed without exact opt-in and isolated userData path", () => {
  const userData = mkdtempSync(
    path.join(os.tmpdir(), "aiden-live-evidence-test-"),
  );
  const expected = path.join(userData, GEMINI_LIVE_ACCEPTANCE_EVIDENCE_FILE);
  assert.equal(
    createGeminiLiveAcceptanceEvidenceRecorder(
      { [GEMINI_LIVE_ACCEPTANCE_EVIDENCE_ENV]: expected },
      userData,
    ),
    null,
  );
  assert.equal(
    createGeminiLiveAcceptanceEvidenceRecorder(
      {
        AIDEN_GEMINI_LIVE_REAL_ACCEPTANCE: "1",
        [GEMINI_LIVE_ACCEPTANCE_EVIDENCE_ENV]: path.join(
          userData,
          "other.jsonl",
        ),
      },
      userData,
    ),
    null,
  );
});

test("app evidence is fixed, content-free, unique, and monotonic", () => {
  const userData = mkdtempSync(
    path.join(os.tmpdir(), "aiden-live-evidence-test-"),
  );
  const expected = path.join(userData, GEMINI_LIVE_ACCEPTANCE_EVIDENCE_FILE);
  let clock = 100;
  const recorder = createGeminiLiveAcceptanceEvidenceRecorder(
    {
      AIDEN_GEMINI_LIVE_REAL_ACCEPTANCE: "1",
      [GEMINI_LIVE_ACCEPTANCE_EVIDENCE_ENV]: expected,
    },
    userData,
    () => clock,
  );
  assert.ok(recorder);
  clock = 125;
  recorder.record("ready", "11111111-1111-4111-8111-111111111111");
  recorder.record("ready", "11111111-1111-4111-8111-111111111111");
  clock = 180;
  recorder.record("provider_response", "22222222-2222-4222-8222-222222222222");
  recorder.record("provider_response", "11111111-1111-4111-8111-111111111111");
  const contents = readFileSync(expected, "utf8");
  assert.deepEqual(
    contents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [
      {
        event: "ready",
        elapsedMs: 25,
        sessionId: "11111111-1111-4111-8111-111111111111",
      },
      {
        event: "provider_response",
        elapsedMs: 80,
        sessionId: "11111111-1111-4111-8111-111111111111",
      },
    ],
  );
  assert.doesNotMatch(
    contents,
    /prompt|transcript|audio|frame|tool|credential|key/iu,
  );
});
