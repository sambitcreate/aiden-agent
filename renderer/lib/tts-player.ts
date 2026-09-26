// Read-aloud playback: lossless scheduling of decoded WAV segments through Web
// Audio. Pause suspends the audio context (sample-exact), never regenerates,
// and never drops buffered audio. Stop tears everything down.

export interface TtsPlayerProgress {
  /** Segments whose audio has finished playing locally. */
  playedSegments: number;
  playing: boolean;
}

const WARM_BUFFER_SECONDS = 0.08;

export class TtsPlayer {
  private context: AudioContext | null = null;
  private scheduledSources: AudioBufferSourceNode[] = [];
  private nextStartTime = 0;
  private playedSegments = 0;
  private playing = false;
  private onEndedSegment: ((index: number) => void) | null = null;
  private stopped = false;
  private paused = false;

  constructor(options: { onSegmentEnded?: (index: number) => void } = {}) {
    this.onEndedSegment = options.onSegmentEnded ?? null;
  }

  /** Must be called from a user gesture before awaiting network work. */
  async prime(): Promise<void> {
    if (this.stopped) return;
    if (!this.context) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error("Audio playback is unavailable in this window.");
      this.context = new Ctor();
    }
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get segmentsPlayed(): number {
    return this.playedSegments;
  }

  /**
   * Schedule one decoded segment after any already-scheduled audio. Returns
   * the index it was scheduled at. Decoding happens on raw WAV bytes.
   */
  async playSegment(index: number, wavBytes: Uint8Array): Promise<void> {
    if (this.stopped) return;
    // Only prime/resume may unsuspend audio. A late segment must not undo Pause.
    const context = this.context;
    if (!context) throw new Error("Audio playback is unavailable in this window.");
    const buffer = await context.decodeAudioData(wavBytes.slice().buffer);
    if (this.stopped) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + WARM_BUFFER_SECONDS, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this.scheduledSources.push(source);
    this.playing = !this.paused;
    source.onended = () => {
      if (this.stopped || this.context !== context) return;
      source.disconnect();
      this.scheduledSources = this.scheduledSources.filter((entry) => entry !== source);
      this.playedSegments = Math.max(this.playedSegments, index + 1);
      this.playing = !this.paused && this.scheduledSources.length > 0;
      this.onEndedSegment?.(index);
    };
  }

  /** Local, sample-exact pause: suspends the graph without dropping buffers. */
  async pause(): Promise<void> {
    this.paused = true;
    this.playing = false;
    if (this.context?.state === "running") {
      await this.context.suspend();
    }
    this.playing = false;
  }

  async resume(): Promise<void> {
    if (this.stopped) return;
    if (this.context?.state === "suspended") {
      await this.context.resume();
    }
    if (this.stopped) return;
    this.paused = false;
    this.playing = this.scheduledSources.length > 0;
  }

  /** Full teardown. Safe to call repeatedly and after every terminal phase. */
  stop(): void {
    this.stopped = true;
    for (const source of this.scheduledSources) {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch {
        // A source that never started or already ended is fine.
      }
    }
    this.scheduledSources = [];
    this.nextStartTime = 0;
    this.playedSegments = 0;
    this.playing = false;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
  }
}
