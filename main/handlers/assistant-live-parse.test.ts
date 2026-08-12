import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAssistantLiveAudioIntent,
  parseAssistantLiveStartIntent,
  parseAssistantLiveStopIntent,
} from "./assistant-live-parse.js";

test("Assistant Live audio admission accepts only one exact 20 ms PCM chunk", () => {
  const pcm = new Uint8Array(640);
  const parsed = parseAssistantLiveAudioIntent({ sessionId: "session-1", pcm });
  assert.equal(parsed.sessionId, "session-1");
  assert.deepEqual(parsed.pcm, pcm);
  assert.notEqual(parsed.pcm, pcm);
  for (const value of [
    { sessionId: "session-1", pcm: new Uint8Array(638) },
    { sessionId: "", pcm },
    { sessionId: "session-1", pcm: pcm.buffer },
    { sessionId: "session-1", pcm, apiKey: "secret" },
  ]) assert.throws(() => parseAssistantLiveAudioIntent(value), /audio request/u);
});

test("Assistant Live start intent is an exact boolean-only record", () => {
  assert.deepEqual(parseAssistantLiveStartIntent({ chatId: "assistant-1", microphone: true, screen: false }), {
    chatId: "assistant-1",
    microphone: true,
    screen: false,
  });
  for (const value of [
    null,
    {},
    { chatId: null, microphone: true },
    { chatId: null, microphone: true, screen: false, apiKey: "secret" },
    { chatId: null, microphone: 1, screen: false },
    { chatId: null, microphone: false, screen: new Uint8Array([1]) },
    { chatId: "", microphone: true, screen: false },
  ]) {
    assert.throws(() => parseAssistantLiveStartIntent(value), /Invalid Assistant Live/u);
  }
});

test("Assistant Live stop intent accepts only an exact empty record", () => {
  assert.doesNotThrow(() => parseAssistantLiveStopIntent({}));
  assert.throws(() => parseAssistantLiveStopIntent(undefined), /Invalid Assistant Live/u);
  assert.throws(
    () => parseAssistantLiveStopIntent({ sessionId: "forged" }),
    /Invalid Assistant Live/u,
  );
});
