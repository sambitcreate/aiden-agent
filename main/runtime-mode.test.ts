import assert from "node:assert/strict";
import test from "node:test";

import { isDevelopmentRuntime } from "./runtime-mode-core.js";

test("the branded hot-reload bundle remains a development runtime", () => {
  assert.equal(isDevelopmentRuntime({ AIDEN_RENDERER_URL: "http://127.0.0.1:4143" }), true);
  assert.equal(isDevelopmentRuntime({ AIDEN_RENDERER_URL: "" }), false);
  assert.equal(isDevelopmentRuntime({}), false);
});
