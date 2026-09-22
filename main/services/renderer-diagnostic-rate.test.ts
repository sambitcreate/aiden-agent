import assert from "node:assert/strict";
import test from "node:test";

import { createRendererDiagnosticRateLimiter } from "./renderer-diagnostic-rate.js";

const report = {
  kind: "react-caught",
  errorType: "TypeError",
  context: "subtree",
  referenceId: "RD-12345678",
} as const;

test("main-owned renderer limiting caps each key and one suppression aggregate", () => {
  const limiter = createRendererDiagnosticRateLimiter(1_000, 2, 4);
  assert.equal(limiter.admit("document", report, 0), true);
  assert.equal(limiter.admit("document", report, 1), true);
  assert.equal(limiter.admit("document", report, 2), false);
  assert.equal(limiter.admit("document", { ...report, suppressed: 10 }, 3), true);
  assert.equal(limiter.admit("document", { ...report, suppressed: 10 }, 4), false);
  assert.equal(limiter.admit("document", report, 1_001), true);
  limiter.clear("document");
  assert.equal(limiter.admit("document", report, 1_002), true);
});
