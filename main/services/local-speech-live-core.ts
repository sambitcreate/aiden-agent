// Live dictation text for on-device models fast enough to decode while the
// user speaks (Parakeet on Metal). The recorder streams 16 kHz PCM here as it
// captures; each session re-decodes the audio since the last pause, one
// decode at a time, and publishes the words so far. The text that is pasted
// still comes from one full decode after the user stops, so a preview only
// ever shows words early; it never decides them. Electron-free for tests.

export interface LiveTranscriptSnapshot {
  /** Words that held across two decodes, or that ended before a pause. */
  committed: string;
  /** The newest words, which the next decode may still change. */
  tentative: string;
}

export interface LivePreviewSessionOptions {
  /** One decode of 16 kHz mono PCM16; rejections end the preview. */
  decode: (pcm: Int16Array) => Promise<string>;
  publish: (snapshot: LiveTranscriptSnapshot) => void;
  onFailure?: (error: unknown) => void;
  now?: () => number;
  /** Runs `callback` after `ms`; returns a cancel function. */
  schedule?: (callback: () => void, ms: number) => () => void;
}

const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320; // 20 ms
/** Ten minutes, the same cap as a Gemini Live session. */
export const MAX_LIVE_PREVIEW_SAMPLES = SAMPLE_RATE * 600;
/** One push carries a few hundred milliseconds; ten seconds is a generous ceiling. */
export const MAX_LIVE_PREVIEW_PUSH_SAMPLES = SAMPLE_RATE * 10;
/** A new decode waits for at least this much new audio. */
const MIN_NEW_SAMPLES = SAMPLE_RATE * 0.3;
/** Decodes start no closer together than this, or 1.5× the last decode. */
const MIN_DECODE_INTERVAL_MS = 400;
/** 600 ms of quiet after speech ends a phrase; its text then stays put. */
const PAUSE_FRAMES = 30;
/** A phrase needs 200 ms of speech before a pause can end it. */
const MIN_SPEECH_FRAMES = 10;
/** Past 20 s without a pause, a phrase ends at its quietest recent frame. */
const MAX_WINDOW_SAMPLES = SAMPLE_RATE * 20;
const FORCED_CUT_SEARCH_FRAMES = 75; // 1.5 s
/** Below this RMS (about -40 dBFS) a frame is never speech. */
const MIN_SPEECH_RMS = 300;
/** The noise floor is the 10th-percentile frame energy of the last 5 s. */
const FLOOR_WINDOW_FRAMES = 250;
const FLOOR_PERCENTILE = 0.1;

function defaultSchedule(callback: () => void, ms: number): () => void {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
}

function words(text: string): string[] {
  return text.trim().split(/\s+/u).filter(Boolean);
}

/** Case and punctuation do not make a word unstable; the newest spelling is shown. */
function sameWord(left: string, right: string): boolean {
  const normalize = (word: string) => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  return normalize(left) === normalize(right);
}

