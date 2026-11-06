import assert from "node:assert/strict";
import test from "node:test";
import { LiveSessionBus } from "./live-session-bus.js";
import {
  LIVE_SPEECH_CAPTION_LAG_MS,
  LIVE_SPEECH_FENCE_GUARD_MS,
  LIVE_SPEECH_SILENCE_MS,
  LiveSpeechOnsets,
} from "./live-speech-onsets.js";

const PACKET_MS = 20;
const SPEECH = 0.4;
const QUIET = 0.005;

function microphone() {
  const bus = new LiveSessionBus();
  const onsets = new LiveSpeechOnsets(() => bus.beginVoiceInput());
  bus.onVoiceInputFence((fence) => onsets.fenced(fence));
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

test("speech already given to a finished utterance never shadows the next one", () => {
  const { bus, onsets, play } = microphone();
  play(SPEECH, 300);
  play(QUIET, LIVE_SPEECH_SILENCE_MS + PACKET_MS);
  assert.ok(onsets.claim() !== null);
  onsets.retireFinished();
  // An approval arms well inside the caption lag window of that speech.
  const fence = bus.voiceInputFence();
  play(QUIET, LIVE_SPEECH_FENCE_GUARD_MS + PACKET_MS);
  play(SPEECH, 300);
  const next = onsets.claim();
  assert.ok(next !== null && next > fence, "fresh speech after the fence counts as fresh");
});

test("finishing an utterance keeps speech that is still going on before a fence", () => {
  const { bus, onsets, play } = microphone();
  play(SPEECH, 300);
  assert.ok(onsets.claim() !== null);
  onsets.retireFinished();
  const fence = bus.voiceInputFence();
  play(SPEECH, 300);
  const next = onsets.claim();
  assert.ok(next !== null && next <= fence, "the same unbroken speech began before the fence");
});

test("an utterance split by a pause retires both of its stretches", () => {
  const { bus, onsets, play } = microphone();
  play(SPEECH, 300);
  play(QUIET, LIVE_SPEECH_SILENCE_MS + PACKET_MS);
  assert.ok(onsets.claim() !== null);
  // The same sentence goes on after a pause long enough to end a stretch.
  play(SPEECH, 300);
  onsets.heard();
  play(QUIET, LIVE_SPEECH_SILENCE_MS + PACKET_MS);
  onsets.retireFinished();
  const fence = bus.voiceInputFence();
  play(QUIET, LIVE_SPEECH_FENCE_GUARD_MS + PACKET_MS);
  play(SPEECH, 300);
  const next = onsets.claim();
  assert.ok(next !== null && next > fence, "neither half of the finished sentence shadows the new answer");
});

test("fresh speech that has no caption yet survives an older utterance finishing", () => {
  const { bus, onsets, play } = microphone();
  // An older utterance is under way and captioned.
  play(SPEECH, 300);
  assert.ok(onsets.claim() !== null);
  const fence = bus.voiceInputFence();
  play(QUIET, LIVE_SPEECH_FENCE_GUARD_MS + PACKET_MS);
  // Fresh speech starts and ends; its caption has not arrived yet.
  play(SPEECH, 300);
  play(QUIET, LIVE_SPEECH_SILENCE_MS + PACKET_MS);
  // The older utterance finishes first.
  onsets.retireFinished();
  const next = onsets.claim();
  assert.ok(next !== null && next > fence, "the fresh answer keeps its own mark");
});

test("speech heard right after a fence counts as begun before it", () => {
  const { bus, onsets, play } = microphone();
  play(QUIET, 1_000);
  const fence = bus.voiceInputFence();
  // Audio captured before the fence can still be on its way to the renderer.
  play(SPEECH, 300);
  const early = onsets.claim();
  assert.ok(early !== null && early <= fence, "it may have been captured before the fence");
  play(QUIET, LIVE_SPEECH_SILENCE_MS + PACKET_MS);
  onsets.retireFinished();
  play(QUIET, LIVE_SPEECH_FENCE_GUARD_MS);
  play(SPEECH, 300);
  const later = onsets.claim();
  assert.ok(later !== null && later > fence, "speech once the guard has passed is fresh");
});

test("speech captured before a fence stays before it however long the backlog that delays it", () => {
  const bus = new LiveSessionBus();
  const onsets = new LiveSpeechOnsets(() => bus.beginVoiceInput());
  let captureClock = 10;
  bus.onVoiceInputFence((fence) => onsets.fenced(fence, captureClock));
  const play = (level: number, ms: number, capturedUntil: () => number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += PACKET_MS) onsets.packet(level, PACKET_MS, capturedUntil());
  };
  const fence = bus.voiceInputFence();
  // A second of audio captured before the fence is still queued for the
  // window, longer than the handled-audio guard, and ends in speech.
  play(QUIET, 1_000, () => captureClock - 0.5);
  play(SPEECH, 300, () => captureClock);
  const early = onsets.claim();
  assert.ok(early !== null && early <= fence, "captured before the fence");
  play(QUIET, LIVE_SPEECH_SILENCE_MS + PACKET_MS, () => captureClock);
  onsets.retireFinished();
  // Speech captured well after the fence is fresh.
  captureClock += 2;
  play(SPEECH, 300, () => captureClock);
  const fresh = onsets.claim();
  assert.ok(fresh !== null && fresh > fence, "captured after the fence");
});

test("with capture times, speech captured after a fence is fresh at once, even while a queue drains", () => {
  const bus = new LiveSessionBus();
  const onsets = new LiveSpeechOnsets(() => bus.beginVoiceInput());
  bus.onVoiceInputFence((fence) => onsets.fenced(fence, 20));
  const fence = bus.voiceInputFence();
  // Only 100 ms of audio has been handled since the fence, but this speech
  // was captured a second after it.
  for (let elapsed = 0; elapsed < 100; elapsed += PACKET_MS) onsets.packet(QUIET, PACKET_MS, 20.9);
  for (let elapsed = 0; elapsed < 300; elapsed += PACKET_MS) onsets.packet(SPEECH, PACKET_MS, 21);
  const mark = onsets.claim();
  assert.ok(mark !== null && mark > fence);
});

test("speech spoken before a fence but rendered just after it, by the microphone's latency, stays before it", () => {
  const bus = new LiveSessionBus();
  const onsets = new LiveSpeechOnsets(() => bus.beginVoiceInput());
  bus.onVoiceInputFence((fence) => onsets.fenced(fence, 10));
  const fence = bus.voiceInputFence();
  // The person spoke before the fence; the samples reached the render graph
  // 250 ms after it, so their render stamps are later than the fence.
  for (let elapsed = 0; elapsed < 300; elapsed += PACKET_MS) onsets.packet(SPEECH, PACKET_MS, 10.25);
  const mark = onsets.claim();
  assert.ok(mark !== null && mark <= fence);
});
