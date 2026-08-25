export const SILENCE_HANGOVER_MS = 450;
export const SILENCE_MIN_SPEECH_MS = 180;
export const SILENCE_ARM_MS = 400;
export const SILENCE_RMS_THRESHOLD = 0.045;

export function analyserRms(values: ArrayLike<number>): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const normalized = ((values[i] ?? 128) - 128) / 128;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / values.length);
}

export class SilenceStopDetector {
  private startedAt = 0;
  private lastSpeechAt = 0;
  private heardSpeech = false;
  private fired = false;

  constructor(
    private readonly onSilence: () => void,
    private readonly now: () => number = () => Date.now(),
    private readonly hangoverMs: number = SILENCE_HANGOVER_MS,
    private readonly threshold: number = SILENCE_RMS_THRESHOLD,
  ) {}

  reset(now = this.now()): void {
    this.startedAt = now;
    this.lastSpeechAt = 0;
    this.heardSpeech = false;
    this.fired = false;
  }

  sample(rms: number, now = this.now()): void {
    if (this.fired) return;
    if (this.startedAt === 0) this.reset(now);
    if (now - this.startedAt < SILENCE_ARM_MS) return;
    if (rms >= this.threshold) {
      this.heardSpeech = true;
      this.lastSpeechAt = now;
      return;
    }
    if (!this.heardSpeech) return;
    if (now - this.lastSpeechAt < this.hangoverMs) return;
    if (this.lastSpeechAt - this.startedAt < SILENCE_MIN_SPEECH_MS) return;
    this.fired = true;
    this.onSilence();
  }
}
