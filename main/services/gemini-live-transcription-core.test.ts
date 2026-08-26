import assert from "node:assert/strict";
import test from "node:test";
import {
  bindOwnerInvalidation,
  decodePcm16Chunk,
  GeminiLiveFinalizationGate,
  GeminiLiveTranscriptAccumulator,
  waitForLiveStartup,
} from "./gemini-live-transcription-core.js";

test("live transcript keeps finalized text stable while interim text is replaced", () => {
  const transcript = new GeminiLiveTranscriptAccumulator();
  assert.deepEqual(
    transcript.consume({ serverContent: { interimInputTranscription: { text: "hello wor" } } })
      .snapshot,
    { committed: "", tentative: "hello wor" },
  );
  assert.deepEqual(
    transcript.consume({ serverContent: { interimInputTranscription: { text: "hello world" } } })
      .snapshot,
    { committed: "", tentative: "hello world" },
  );
  assert.deepEqual(
    transcript.consume({ serverContent: { inputTranscription: { text: "Hello world." } } })
      .snapshot,
    { committed: "Hello world.", tentative: "" },
  );
  transcript.consume({ serverContent: { inputTranscription: { text: "Next sentence." } } });
  assert.equal(transcript.fullText(), "Hello world. Next sentence.");
});

test("live transcript preserves repeated and prefix-matching finalized utterances", () => {
  const transcript = new GeminiLiveTranscriptAccumulator();
  transcript.consume({ serverContent: { inputTranscription: { text: "yes" } } });
  transcript.consume({ serverContent: { inputTranscription: { text: "yes" } } });
  transcript.consume({ serverContent: { inputTranscription: { text: "I" } } });
  transcript.consume({ serverContent: { inputTranscription: { text: "I agree" } } });
  assert.equal(transcript.fullText(), "yes yes I I agree");
});

test("live transcript retains latest usage metadata", () => {
  const transcript = new GeminiLiveTranscriptAccumulator();
  const usage = { promptTokenCount: 12, responseTokenCount: 3 };
  transcript.consume({ usageMetadata: usage, serverContent: { turnComplete: true } });
  assert.equal(transcript.usage, usage);
});

test("finalization waits for completion and postpones for delayed transcript updates", () => {
  const gate = new GeminiLiveFinalizationGate();
  assert.equal(gate.observe({ changed: true, finalized: false, turnComplete: false }), false);
  assert.equal(gate.observe({ changed: false, finalized: false, turnComplete: true }), true);
  assert.equal(gate.observe({ changed: true, finalized: true, turnComplete: false }), true);
  assert.equal(gate.observe({ changed: true, finalized: false, turnComplete: false }), true);
});

test("finalization accepts the documented final-only server sequence", () => {
  const gate = new GeminiLiveFinalizationGate();
  assert.equal(gate.observe({ changed: true, finalized: true, turnComplete: false }), true);
});

test("Live startup rejects pre-session failures instead of waiting indefinitely", async () => {
  const connection = new Promise<{ close(): void }>(() => {});
  await assert.rejects(
    waitForLiveStartup(connection, Promise.reject(new Error("offline")), 1_000),
    /offline/u,
  );
});

test("Live startup times out missing setup and closes a session that resolves late", async () => {
  let resolveConnection: ((session: { close(): void }) => void) | undefined;
  const connection = new Promise<{ close(): void }>((resolve) => {
    resolveConnection = resolve;
  });
  let closed = false;
  await assert.rejects(
    waitForLiveStartup(connection, new Promise<never>(() => {}), 5),
    /timed out while connecting/u,
  );
  resolveConnection?.({ close: () => (closed = true) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(closed, true);
});

test("owner invalidation can synchronously cancel a newly connected published session", () => {
  let published = false;
  let cancelled = false;
  const record = { settled: false, removeOwnerInvalidation: () => {} };
  const bound = bindOwnerInvalidation(
    record,
    {
      isDestroyed: () => true,
      onInvalidated: (listener) => {
        assert.equal(published, true, "session must be discoverable before subscribing");
        listener();
        return () => {};
      },
    },
    () => {
      published = true;
    },
    () => {
      cancelled = true;
      record.settled = true;
    },
  );
  assert.equal(bound, false);
  assert.equal(cancelled, true);
});

test("PCM chunks must be bounded valid base64 with whole 16-bit samples", () => {
  assert.deepEqual(
    decodePcm16Chunk(Buffer.from([0, 1, 2, 3]).toString("base64")),
    Buffer.from([0, 1, 2, 3]),
  );
  assert.throws(() => decodePcm16Chunk("%%%"), /valid base64/u);
  assert.throws(() => decodePcm16Chunk(Buffer.from([1]).toString("base64")), /16-bit/u);
  assert.throws(
    () => decodePcm16Chunk(Buffer.alloc(10).toString("base64"), 8),
    /too large|size limit/u,
  );
});
