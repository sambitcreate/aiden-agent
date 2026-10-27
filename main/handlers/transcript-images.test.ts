import assert from "node:assert/strict";
import test from "node:test";
import { registerTranscriptImageHandlers } from "./transcript-images.js";

const image = { mimeType: "image/png" as const, data: "verified", width: 1, height: 1 };
function setup(fetch: (url: unknown, options: { signal: AbortSignal }) => Promise<typeof image>) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const listeners = new Set<() => void>();
  let invalid = false;
  registerTranscriptImageHandlers({ handle: (channel, handler) => handlers.set(channel, handler),
    owner: (event) => { if (event !== "active") throw new Error("Foreign sender"); return {
      id: 1, documentId: "doc-1", isDestroyed: () => invalid,
      onInvalidated: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    }; }, fetch });
  return { invoke: (url: unknown, event = "active") => Promise.resolve(handlers.get("chat:loadTranscriptImage")!(event, url)),
    invalidate: () => { invalid = true; for (const listener of listeners) listener(); }, listeners };
}

test("image IPC refuses foreign/stale documents and revokes pending work on reload", async () => {
  let attempts = 0;
  const immediate = setup(async () => { attempts++; return image; });
  await assert.rejects(immediate.invoke("https://example.test/i", "foreign"), /Foreign/u);
  immediate.invalidate();
  await assert.rejects(immediate.invoke("https://example.test/i"), /no longer active/u);
  assert.equal(attempts, 0);
  let signal: AbortSignal | undefined;
  let finish!: (value: typeof image) => void;
  const pending = setup(async (_url, options) => { signal = options.signal; return new Promise((resolve) => { finish = resolve; }); });
  const result = pending.invoke("https://example.test/i");
  pending.invalidate(); assert.equal(signal?.aborted, true);
  finish(image); await assert.rejects(result, /no longer active/u);
  assert.equal(pending.listeners.size, 0);
});

test("image IPC bounds simultaneous requests and releases slots after completion", async () => {
  const finish: Array<(value: typeof image) => void> = [];
  const fixture = setup(async () => new Promise((resolve) => { finish.push(resolve); }));
  const pending = Array.from({ length: 4 }, () => fixture.invoke("https://example.test/i"));
  await assert.rejects(fixture.invoke("https://example.test/extra"), /Wait for/u);
  for (const done of finish.splice(0)) done(image);
  assert.deepEqual(await Promise.all(pending), [image, image, image, image]);
  const next = fixture.invoke("https://example.test/next"); finish[0]!(image);
  assert.deepEqual(await next, image);
  assert.equal(fixture.listeners.size, 0);
});
