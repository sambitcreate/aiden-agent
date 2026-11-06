// Where the user's speech began, measured at the microphone.
//
// A caption reaches the renderer only after Live has transcribed the audio,
// so the first caption of an utterance can arrive well after the person
// started talking. The voice-approval fence compares utterance start marks.
// So the Live hook stamps each utterance with the onset of the earliest
// speech that could belong to it. When the microphone heard nothing in reach
// it uses LIVE_UNTRUSTED_VOICE_START, which no approval accepts.
//
// This fails closed. Speech under way when an approval arms keeps its
// earlier mark until a silence gap ends it. Any utterance whose first caption
// arrives while that speech, or speech that ended within the caption lag
// window, is still in reach takes that earlier mark too.
//
// A packet captured just before a fence can reach the renderer just after it,
// since microphone audio and the fence arrive on separate tasks. So speech
// that opens in the first LIVE_SPEECH_FENCE_GUARD_MS of audio handled after a
// fence takes a mark at that fence, never above it.
//
// Time is counted in captured audio. The microphone keeps sending packets,
// silence included (muted audio is zeros), for as long as Live runs.

/** Packet level (see measureGeminiLivePcmLevel) at which speech is assumed. */
export const LIVE_SPEECH_ONSET_LEVEL = 0.04;
/** Quiet this long ends a stretch of speech. */
export const LIVE_SPEECH_SILENCE_MS = 500;
/** How late a caption may arrive and still be traced to the speech before it. */
export const LIVE_SPEECH_CAPTION_LAG_MS = 5_000;
/** Audio handled after a fence during which a new stretch still counts as begun before it. */
export const LIVE_SPEECH_FENCE_GUARD_MS = 500;
/**
 * Start mark for an utterance whose onset the microphone cannot vouch for.
 * It is below every fence, so such speech never answers an approval.
 */
export const LIVE_UNTRUSTED_VOICE_START = 0;

interface SpeechStretch {
  mark: number;
  /** Audio time the stretch began. */
  startedAt: number;
  /** Audio time the stretch went quiet; null while it goes on. */
  endedAt: number | null;
}

export class LiveSpeechOnsets {
  private audioMs = 0;
  private quietFrom: number | null = null;
  private stretches: SpeechStretch[] = [];
  /** Audio time of the latest input caption: speech begun after it has no caption yet. */
  private heardThrough = -1;
  /** Newest fence taken, and the audio time until which new speech still sits at it. */
  private guardMark = 0;
  private guardUntil = -1;

  /** `begin` takes a start mark on the shared counter (the session bus's). */
  constructor(private readonly begin: () => number) {}

  /** One microphone packet: its level and how many milliseconds of audio it carries. */
  packet(level: number, durationMs: number): void {
    const startedAt = this.audioMs;
    this.audioMs += Math.max(0, durationMs);
    const open = this.open();
    if (level >= LIVE_SPEECH_ONSET_LEVEL) {
      this.quietFrom = null;
      if (!open) {
        const mark = startedAt < this.guardUntil ? this.guardMark : this.begin();
        this.stretches.push({ mark, startedAt, endedAt: null });
      }
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
    this.heard();
    this.prune();
    return this.stretches[0]?.mark ?? null;
  }

  /** An input caption arrived: the speech heard so far may be in it. */
  heard(): void {
    this.heardThrough = this.audioMs;
  }

  /**
   * A fence was taken (`LiveSessionBus.voiceInputFence`). Packets handled
   * from now on may have been captured before it, so speech that opens in
   * the next LIVE_SPEECH_FENCE_GUARD_MS of audio gets a mark at the fence.
   */
  fenced(fence: number): void {
    this.guardMark = Math.max(this.guardMark, fence);
    this.guardUntil = this.audioMs + LIVE_SPEECH_FENCE_GUARD_MS;
  }

  /**
   * An utterance was finished and published. Every stretch that had ended and
   * began before its latest caption belongs to it (or an earlier one),
   * however many pauses split it, and must not shadow the next utterance.
   * A stretch still going on is kept, since more captions may follow from the
   * same speech. So is one that began after that caption: no caption has
   * covered it yet, so it is the start of the next utterance.
   */
  retireFinished(): void {
    this.stretches = this.stretches.filter(
      (stretch) => stretch.endedAt === null || stretch.startedAt > this.heardThrough,
    );
  }

  /** Live stopped or the microphone was released. */
  reset(): void {
    this.audioMs = 0;
    this.quietFrom = null;
    this.stretches = [];
    this.heardThrough = -1;
    this.guardMark = 0;
    this.guardUntil = -1;
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