/** The first index whose value is not below `value`. */
function sortedIndex(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function frameRms(samples: Int16Array, start: number): number {
  let sum = 0;
  for (let index = start; index < start + FRAME_SAMPLES; index += 1) sum += samples[index]! * samples[index]!;
  return Math.sqrt(sum / FRAME_SAMPLES);
}

export class LivePreviewSession {
  private samples = new Int16Array(SAMPLE_RATE * 10);
  private length = 0;
  /** Where the phrase being decoded starts; earlier audio is already committed. */
  private windowStart = 0;
  private readonly phrases: string[] = [];
  private hypothesis: string[] = [];
  private stableCount = 0;
  private decoding = false;
  private lastDecodeStartedAt = Number.NEGATIVE_INFINITY;
  private lastDecodeMs = 0;
  private decodedUpTo = 0;
  private cancelTimer: (() => void) | null = null;
  private stopped = false;
  private published: LiveTranscriptSnapshot = { committed: "", tentative: "" };
  // Pause detection over 20 ms frames.
  private frameCursor = 0;
  private readonly recentEnergy: number[] = [];
  private readonly sortedEnergy: number[] = [];
  private quietRun = 0;
  private speechFrames = 0;
  private readonly frameEnergy: number[] = [];
  private pendingCut: number | null = null;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, ms: number) => () => void;

  constructor(private readonly options: LivePreviewSessionOptions) {
    this.now = options.now ?? (() => performance.now());
    this.schedule = options.schedule ?? defaultSchedule;
  }

  /** Appends captured audio; audio past ten minutes is not previewed. */
  push(pcm: Int16Array): void {
    if (this.stopped || pcm.length === 0) return;
    const accepted = Math.min(pcm.length, MAX_LIVE_PREVIEW_SAMPLES - this.length);
    if (accepted <= 0) return;
    if (this.length + accepted > this.samples.length) {
      const grown = new Int16Array(Math.min(MAX_LIVE_PREVIEW_SAMPLES, Math.max(this.samples.length * 2, this.length + accepted)));
      grown.set(this.samples.subarray(0, this.length));
      this.samples = grown;
    }
    this.samples.set(pcm.subarray(0, accepted), this.length);
    this.length += accepted;
    this.detectPauses();
    this.pump();
  }

  /** Ends the preview; a decode already running finishes but publishes nothing. */
  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  get active(): boolean {
    return !this.stopped;
  }

  snapshot(): LiveTranscriptSnapshot {
    return { ...this.published };
  }

  private detectPauses(): void {
    while (this.frameCursor + FRAME_SAMPLES <= this.length) {
      const start = this.frameCursor;
      this.frameCursor += FRAME_SAMPLES;
      const rms = frameRms(this.samples, start);
      this.frameEnergy.push(rms);
      this.trackFloor(rms);
      const speech = this.isSpeech(rms);
      if (speech) {
        this.speechFrames += 1;
        this.quietRun = 0;
      } else {
        this.quietRun += 1;
      }
      if (this.pendingCut !== null) continue;
      if (this.quietRun === PAUSE_FRAMES && this.speechFrames >= MIN_SPEECH_FRAMES) {
        // End the phrase in the middle of the pause.
        this.cutAt(this.frameCursor - (PAUSE_FRAMES / 2) * FRAME_SAMPLES);
      } else if (this.frameCursor - this.windowStart >= MAX_WINDOW_SAMPLES) {
        this.cutAt(this.quietestRecentFrame());
      }
    }
  }

  /**
   * Speech always has quiet gaps between words, so a low percentile of recent
   * frame energy tracks the room's noise, steady fan noise included.
   */
  private trackFloor(rms: number): void {
    this.recentEnergy.push(rms);
    this.sortedEnergy.splice(sortedIndex(this.sortedEnergy, rms), 0, rms);
    if (this.recentEnergy.length > FLOOR_WINDOW_FRAMES) {
      const oldest = this.recentEnergy.shift()!;
      this.sortedEnergy.splice(sortedIndex(this.sortedEnergy, oldest), 1);
    }
  }

  private isSpeech(rms: number): boolean {
    const floor = this.sortedEnergy[Math.floor((this.sortedEnergy.length - 1) * FLOOR_PERCENTILE)] ?? 0;
    return rms > Math.max(MIN_SPEECH_RMS, floor * 3);
  }

  private cutAt(sample: number): void {
    this.pendingCut = Math.max(this.windowStart + FRAME_SAMPLES, sample);
    this.speechFrames = 0;
  }

  private quietestRecentFrame(): number {
    const last = this.frameEnergy.length - 1;
    const first = Math.max(0, last - FORCED_CUT_SEARCH_FRAMES);
    let quietest = last;
    for (let frame = last; frame >= first; frame -= 1) {
      if (this.frameEnergy[frame]! < this.frameEnergy[quietest]!) quietest = frame;
    }
    return quietest * FRAME_SAMPLES;
  }

  private pump(): void {
    if (this.stopped || this.decoding) return;
    if (this.pendingCut !== null) {
      this.decode(this.windowStart, this.pendingCut, true);
      return;
    }
    if (this.speechFrames === 0) return;
    if (this.length - this.decodedUpTo < MIN_NEW_SAMPLES) return;
    const wait = this.lastDecodeStartedAt + Math.max(MIN_DECODE_INTERVAL_MS, 1.5 * this.lastDecodeMs) - this.now();
    if (wait > 0) {
      this.cancelTimer ??= this.schedule(() => {
        this.cancelTimer = null;
        this.pump();
      }, wait);
      return;
    }
    this.decode(this.windowStart, this.length, false);
  }

  private decode(start: number, end: number, endsPhrase: boolean): void {
    this.decoding = true;
    const startedAt = this.now();
    this.lastDecodeStartedAt = startedAt;
    this.decodedUpTo = end;
    void this.options
      .decode(this.samples.slice(start, end))
      .then((text) => {
        if (this.stopped) return;
        this.lastDecodeMs = this.now() - startedAt;
        if (endsPhrase) this.endPhrase(end, text);
        else this.revise(text);
        this.publish();
      })
      .catch((error: unknown) => {
        if (this.stopped) return;
        this.stop();
        this.options.onFailure?.(error);
      })
      .finally(() => {
        this.decoding = false;
        this.pump();
      });
  }

  private revise(text: string): void {
    const next = words(text);
    let stable = 0;
    while (stable < next.length && stable < this.hypothesis.length && sameWord(next[stable]!, this.hypothesis[stable]!)) {
      stable += 1;
    }
    this.hypothesis = next;
    this.stableCount = stable;
  }

  private endPhrase(end: number, text: string): void {
    const phrase = text.trim();
    if (phrase) this.phrases.push(phrase);
    this.windowStart = end;
    this.decodedUpTo = Math.max(this.decodedUpTo, end);
    this.pendingCut = null;
    this.hypothesis = [];
    this.stableCount = 0;
    // Speech already heard after the cut belongs to the next phrase.
    this.speechFrames = this.countSpeechSince(end);
  }

  private countSpeechSince(sample: number): number {
    let count = 0;
    for (let frame = Math.floor(sample / FRAME_SAMPLES); frame < this.frameEnergy.length; frame += 1) {
      if (this.isSpeech(this.frameEnergy[frame]!)) count += 1;
    }
    return count;
  }

  private publish(): void {
    const committed = [...this.phrases, ...this.hypothesis.slice(0, this.stableCount)].join(" ");
    const tentative = this.hypothesis.slice(this.stableCount).join(" ");
    if (committed === this.published.committed && tentative === this.published.tentative) return;
    this.published = { committed, tentative };
    this.options.publish(this.snapshot());
  }
}

