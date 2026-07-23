import assert from "node:assert/strict";
import test from "node:test";
import { isArtificialAnalysisKeyError } from "./model-data-control.js";

test("only credential-related failures mark the API-key field invalid", () => {
  assert.equal(isArtificialAnalysisKeyError("invalid_key"), true);
  assert.equal(isArtificialAnalysisKeyError("access_denied"), true);
  assert.equal(isArtificialAnalysisKeyError("invalid_input"), true);
  assert.equal(isArtificialAnalysisKeyError("network_error"), false);
  assert.equal(isArtificialAnalysisKeyError("service_unavailable"), false);
  assert.equal(isArtificialAnalysisKeyError("local_error"), false);
});
