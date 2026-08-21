import assert from "node:assert/strict";
import test from "node:test";
import {
  createCreateImagesRecentOutputDrag,
  parseCreateImagesRecentOutputDrag,
  serializeCreateImagesRecentOutputDrag,
} from "./recent-output-core.js";

const item = {
  assetId: "a".repeat(64),
  runId: "run-1",
  workflowId: "workflow-1",
  nodeId: "generator-1",
  prompt: "A quiet yellow coupe",
  modelLabel: "gemini-image",
  createdAt: "2026-08-21T10:00:00.000Z",
  width: 1024,
  height: 1024,
  mediaType: "image/png" as const,
};

test("recent output drag payload carries only opaque authority and a bounded label", () => {
  const payload = createCreateImagesRecentOutputDrag(item);
  const serialized = serializeCreateImagesRecentOutputDrag(payload);
  assert.ok(serialized);
  assert.deepEqual(parseCreateImagesRecentOutputDrag(serialized), payload);
  assert.doesNotMatch(serialized, /prompt|model|createdAt|path|bytes|token/u);
});

test("recent output drag parser rejects paths, unknown fields, and invalid identities", () => {
  const payload = createCreateImagesRecentOutputDrag(item);
  assert.equal(
    parseCreateImagesRecentOutputDrag(JSON.stringify({ ...payload, path: "/tmp/image.png" })),
    undefined,
  );
  assert.equal(
    parseCreateImagesRecentOutputDrag(JSON.stringify({ ...payload, assetId: "bad" })),
    undefined,
  );
  assert.equal(parseCreateImagesRecentOutputDrag("{"), undefined);
  assert.equal(parseCreateImagesRecentOutputDrag("x".repeat(2_049)), undefined);
});
