import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptAmbientMusicEventSequence,
  AmbientMusicProtocolError,
  MAX_AMBIENT_MUSIC_MESSAGE_BYTES,
  parseAmbientMusicHelperMessage,
} from "./ambient-music-protocol.js";

test("parses strict Ambient Music responses and events", () => {
  assert.deepEqual(
    parseAmbientMusicHelperMessage(
      JSON.stringify({ version: 1, type: "response", requestId: "one", ok: true, result: {} }),
    ),
    { version: 1, type: "response", requestId: "one", ok: true, result: {} },
  );
  const ready = parseAmbientMusicHelperMessage(
    JSON.stringify({ version: 1, type: "event", event: "ready", sequence: 1, detail: {} }),
  );
  assert.equal(ready.type, "event");
  if (ready.type === "event") assert.equal(acceptAmbientMusicEventSequence(0, ready), 1);
});

test("rejects malformed, oversized, and stale helper output", () => {
  assert.throws(() => parseAmbientMusicHelperMessage("not json"), AmbientMusicProtocolError);
  assert.throws(
    () => parseAmbientMusicHelperMessage(JSON.stringify({ version: 2, type: "event" })),
    /protocol does not match/,
  );
  assert.throws(
    () => parseAmbientMusicHelperMessage("x".repeat(MAX_AMBIENT_MUSIC_MESSAGE_BYTES + 1)),
    /too large/,
  );
  const event = parseAmbientMusicHelperMessage(
    JSON.stringify({ version: 1, type: "event", event: "ready", sequence: 3, detail: {} }),
  );
  if (event.type === "event") assert.throws(() => acceptAmbientMusicEventSequence(3, event), /stale/);
});

test("requires response result or bounded error details", () => {
  assert.throws(
    () => parseAmbientMusicHelperMessage(
      JSON.stringify({ version: 1, type: "response", requestId: "one", ok: true }),
    ),
    /no result/,
  );
  assert.throws(
    () => parseAmbientMusicHelperMessage(
      JSON.stringify({ version: 1, type: "response", requestId: "one", ok: false, error: { code: 4 } }),
    ),
    /invalid error/,
  );
});
