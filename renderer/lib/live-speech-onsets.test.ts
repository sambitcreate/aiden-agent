import assert from "node:assert/strict";
import test from "node:test";
import { LiveSessionBus } from "./live-session-bus.js";
import { LIVE_SPEECH_CAPTION_LAG_MS, LIVE_SPEECH_SILENCE_MS, LiveSpeechOnsets } from "./live-speech-onsets.js";

const PACKET_MS = 20;
const SPEECH = 0.4;
const QUIET = 0.005;

function microphone() {
  const bus = new LiveSessionBus();
  const onsets = new LiveSpeechOnsets(() => bus.beginVoiceInput());
  const play = (level: number, ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += PACKET_MS) onsets.packet(level, PACKET_MS);
  };
  return { bus, onsets, play };
}

test("speech that began before a fence keeps its earlier mark when its first caption arrives after", () => {
  const { bus, onsets, play } = microphone();
  play(SPEECH, 400);
  const fence = bus.voiceInputFence();
  play(QUIET, 1_200);
  const mark = onsets.claim();
  assert.ok(mark !== null && mark <= fence, "the caption is late, the speech was not");
});

test("speech still going on at a fence stays before it until a silence gap ends it", () => {
  const { bus, onsets, play } = microphone();
  play(SPEECH, 200);
  const fence = bus.voiceInputFence();
  // Short pauses between words do not end the stretch.
  play(QUIET, LIVE_SPEECH_SILENCE_MS - 2 * PACKET_MS);
  play(SPEECH, 300);
  const mark = onsets.claim();
  assert.ok(mark !== null && mark <= fence);
});

test("speech that starts after a fence and a silence gap gets a later mark once the old speech is out of reach", () => {
  const { bus, onsets, play } = microphone();
  play(SPEECH, 300);
  const fence = bus.voiceInputFence();
  play(QUIET, LIVE_SPEECH_SILENCE_MS + LIVE_SPEECH_CAPTION_LAG_MS + PACKET_MS);
  play(SPEECH, 300);
  const mark = onsets.claim();
  assert.ok(mark !== null && mark > fence);
});

test("a caption with no speech heard leaves the mark to the caption itself", () => {
  const { onsets, play } = microphone();
  play(QUIET, 2_000);
  assert.equal(onsets.claim(), null);
  play(SPEECH, 100);
  onsets.reset();
  assert.equal(onsets.claim(), null, "a stopped microphone forgets what it heard");
});
