import assert from "node:assert/strict";
import test from "node:test";

import {
  GOOGLE_LIVE_ACCEPTANCE_CONFIRMATION,
  assertGoogleLiveAcceptanceReceipt,
  buildGoogleLiveAcceptanceReceipt,
  googleLiveAcceptanceEnabled,
  parseGoogleLiveAcceptanceArgs,
  parseGoogleLiveAppEvidence,
} from "./gemini-live-google-acceptance-core.mjs";

function passingReceipt() {
  return buildGoogleLiveAcceptanceReceipt({
    result: "pass",
    startedAt: "2026-08-11T12:00:00.000Z",
    completedAt: "2026-08-11T12:00:09.000Z",
    environment: {
      appVersion: "0.28.0",
      sdkVersion: "2.16.0",
      electronVersion: "43.0.0",
      nodeVersion: "24.0.0",
      macosVersion: "25.0.0",
      arch: "arm64",
      gitCommit: "0123456789abcdef0123456789abcdef01234567",
      gitDirty: false,
      buildSha256: "a".repeat(64),
      model: "gemini-live-reviewed-model",
    },
    timing: {
      credentialReadyMs: 1_000,
      liveReadyMs: 3_000,
      stopVisibleMs: 4_000,
      stoppedMs: 9_000,
      appReadyMs: 2_500,
      appProviderResponseMs: 3_500,
      appStopRequestedMs: 8_500,
      appStoppedMs: 8_501,
    },
    runnerEvidence: { isolatedProfile: true },
    appEvidence: {
      ready: true,
      providerResponse: true,
      stopRequested: true,
      stopped: true,
    },
    operatorEvidence: {
      credentialEnteredInApp: true,
      liveReadyObserved: true,
      providerResponseObserved: true,
      visibleStopObserved: true,
      stopActivated: true,
      idleAfterStopObserved: true,
    },
  });
}

test("real Google acceptance fails closed without both independent opt-ins", () => {
  assert.equal(googleLiveAcceptanceEnabled({}, true), false);
  assert.equal(
    googleLiveAcceptanceEnabled(
      { AIDEN_GEMINI_LIVE_REAL_ACCEPTANCE: "1" },
      false,
    ),
    false,
  );
  assert.equal(
    googleLiveAcceptanceEnabled(
      { AIDEN_GEMINI_LIVE_REAL_ACCEPTANCE: "1" },
      true,
    ),
    true,
  );
});

test("acceptance arguments allow only an explicit confirmation and reviewed model", () => {
  assert.deepEqual(
    parseGoogleLiveAcceptanceArgs([
      GOOGLE_LIVE_ACCEPTANCE_CONFIRMATION,
      "--model",
      "gemini-3.1-flash-live-preview",
    ]),
    { confirmed: true, model: "gemini-3.1-flash-live-preview" },
  );
  assert.throws(
    () => parseGoogleLiveAcceptanceArgs(["--api-key", "SECRET"]),
    /Unknown/u,
  );
  assert.throws(
    () =>
      parseGoogleLiveAcceptanceArgs([
        GOOGLE_LIVE_ACCEPTANCE_CONFIRMATION,
        "--model",
        "bad model",
      ]),
    /valid --model/u,
  );
});

test("receipt schema permits only content-free evidence and requires visible Stop proof", () => {
  const receipt = passingReceipt();
  assert.equal(receipt.result, "pass");
  assert.equal(receipt.durationMs, 9_000);
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /prompt|transcript|audio|frame|toolArgs|apiKey/iu,
  );

  assert.throws(
    () =>
      assertGoogleLiveAcceptanceReceipt({
        ...receipt,
        operatorEvidence: {
          ...receipt.operatorEvidence,
          visibleStopObserved: false,
        },
      }),
    /every evidence gate/u,
  );
  assert.throws(
    () =>
      assertGoogleLiveAcceptanceReceipt({
        ...receipt,
        transcript: "SECRET_SENTINEL",
      }),
    /forbidden field/u,
  );
  assert.throws(
    () =>
      assertGoogleLiveAcceptanceReceipt({
        ...receipt,
        environment: { ...receipt.environment, gitDirty: true },
      }),
    /clean git tree/u,
  );
  assert.throws(
    () =>
      assertGoogleLiveAcceptanceReceipt({
        ...receipt,
        environment: { ...receipt.environment, apiKey: "SECRET_SENTINEL" },
      }),
    /forbidden field/u,
  );
});

test("app-owned evidence accepts only the fixed complete lifecycle sequence", () => {
  const evidence = parseGoogleLiveAppEvidence(
    [
      {
        event: "ready",
        elapsedMs: 10,
        sessionId: "11111111-1111-4111-8111-111111111111",
      },
      {
        event: "provider_response",
        elapsedMs: 20,
        sessionId: "11111111-1111-4111-8111-111111111111",
      },
      {
        event: "stop_requested",
        elapsedMs: 30,
        sessionId: "11111111-1111-4111-8111-111111111111",
      },
      {
        event: "stopped",
        elapsedMs: 31,
        sessionId: "11111111-1111-4111-8111-111111111111",
      },
    ]
      .map(JSON.stringify)
      .join("\n"),
  );
  assert.equal(evidence.get("provider_response"), 20);
  assert.throws(
    () =>
      parseGoogleLiveAppEvidence(
        '{"event":"provider_response","elapsedMs":1,"sessionId":"11111111-1111-4111-8111-111111111111"}',
      ),
    /sequence/u,
  );
  assert.throws(
    () =>
      parseGoogleLiveAppEvidence(
        '{"event":"ready","elapsedMs":1,"sessionId":"11111111-1111-4111-8111-111111111111","audio":"SECRET"}',
      ),
    /forbidden field/u,
  );
  assert.throws(
    () =>
      parseGoogleLiveAppEvidence(
        [
          {
            event: "ready",
            elapsedMs: 1,
            sessionId: "11111111-1111-4111-8111-111111111111",
          },
          {
            event: "provider_response",
            elapsedMs: 2,
            sessionId: "22222222-2222-4222-8222-222222222222",
          },
        ]
          .map(JSON.stringify)
          .join("\n"),
      ),
    /multiple sessions/u,
  );
});

test("fixed failure receipts cannot absorb raw diagnostic content", () => {
  const pass = passingReceipt();
  const failure = buildGoogleLiveAcceptanceReceipt({
    ...pass,
    result: "fail",
    failureCode: "deadline_exceeded",
  });
  assert.equal(failure.failureCode, "deadline_exceeded");
  assert.throws(
    () =>
      assertGoogleLiveAcceptanceReceipt({
        ...failure,
        failureCode: "provider said SECRET",
      }),
    /fixed failure code/u,
  );
});
