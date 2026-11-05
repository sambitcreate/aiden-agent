import assert from "node:assert/strict";
import test from "node:test";
import { withRunnerStderr } from "./ci-failure-digest-reporter.mjs";

const loadFailure = [
  "not ok renderer/components/settings/storage-settings.test.tsx",
  "  at renderer/components/settings/storage-settings.test.tsx:1:1",
  "  Error: test failed",
].join("\n");

test("a load failure digest gains the runner stderr that names the thrown error", () => {
  const digest = withRunnerStderr(loadFailure, [
    "earlier line",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module './missing.js'",
  ]);
  assert.match(digest, /runner stderr:/u);
  assert.match(digest, /Cannot find module '\.\/missing\.js'/u);
  assert.match(digest, /not ok renderer\/components\/settings\/storage-settings\.test\.tsx/u);
});

test("an assertion failure keeps its own message and does not gain runner stderr", () => {
  const assertion = [
    "not ok the fixture that fails",
    "  at fixture.test.mjs:4:1",
    "  AssertionError [ERR_ASSERTION]: the sum the digest quotes",
  ].join("\n");
  assert.equal(withRunnerStderr(assertion, ["Error: unrelated noise"]), assertion);
});

test("a load failure with no captured stderr is left unchanged", () => {
  assert.equal(withRunnerStderr(loadFailure, []), loadFailure);
  assert.equal(withRunnerStderr(loadFailure, undefined), loadFailure);
});
