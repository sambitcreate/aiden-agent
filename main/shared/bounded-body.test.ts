import assert from "node:assert/strict";
import test from "node:test";
import { readBoundedBody, type BoundedBodyErrors } from "./bounded-body.js";

class TooLarge extends Error {}
class Missing extends Error {}
class BadChunk extends Error {}
const errors: BoundedBodyErrors = {
  tooLarge: () => new TooLarge("too large"),
  missingBody: () => new Missing("missing"),
  invalidChunk: () => new BadChunk("bad chunk"),
};

function streamOf(chunks: unknown[], observed: { cancelled: boolean; pulls: number }) {
  return new ReadableStream({
    pull(controller) {
      observed.pulls += 1;
      const next = chunks.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
    cancel() {
      observed.cancelled = true;
    },
  }, { highWaterMark: 0 });
}

// A bare response shape hands the stream through untouched, the way a
// non-undici fetch implementation or a test double can.
function responseOf(body: ReadableStream | null, headers: Record<string, string> = {}): Response {
  return { headers: new Headers(headers), body } as unknown as Response;
}

test("reads chunked bodies up to and including the byte limit", async () => {
  const observed = { cancelled: false, pulls: 0 };
  const bytes = await readBoundedBody(
    responseOf(streamOf([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])], observed)),
    { maxBytes: 5, errors },
  );
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5]);
  assert.equal(observed.cancelled, false);
});

test("rejects an oversized declared length before reading and cancels the body", async () => {
  const observed = { cancelled: false, pulls: 0 };
  const response = responseOf(streamOf([new Uint8Array(1)], observed), { "content-length": "1000000" });
  await assert.rejects(readBoundedBody(response, { maxBytes: 10, errors }), TooLarge);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed.cancelled, true);
});

test("rejects a body that streams past the limit despite a small declared length", async () => {
  const observed = { cancelled: false, pulls: 0 };
  const response = responseOf(
    streamOf([new Uint8Array(6), new Uint8Array(6), new Uint8Array(6)], observed),
    { "content-length": "4" },
  );
  await assert.rejects(readBoundedBody(response, { maxBytes: 10, errors }), TooLarge);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed.cancelled, true);
  assert.ok(observed.pulls < 4, "reader stopped pulling after the limit");
});

test("rejects non-byte chunks and cancels the source", async () => {
  const observed = { cancelled: false, pulls: 0 };
  const response = responseOf(streamOf(["not bytes", new Uint8Array(1)], observed));
  await assert.rejects(readBoundedBody(response, { maxBytes: 10, errors }), BadChunk);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed.cancelled, true);
});

test("a missing body is an error only when the caller requires one", async () => {
  await assert.rejects(readBoundedBody(responseOf(null), { maxBytes: 10, errors }), Missing);
  const empty = await readBoundedBody(responseOf(null), {
    maxBytes: 10,
    errors: { tooLarge: errors.tooLarge },
  });
  assert.equal(empty.byteLength, 0);
});

test("caller abort settles a stalled read and cancels the source", async () => {
  let cancelled = false;
  const stalled = new ReadableStream({
    pull: () => new Promise(() => undefined),
    cancel() {
      cancelled = true;
    },
  });
  const controller = new AbortController();
  const reason = new Error("caller gave up");
  const reading = readBoundedBody(responseOf(stalled), {
    maxBytes: 10,
    signal: controller.signal,
    errors,
  });
  setImmediate(() => controller.abort(reason));
  await assert.rejects(reading, (error) => error === reason);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);


  const already = new AbortController();
  already.abort();
  const untouched = { cancelled: false, pulls: 0 };
  await assert.rejects(
    readBoundedBody(responseOf(streamOf([new Uint8Array(1)], untouched)), {
      maxBytes: 10,
      signal: already.signal,
      errors: { ...errors, aborted: () => new Error("custom abort") },
    }),
    /custom abort/,
  );
  assert.equal(untouched.pulls, 0, "an already-aborted read never pulls the source");
});
