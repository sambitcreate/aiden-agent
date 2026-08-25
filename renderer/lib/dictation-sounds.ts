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
  const spec = CUES[kind];
  const context = new contextCtor();
  try {
    if (context.state === "suspended") await context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = spec.frequency;
    gain.gain.value = spec.gain;
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
