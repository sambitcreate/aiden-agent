import assert from "node:assert/strict";
import test from "node:test";
import { captureLiveMicrophone, readLiveAudioDevices, saveLiveAudioDevices, routeLiveAudioOutput, LiveAudioDeviceError } from "./live-audio-devices.js";

test("Live device preferences persist locally and tolerate invalid storage", () => {
  let saved: string | null = null;
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
  assert.deepEqual(readLiveAudioDevices(storage), { input: "default", output: "default" });
  saveLiveAudioDevices({ input: "mic-1", output: "speaker-1" }, storage);
  assert.deepEqual(readLiveAudioDevices(storage), { input: "mic-1", output: "speaker-1" });
  saved = "broken";
  assert.deepEqual(readLiveAudioDevices(storage), { input: "default", output: "default" });
  saved = '{"input":false,"output":""}';
  assert.deepEqual(readLiveAudioDevices(storage), { input: "default", output: "default" });
  assert.throws(() => saveLiveAudioDevices({ input: "default", output: "default" }, { setItem: () => { throw new Error("full"); } }));
});

test("Live microphone capture uses exact selected input, not silent fallback", async () => {
  const constraints: MediaStreamConstraints[] = [];
  const media = { getUserMedia: async (value: MediaStreamConstraints) => { constraints.push(value); return {} as MediaStream; } };
  await captureLiveMicrophone("mic-1", media);
  assert.deepEqual((constraints[0].audio as MediaTrackConstraints).deviceId, { exact: "mic-1" });
  await captureLiveMicrophone("default", media);
  assert.equal((constraints[1].audio as MediaTrackConstraints).deviceId, undefined);
  const missing = Object.assign(new Error("missing"), { name: "OverconstrainedError" });
  await assert.rejects(captureLiveMicrophone("gone", { getUserMedia: async () => { throw missing; } }), LiveAudioDeviceError);
  const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
  await assert.rejects(captureLiveMicrophone("mic", { getUserMedia: async () => { throw denied; } }), (error) => error === denied);
});

test("Live output routes explicitly and rejects unavailable or unsupported sinks", async () => {
  const calls: string[] = [];
  const context = { setSinkId: async (id: string) => { calls.push(id); } } as unknown as AudioContext;
  await routeLiveAudioOutput(context, "default");
  assert.deepEqual(calls, []);
  await routeLiveAudioOutput(context, "speaker-1");
  assert.deepEqual(calls, ["speaker-1"]);
  await assert.rejects(routeLiveAudioOutput({} as AudioContext, "speaker"), LiveAudioDeviceError);
  await assert.rejects(routeLiveAudioOutput({ setSinkId: async () => { throw new Error("missing"); } } as unknown as AudioContext, "speaker"), LiveAudioDeviceError);
});
import { cueOscillatorConfig, liveCueOscillatorConfig } from "./dictation-sounds.js";

test("Live connection cues are distinct and more audible than dictation ticks", () => {
  const start = liveCueOscillatorConfig("connected");
  const stop = liveCueOscillatorConfig("disconnected");
  assert.ok(start.frequency > stop.frequency);
  assert.ok(start.durationMs > cueOscillatorConfig("success").durationMs);
  assert.ok(stop.durationMs > cueOscillatorConfig("stop").durationMs);
  assert.ok(start.gain <= 0.15 && stop.gain <= 0.15);
});

test("dictation cues stay short and quiet", () => {
  for (const kind of ["start", "stop", "success", "error"] as const) {
    const cue = cueOscillatorConfig(kind);
    assert.ok(cue.durationMs <= 120);
    assert.ok(cue.gain <= 0.08);
    assert.ok(cue.frequency > 200);
  }
});
