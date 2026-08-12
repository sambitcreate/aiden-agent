import assert from "node:assert/strict";
import test from "node:test";
import {
  CUSTOM_HANDLER_MODE,
  NATIVE_SYSTEM_PICKER_MODE,
  evaluateDisplayCaptureEvidence,
} from "./gemini-live-electron-spike-core.mjs";

const complete = {
  customDisplayRequests: 0,
  displayPermissionPath: true,
  nativeFallbackRequests: 0,
  navigationRejected: true,
  replacementChooserFallbackRequests: 0,
  replacementDocumentDenied: true,
  pickerCancelled: true,
  pickerCancellationErrorName: "NotAllowedError",
  requireDisplay: true,
  externalSourceEnded: true,
  localTrackStopTeardown: true,
};

test("custom auto-selection proves only its deterministic handler contract", () => {
  assert.deepEqual(
    evaluateDisplayCaptureEvidence({
      ...complete,
      captureMode: CUSTOM_HANDLER_MODE,
      customDisplayRequests: 3,
    }),
    {
      deterministicCustomHandlerContract: true,
      operatorNativeChooserAcceptance: false,
    },
  );
});

test("authorized acceptance requires native picker evidence without handler fallback", () => {
  assert.deepEqual(
    evaluateDisplayCaptureEvidence({
      ...complete,
      captureMode: NATIVE_SYSTEM_PICKER_MODE,
    }),
    {
      deterministicCustomHandlerContract: false,
      operatorNativeChooserAcceptance: true,
    },
  );
  assert.equal(
    evaluateDisplayCaptureEvidence({
      ...complete,
      captureMode: NATIVE_SYSTEM_PICKER_MODE,
      nativeFallbackRequests: 1,
    }).operatorNativeChooserAcceptance,
    false,
  );
  assert.equal(
    evaluateDisplayCaptureEvidence({
      ...complete,
      captureMode: NATIVE_SYSTEM_PICKER_MODE,
      replacementDocumentDenied: false,
    }).operatorNativeChooserAcceptance,
    false,
  );
  assert.equal(
    evaluateDisplayCaptureEvidence({
      ...complete,
      captureMode: NATIVE_SYSTEM_PICKER_MODE,
      replacementChooserFallbackRequests: 1,
    }).operatorNativeChooserAcceptance,
    false,
  );
  assert.equal(
    evaluateDisplayCaptureEvidence({
      ...complete,
      captureMode: NATIVE_SYSTEM_PICKER_MODE,
      externalSourceEnded: false,
    }).operatorNativeChooserAcceptance,
    false,
  );
  assert.equal(
    evaluateDisplayCaptureEvidence({
      ...complete,
      captureMode: NATIVE_SYSTEM_PICKER_MODE,
      customDisplayRequests: 1,
    }).operatorNativeChooserAcceptance,
    false,
  );
  assert.equal(
    evaluateDisplayCaptureEvidence({
      ...complete,
      captureMode: NATIVE_SYSTEM_PICKER_MODE,
      pickerCancellationErrorName: "NotReadableError",
    }).operatorNativeChooserAcceptance,
    false,
  );
});
