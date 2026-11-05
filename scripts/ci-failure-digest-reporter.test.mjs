import assert from "node:assert/strict";
import test from "node:test";
import reporter, { withRunnerStderr } from "./ci-failure-digest-reporter.mjs";

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

test("a transform error written as ERROR is kept on the load failure", async () => {
  async function* events() {
    yield {
      type: "test:stderr",
      data: {
        file: "/work/renderer/components/settings/storage-settings.test.tsx",
        message: "✘ [ERROR] Expected \">\" but found \"(\"\n    renderer/components/settings/storage-settings.test.tsx:24:45:\n",
      },
    };
    const error = new Error("test failed");
    error.code = "ERR_TEST_FAILURE";
    error.cause = "test failed";
    error.stack = undefined;
    yield {
      type: "test:fail",
      data: {
        name: "renderer/components/settings/storage-settings.test.tsx",
        file: "/work/renderer/components/settings/storage-settings.test.tsx",
        line: 1,
        column: 1,
        details: { error },
      },
    };
  }
  let out = "";
  for await (const chunk of reporter(events())) out += chunk;
  assert.match(out, /storage-settings\.test\.tsx:24:45/u);
  assert.match(out, /Expected ">" but found/u);
});
