import { routeLiveAudioOutput } from "./live-audio-devices";

export type DictationCue = "start" | "stop" | "success" | "error";

const CUES: Record<DictationCue, { frequency: number; durationMs: number; gain: number }> = {
  start: { frequency: 660, durationMs: 70, gain: 0.05 },
  stop: { frequency: 520, durationMs: 60, gain: 0.04 },
  success: { frequency: 784, durationMs: 90, gain: 0.05 },
  error: { frequency: 330, durationMs: 110, gain: 0.04 },
};

export function cueOscillatorConfig(kind: DictationCue) {
  return CUES[kind];
}

export async function playDictationCue(
  kind: DictationCue,
  contextCtor: typeof AudioContext = AudioContext,
): Promise<void> {
  return playTone(CUES[kind], contextCtor);
}

export function liveCueOscillatorConfig(kind: "connected" | "disconnected") {
  return kind === "connected"
    ? { frequency: 880, durationMs: 220, gain: 0.14 }
    : { frequency: 440, durationMs: 160, gain: 0.12 };
}

export async function playLiveConnectionCue(kind: "connected" | "disconnected", outputDeviceId = "default"): Promise<void> {
  return playTone(liveCueOscillatorConfig(kind), AudioContext, outputDeviceId);
}

async function playTone(
  spec: { frequency: number; durationMs: number; gain: number },
  contextCtor: typeof AudioContext,
  outputDeviceId = "default",
): Promise<void> {
  const context = new contextCtor();
  try {
    await routeLiveAudioOutput(context, outputDeviceId);
    if (context.state === "suspended") await context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = spec.frequency;
    gain.gain.setValueAtTime(0, context.currentTime);
    gain.gain.linearRampToValueAtTime(spec.gain, context.currentTime + 0.01);
    gain.gain.linearRampToValueAtTime(0, context.currentTime + spec.durationMs / 1000);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    await new Promise((resolve) => {
      globalThis.setTimeout(resolve, spec.durationMs);
    });
    oscillator.stop();
  } finally {
    await context.close().catch(() => {});
  }
}
