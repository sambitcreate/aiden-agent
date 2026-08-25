import assert from "node:assert/strict";
import test from "node:test";
import {
  AIDEN_REMOTE_MAX_PCM16_BASE64_LENGTH,
  AIDEN_REMOTE_MAX_PCM16_BYTES,
  AIDEN_REMOTE_MAX_SPEECH_SECONDS,
  AIDEN_REMOTE_MAX_SPEECH_REQUEST_BYTES,
  AIDEN_REMOTE_SPEECH_SAMPLE_RATE,
  decodeAidenRemotePcm16,
} from "./aiden-remote-speech-codec.js";
import { AidenRemoteSpeechLane } from "./aiden-remote-speech-lane.js";

test("remote speech PCM codec validates base64 and converts signed little-endian samples", () => {
  const bytes = Buffer.alloc(6);
  bytes.writeInt16LE(-32_768, 0);
  bytes.writeInt16LE(0, 2);
  bytes.writeInt16LE(32_767, 4);
  const samples = decodeAidenRemotePcm16(bytes.toString("base64"));
  assert.equal(samples.length, 3);
  assert.equal(samples[0], -1);
  assert.equal(samples[1], 0);
  assert.ok(samples[2]! > 0.999);
  assert.throws(() => decodeAidenRemotePcm16("not base64"), /valid base64/u);
  assert.throws(() => decodeAidenRemotePcm16(Buffer.from([1]).toString("base64")), /16-bit mono/u);
});

test("remote speech accepts the advertised 60-second PCM limit and rejects the next sample", () => {
  const maximumPcm = Buffer.alloc(AIDEN_REMOTE_MAX_PCM16_BYTES);
  const maximumBase64 = maximumPcm.toString("base64");
  assert.equal(
    AIDEN_REMOTE_MAX_PCM16_BYTES,
    AIDEN_REMOTE_SPEECH_SAMPLE_RATE * 2 * AIDEN_REMOTE_MAX_SPEECH_SECONDS,
  );
  assert.equal(maximumBase64.length, AIDEN_REMOTE_MAX_PCM16_BASE64_LENGTH);
  assert.equal(decodeAidenRemotePcm16(maximumBase64).length, AIDEN_REMOTE_MAX_PCM16_BYTES / 2);
  assert.throws(
    () => decodeAidenRemotePcm16(Buffer.alloc(AIDEN_REMOTE_MAX_PCM16_BYTES + 2).toString("base64")),
    (error: unknown) =>
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "payload_too_large",
  );

  const maximumRequest = JSON.stringify({
    encoding: "pcm_s16le",
    sampleRate: AIDEN_REMOTE_SPEECH_SAMPLE_RATE,
    channels: 1,
    pcmBase64: maximumBase64,
    modelId: "parakeet-v3",
  });
  assert.ok(Buffer.byteLength(maximumRequest, "utf8") <= AIDEN_REMOTE_MAX_SPEECH_REQUEST_BYTES);
});

test("remote speech lane serializes work, bounds admission, and recovers after failure", async () => {
  const lane = new AidenRemoteSpeechLane(2);
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const order: string[] = [];
  const first = lane.run(async () => {
    order.push("first:start");
    await firstGate;
    order.push("first:fail");
    throw new Error("expected failure");
  });
  const second = lane.run(async () => {
    order.push("second:start");
    return "second result";
  });
  await assert.rejects(
    lane.run(() => "must not start"),
    (error: unknown) =>
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "rate_limited",
  );
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  await assert.rejects(first, /expected failure/u);
  assert.equal(await second, "second result");
  assert.deepEqual(order, ["first:start", "first:fail", "second:start"]);
  assert.equal(await lane.run(() => "recovered"), "recovered");
});
