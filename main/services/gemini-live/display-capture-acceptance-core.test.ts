import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  evaluateDisplayCaptureAcceptance,
  GEMINI_LIVE_CAPTURE_ACCEPTANCE_ENV,
  GEMINI_LIVE_CAPTURE_ACCEPTANCE_PROFILE_ENV,
  GEMINI_LIVE_CAPTURE_ACCEPTANCE_SWITCH,
  GEMINI_LIVE_CAPTURE_ACCEPTANCE_TOKEN_ENV,
  parseCaptureAcceptanceLaunch,
} from "./display-capture-acceptance-core.js";

const token = "a".repeat(64);
const bundle = "/private/tmp/Aiden Agent.app";
const profile = "/private/tmp/aiden-capture-profile";
const completeLaunch = {
  argv: [`--${GEMINI_LIVE_CAPTURE_ACCEPTANCE_SWITCH}=${token}`],
  environment: {
    [GEMINI_LIVE_CAPTURE_ACCEPTANCE_ENV]: "1",
    [GEMINI_LIVE_CAPTURE_ACCEPTANCE_TOKEN_ENV]: token,
    [GEMINI_LIVE_CAPTURE_ACCEPTANCE_PROFILE_ENV]: profile,
  },
  executablePath: path.join(bundle, "Contents/MacOS/Aiden Agent"),
  appPath: path.join(bundle, "Contents/Resources/app.asar"),
  isPackaged: true,
  platform: "darwin" as const,
  userDataPath: profile,
};

test("acceptance mode is absent from an ordinary Aiden launch", () => {
  assert.deepEqual(
    parseCaptureAcceptanceLaunch({
      ...completeLaunch,
      argv: [],
      environment: {},
    }),
    { requested: false },
  );
});

test("acceptance requires correlated environment and command-line opt-ins", () => {
  assert.deepEqual(parseCaptureAcceptanceLaunch(completeLaunch), {
    requested: true,
    accepted: true,
    profilePath: profile,
    token,
  });
  for (const input of [
    { ...completeLaunch, argv: [] },
    {
      ...completeLaunch,
      environment: { ...completeLaunch.environment, [GEMINI_LIVE_CAPTURE_ACCEPTANCE_ENV]: "0" },
    },
    {
      ...completeLaunch,
      environment: {
        ...completeLaunch.environment,
        [GEMINI_LIVE_CAPTURE_ACCEPTANCE_TOKEN_ENV]: "b".repeat(64),
      },
    },
  ]) {
    const result = parseCaptureAcceptanceLaunch(input);
    assert.equal(result.requested, true);
    assert.equal(result.accepted, false);
  }
});

test("acceptance fails closed outside the exact packaged Aiden bundle and isolated profile", () => {
  for (const input of [
    { ...completeLaunch, isPackaged: false },
    { ...completeLaunch, platform: "linux" as const },
    { ...completeLaunch, userDataPath: "/private/tmp/not-the-profile" },
    { ...completeLaunch, executablePath: "/Applications/Electron.app/Contents/MacOS/Electron" },
    { ...completeLaunch, appPath: "/private/tmp/other/app.asar" },
  ]) {
    const result = parseCaptureAcceptanceLaunch(input);
    assert.equal(result.requested, true);
    assert.equal(result.accepted, false);
  }
});

const completeEvidence = {
  displayPermissionPath: true,
  externalSourceEnded: true,
  nativeFallbackRequests: 0,
  navigationRejected: true,
  pickerCancellationErrorName: "NotAllowedError",
  pickerCancelled: true,
  replacementChooserFallbackRequests: 0,
  replacementDocumentDenied: true,
};

test("capture evidence requires chooser cancellation, external end, and replacement denial", () => {
  assert.equal(evaluateDisplayCaptureAcceptance(completeEvidence).accepted, true);
  for (const evidence of [
    { ...completeEvidence, externalSourceEnded: false },
    { ...completeEvidence, pickerCancelled: false },
    { ...completeEvidence, pickerCancellationErrorName: "NotReadableError" },
    { ...completeEvidence, nativeFallbackRequests: 1 },
    { ...completeEvidence, replacementDocumentDenied: false },
    { ...completeEvidence, replacementChooserFallbackRequests: 1 },
  ]) {
    assert.equal(evaluateDisplayCaptureAcceptance(evidence).accepted, false);
  }
});
