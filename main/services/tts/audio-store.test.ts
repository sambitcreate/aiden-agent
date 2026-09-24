import assert from "node:assert/strict";
import test from "node:test";
import { TtsAudioStore } from "./audio-store.js";
import { TTS_LIMITS } from "../../../renderer/shared/tts.js";

const audio = (size = TTS_LIMITS.segmentAudioMaxBytes) => ({
  bytes: new Uint8Array(size),
  mimeType: "audio/wav" as const,
  sampleRate: 24000,
  channels: 1,
});

test("partial and out-of-order reads never make unread audio evictable", () => {
  const store = new TtsAudioStore();
  for (let segment = 0; segment < 4; segment += 1) store.put("job", segment, audio());
  store.read("job", 0, 0, TTS_LIMITS.audioReadMaxBytes);
  store.read("job", 1, TTS_LIMITS.segmentAudioMaxBytes - 10, 10);
  assert.throws(() => store.put("job", 4, audio()), /audio_buffer_limit/u);
  assert.equal(store.retainedBytes, TTS_LIMITS.sessionAudioMaxBytes);
  for (let segment = 0; segment < 4; segment += 1) assert.ok(store.has("job", segment));
  let offset = 0;
  while (offset < TTS_LIMITS.segmentAudioMaxBytes) {
    offset = store.read("job", 0, offset, TTS_LIMITS.audioReadMaxBytes)!.nextOffset;
  }
  store.put("job", 4, audio());
  assert.equal(store.has("job", 0), false);
  assert.equal(store.has("job", 1), true);
  assert.equal(store.retainedBytes, TTS_LIMITS.sessionAudioMaxBytes);
});

test("failed replacement is atomic and repeated release cannot corrupt accounting", () => {
  const store = new TtsAudioStore();
  store.put("job", 0, audio(1));
  for (let segment = 1; segment < 5; segment += 1)
    store.put("job", segment, audio(TTS_LIMITS.segmentAudioMaxBytes - 1));
  const before = store.retainedBytes;
  assert.throws(() => store.put("job", 0, audio()), /audio_buffer_limit/u);
  assert.equal(store.read("job", 0, 0, 100)!.segmentBytes, 1);
  assert.equal(store.retainedBytes, before);
  store.releaseJob("job");
  store.releaseJob("job");
  assert.equal(store.retainedBytes, 0);
});

test("reads reject non-progressing or invalid offsets and return independent bounded bytes", () => {
  const store = new TtsAudioStore();
  store.put("job", 0, audio(100));
  for (const offset of [-1, NaN, Infinity, 0.5])
    assert.equal(store.read("job", 0, offset, 64), null);
  for (const size of [-1, 0, NaN, Infinity, 0.5]) assert.equal(store.read("job", 0, 0, size), null);
  const read = store.read("job", 0, 0, 1)!;
  read.bytes[0] = 42;
  assert.equal(store.read("job", 0, 0, 1)!.bytes[0], 0);
});
