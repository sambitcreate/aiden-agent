import assert from "node:assert/strict";
import test from "node:test";
import { composerSubmissionAllowed, type ComposerSubmissionStateInput } from "./computer-use-control.js";

const readyState: ComposerSubmissionStateInput = {
  ready: true,
  isGenerating: false,
  sending: false,
  permissionSaving: false,
  computerUseSaving: false,
  gitOperationBusy: false,
  attaching: false,
};

test("composer send admission blocks the file-read race", () => {
  assert.equal(composerSubmissionAllowed(readyState), true);
  assert.equal(composerSubmissionAllowed({ ...readyState, attaching: true }), false);
});
