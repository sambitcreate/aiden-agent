import assert from "node:assert/strict";
import test from "node:test";
import { isArtificialAnalysisKeyError, resolveModelPadGate } from "./model-data-control.js";
import type { ArtificialAnalysisStatus } from "./types.js";

function status(patch: Partial<ArtificialAnalysisStatus> = {}): ArtificialAnalysisStatus {
  return {
    state: "not_connected",
    hasKey: false,
    cleanupNeeded: false,
    ready: false,
    cachedModelCount: 0,
    rankedModelCount: 0,
    ...patch,
  };
}

test("keeps the Pad visible but locked until a matching local cache is ready", () => {
  assert.equal(resolveModelPadGate(undefined, { loading: true }).unlocked, false);
  assert.match(resolveModelPadGate(status()).detail, /Connect your Artificial Analysis API key/u);
  assert.match(
    resolveModelPadGate(status({ state: "connected", hasKey: true })).detail,
    /API key is saved/u,
  );
  assert.equal(
    resolveModelPadGate(
      status({
        state: "ready",
        hasKey: true,
        ready: true,
        cachedModelCount: 4,
        rankedModelCount: 3,
      }),
    ).unlocked,
    true,
  );
  assert.match(resolveModelPadGate(status(), { failed: true }).detail, /couldn’t check/u);
  assert.match(
    resolveModelPadGate(status({ cleanupNeeded: true })).detail,
    /still needs to remove cached model data/u,
  );
});

test("only credential-related failures mark the API-key field invalid", () => {
  assert.equal(isArtificialAnalysisKeyError("invalid_key"), true);
  assert.equal(isArtificialAnalysisKeyError("access_denied"), true);
  assert.equal(isArtificialAnalysisKeyError("invalid_input"), true);
  assert.equal(isArtificialAnalysisKeyError("network_error"), false);
  assert.equal(isArtificialAnalysisKeyError("service_unavailable"), false);
  assert.equal(isArtificialAnalysisKeyError("local_error"), false);
});
