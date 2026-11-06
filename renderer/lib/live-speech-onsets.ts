// Where the user's speech began, measured at the microphone.
//
// A caption reaches the renderer only after Live has transcribed the audio,
// so the first caption of an utterance can arrive well after the person
// started talking. The voice-approval fence compares utterance start marks.
// So the Live hook stamps each utterance with the onset of the earliest
// speech that could belong to it, and uses the caption's arrival only when
// the microphone heard nothing.
//
// This fails closed. Speech under way when an approval arms keeps its
// earlier mark until a silence gap ends it. Any utterance whose first caption
// arrives while that speech, or speech that ended within the caption lag
// window, is still in reach takes that earlier mark too.
//
// Time is counted in captured audio. The microphone keeps sending packets,
// silence included (muted audio is zeros), for as long as Live runs.

/** Packet level (see measureGeminiLivePcmLevel) at which speech is assumed. */
export const LIVE_SPEECH_ONSET_LEVEL = 0.04;
/** Quiet this long ends a stretch of speech. */
export const LIVE_SPEECH_SILENCE_MS = 500;
/** How late a caption may arrive and still be traced to the speech before it. */
export const LIVE_SPEECH_CAPTION_LAG_MS = 5_000;

interface SpeechStretch {
  mark: number;
  /** Audio time the stretch went quiet; null while it goes on. */
  endedAt: number | null;
}

export class LiveSpeechOnsets {
  private audioMs = 0;
  private quietFrom: number | null = null;
  private stretches: SpeechStretch[] = [];

  /** `begin` takes a start mark on the shared counter (the session bus's). */
  constructor(private readonly begin: () => number) {}

  /** One microphone packet: its level and how many milliseconds of audio it carries. */
  packet(level: number, durationMs: number): void {
    const startedAt = this.audioMs;
    this.audioMs += Math.max(0, durationMs);
    const open = this.open();
    if (level >= LIVE_SPEECH_ONSET_LEVEL) {
      this.quietFrom = null;
      if (!open) this.stretches.push({ mark: this.begin(), endedAt: null });
    } else if (open) {
      this.quietFrom ??= startedAt;
      if (this.audioMs - this.quietFrom >= LIVE_SPEECH_SILENCE_MS) {
        open.endedAt = this.quietFrom;
        this.quietFrom = null;
      }
    }
    this.prune();
  }

  /**
   * The start mark for an utterance whose first caption arrives now: the
   * onset of the earliest speech still in reach, or null when the microphone
   * heard none.
   */
  claim(): number | null {
    this.prune();
    return this.stretches[0]?.mark ?? null;
  }

  /** Live stopped or the microphone was released. */
  reset(): void {
    this.audioMs = 0;
    this.quietFrom = null;
    this.stretches = [];
  }

  private open(): SpeechStretch | null {
    const last = this.stretches[this.stretches.length - 1];
    return last && last.endedAt === null ? last : null;
  }

  private prune(): void {
    this.stretches = this.stretches.filter(
      (stretch) => stretch.endedAt === null || this.audioMs - stretch.endedAt <= LIVE_SPEECH_CAPTION_LAG_MS,
    );
  }
}
