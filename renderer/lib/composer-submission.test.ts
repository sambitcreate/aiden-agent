import assert from "node:assert/strict";
import test from "node:test";
import { composerSubmissionAllowed, type ComposerSubmissionStateInput } from "./composer-submission.js";

const readyState: ComposerSubmissionStateInput = {
  ready: true,
  isGenerating: false,
  sending: false,
  permissionSaving: false,
  gitOperationBusy: false,
  attaching: false,
};

test("composer send admission blocks the file-read race", () => {
  assert.equal(composerSubmissionAllowed(readyState), true);
  assert.equal(composerSubmissionAllowed({ ...readyState, attaching: true }), false);
});
