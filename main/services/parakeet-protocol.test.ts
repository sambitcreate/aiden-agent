import assert from "node:assert/strict";
import test from "node:test";
import {
  isParakeetParentMessage,
  isParakeetWorkerMessage,
  PARAKEET_PROTOCOL_VERSION,
} from "./parakeet-protocol.js";

test("parakeet protocol accepts only versioned request and result frames", () => {
  assert.equal(
    isParakeetParentMessage({
      version: PARAKEET_PROTOCOL_VERSION,
      kind: "status",
      requestId: "r1",
    }),
    true,
  );
  assert.equal(
    isParakeetParentMessage({
      version: PARAKEET_PROTOCOL_VERSION,
      kind: "transcribe",
      requestId: "r1",
      modelId: "parakeet-v3",
      modelDirectory: "/tmp/model",
      pcmBase64: "AAA=",
      encoding: "pcm_s16le",
    }),
    true,
  );
  assert.equal(
    isParakeetParentMessage({
      version: PARAKEET_PROTOCOL_VERSION,
      kind: "transcribe",
      requestId: "r1",
      modelId: "parakeet-v3",
      modelDirectory: "/tmp/model",
      pcmBase64: "AAA=",
    }),
    false,
  );
  assert.equal(isParakeetParentMessage({ kind: "status", requestId: "r1" }), false);
  assert.equal(
    isParakeetWorkerMessage({
      version: PARAKEET_PROTOCOL_VERSION,
      kind: "result",
      requestId: "r1",
      text: "hello",
    }),
    true,
  );
  assert.equal(
    isParakeetWorkerMessage({
      version: PARAKEET_PROTOCOL_VERSION,
      kind: "result",
      requestId: "r1",
      text: 12,
    }),
    false,
  );
  assert.equal(
    isParakeetWorkerMessage({
      version: PARAKEET_PROTOCOL_VERSION,
      kind: "failure",
      requestId: "r1",
      message: "nope",
    }),
    true,
  );
});