/** The renderer document a preview belongs to and publishes to. */
export interface LivePreviewOwner {
  id: number;
  documentId: string;
  send(channel: "voice:stream-text", payload: { sessionId: string } & LiveTranscriptSnapshot): void;
  onInvalidated(listener: () => void): () => void;
}

export interface LivePreviewManagerDeps {
  /** True when `modelId` is installed and fast enough to preview. */
  supportsLivePreview: (modelId: string) => boolean;
  decode: (pcm: Int16Array, modelId: string) => Promise<string>;
  newId: () => string;
  warn?: (message: string) => void;
  schedule?: LivePreviewSessionOptions["schedule"];
  now?: () => number;
}

interface ManagedSession {
  id: string;
  ownerKey: string;
  session: LivePreviewSession;
  removeInvalidation: () => void;
}

/** One live preview per renderer document: a new start or a final transcription ends the last one. */
export class LivePreviewManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly byOwner = new Map<string, string>();

  constructor(private readonly deps: LivePreviewManagerDeps) {}

  start(owner: LivePreviewOwner, modelId: string): { sessionId: string } | null {
    this.stopOwner(owner);
    if (!this.deps.supportsLivePreview(modelId)) return null;
    const id = this.deps.newId();
    const ownerKey = `${owner.id}:${owner.documentId}`;
    const session = new LivePreviewSession({
      decode: (pcm) => this.deps.decode(pcm, modelId),
      publish: (snapshot) => owner.send("voice:stream-text", { sessionId: id, ...snapshot }),
      onFailure: (error) => {
        this.deps.warn?.(`Live dictation text stopped: ${error instanceof Error ? error.message : String(error)}`);
        this.end(id);
      },
      schedule: this.deps.schedule,
      now: this.deps.now,
    });
    const removeInvalidation = owner.onInvalidated(() => this.end(id));
    this.sessions.set(id, { id, ownerKey, session, removeInvalidation });
    this.byOwner.set(ownerKey, id);
    return { sessionId: id };
  }

  /** Audio for a session this owner started; anything else is ignored. */
  push(owner: LivePreviewOwner, sessionId: string, pcm: Int16Array): void {
    const record = this.sessions.get(sessionId);
    if (!record || record.ownerKey !== `${owner.id}:${owner.documentId}`) return;
    record.session.push(pcm);
  }

  stop(owner: LivePreviewOwner, sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record?.ownerKey === `${owner.id}:${owner.documentId}`) this.end(sessionId);
  }

  /** The owner's final transcription is starting, so its preview must not queue another decode. */
  stopOwner(owner: LivePreviewOwner): void {
    const id = this.byOwner.get(`${owner.id}:${owner.documentId}`);
    if (id) this.end(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  private end(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    this.sessions.delete(sessionId);
    if (this.byOwner.get(record.ownerKey) === sessionId) this.byOwner.delete(record.ownerKey);
    record.session.stop();
    record.removeInvalidation();
  }
}
