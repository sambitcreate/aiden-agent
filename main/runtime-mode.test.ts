import assert from "node:assert/strict";
import test from "node:test";

import { isDevelopmentRuntime } from "./runtime-mode-core.js";

test("unpackaged apps default to development without relying on a renderer URL", () => {
  assert.equal(isDevelopmentRuntime({}, false), true);
  assert.equal(isDevelopmentRuntime({ AIDEN_RENDERER_URL: "" }, false), true);
});

test("packaged apps default to production", () => {
  assert.equal(isDevelopmentRuntime({}, true), false);
});

test("an explicit profile wins over packaging state", () => {
  assert.equal(isDevelopmentRuntime({ AIDEN_RUNTIME_PROFILE: "development" }, true), true);
  assert.equal(isDevelopmentRuntime({ AIDEN_RUNTIME_PROFILE: "production" }, false), false);
});
