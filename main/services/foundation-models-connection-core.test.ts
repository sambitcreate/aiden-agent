// Supplementary branch coverage for foundation-models-connection-core.ts.
//
// The sibling foundation-models-connection.test.ts already covers the happy
// paths and the most common validation failures. This file targets the
// remaining unhandled branches of parseFoundationModelsResponse and
// platformFoundationModelsStatus so the core module has a dedicated -core.test.

import assert from "node:assert/strict";
import test from "node:test";
import {
  FoundationModelsConnectionError,
  parseFoundationModelsResponse,
  platformFoundationModelsStatus,
} from "./foundation-models-connection-core.js";

test("parseFoundationModelsResponse accepts a success result carrying a title", () => {
  assert.deepEqual(
    parseFoundationModelsResponse('{"version":1,"ok":true,"result":{"title":"My Chat"}}'),
    { version: 1, ok: true, result: { title: "My Chat" } },
  );
});

test("parseFoundationModelsResponse accepts a result with both state and title", () => {
  assert.deepEqual(
    parseFoundationModelsResponse('{"version":1,"ok":true,"result":{"state":"ready","title":"X"}}'),
    { version: 1, ok: true, result: { state: "ready", title: "X" } },
  );
});

test("parseFoundationModelsResponse accepts an availability state of unavailable", () => {
  assert.deepEqual(
    parseFoundationModelsResponse('{"version":1,"ok":true,"result":{"state":"unavailable"}}'),
    { version: 1, ok: true, result: { state: "unavailable" } },
  );
});

test("parseFoundationModelsResponse rejects a non-object envelope root", () => {
  assert.throws(
    () => parseFoundationModelsResponse('"just-a-string"'),
    (error: unknown) => error instanceof FoundationModelsConnectionError,
  );
  assert.throws(
    () => parseFoundationModelsResponse("null"),
    (error: unknown) => error instanceof FoundationModelsConnectionError,
  );
});

test("parseFoundationModelsResponse rejects ok:true with a non-object result", () => {
  assert.throws(
    () => parseFoundationModelsResponse('{"version":1,"ok":true,"result":"ready"}'),
    /no result/,
  );
});

test("parseFoundationModelsResponse rejects ok:true with an empty result (no state, no title)", () => {
  assert.throws(
    () => parseFoundationModelsResponse('{"version":1,"ok":true,"result":{}}'),
    /empty result/,
  );
});

test("parseFoundationModelsResponse rejects a non-string title", () => {
  assert.throws(
    () => parseFoundationModelsResponse('{"version":1,"ok":true,"result":{"title":42}}'),
    /invalid title/,
  );
});

test("parseFoundationModelsResponse rejects ok:false without an error object", () => {
  assert.throws(
    () => parseFoundationModelsResponse('{"version":1,"ok":false}'),
    /no error details/,
  );
});

test("parseFoundationModelsResponse rejects ok:false with non-boolean retryable", () => {
  assert.throws(
    () =>
      parseFoundationModelsResponse(
        '{"version":1,"ok":false,"error":{"code":"x","message":"y","retryable":"yes"}}',
      ),
    /error details/,
  );
});

// ── platformFoundationModelsStatus edge cases ──────────────────────────────

test("platformFoundationModelsStatus reports unsupported_os for an unparseable system version", () => {
  assert.equal(
    platformFoundationModelsStatus({ platform: "darwin", arch: "arm64", systemVersion: "abc" })?.state,
    "unsupported_os",
  );
});

test("platformFoundationModelsStatus reports unsupported_os when the major version is below 26", () => {
  assert.equal(
    platformFoundationModelsStatus({ platform: "darwin", arch: "arm64", systemVersion: "15.9.1" })?.state,
    "unsupported_os",
  );
  // Boundary: 26 is the first supported major.
  assert.equal(
    platformFoundationModelsStatus({ platform: "darwin", arch: "arm64", systemVersion: "26.0.0" }),
    undefined,
  );
});

test("platformFoundationModelsStatus marks model_preparing availability as retryable via the connection factory", async () => {
  // Verify the retryable flag wiring indirectly: parse accepts model_preparing,
  // and the connection's status() surfaces it. (Direct mapNativeAvailability is
  // not exported, so exercise it through createFoundationModelsConnection.)
  const { createFoundationModelsConnection } = await import("./foundation-models-connection-core.js");
  const connection = createFoundationModelsConnection({
    platform: "darwin",
    arch: "arm64",
    systemVersion: "26.0",
    now: Date.now,
    runRequest: async () => ({ version: 1, ok: true, result: { state: "model_preparing" } }),
  });
  const status = await connection.status();
  assert.equal(status?.state, "model_preparing");
  assert.equal(status?.retryable, true);
});
