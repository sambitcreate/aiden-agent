// Pitch-preserving speed change for Aiden Live's spoken replies (WSOLA:
// waveform-similarity overlap-add). Live streams 24 kHz mono audio in chunks,
// so the stretcher keeps a little input between chunks and joins frames where
// the waveforms line up, which avoids the "chipmunk" pitch of a faster
// playback rate. At 1× it is a plain passthrough.

/** Frame of 30 ms at 24 kHz, half-overlapped. */
const DEFAULT_FRAME = 720;
/** How far a frame may slide to line up with the previous one (5 ms). */
const DEFAULT_SEEK = 120;

export interface LiveTimeStretchOptions {
  frameSize?: number;
  seekRange?: number;
}

type Samples = Float32Array<ArrayBuffer>;

function concat(parts: readonly Float32Array[]): Samples {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export class LiveTimeStretcher {
  private readonly frame: number;
  private readonly hop: number;
  private readonly seek: number;
  private readonly window: Float32Array;
  private speedValue = 1;
  /** Input not yet consumed; buffer[0] is absolute input sample `bufferStart`. */
  private buffer: Samples = new Float32Array(0);
  private bufferStart = 0;
  /** Absolute input position of the next nominal analysis frame. */
  private nextAnalysis = 0;
  /** Absolute start of the last frame used, or null before the first. */
  private previousStart: number | null = null;
  /** Falling half of the last windowed frame, waiting to be overlap-added. */
  private tail: Samples = new Float32Array(0);

  constructor(options: LiveTimeStretchOptions = {}) {
    const frame = options.frameSize ?? DEFAULT_FRAME;
    if (!Number.isInteger(frame) || frame < 16 || frame % 2 !== 0) {
      throw new Error("Time-stretch frames must be an even number of samples.");
    }
    this.frame = frame;
    this.hop = frame / 2;
    this.seek = Math.max(0, Math.min(options.seekRange ?? DEFAULT_SEEK, this.hop));
    // A periodic Hann window: two copies shifted by half a frame sum to one.
    this.window = Float32Array.from({ length: frame }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / frame));
  }

  get speed(): number {
    return this.speedValue;
  }

  /** Changes speed from the next frame on; the stream stays continuous. */
  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) throw new Error("Speed must be a positive number.");
    this.speedValue = speed;
  }

  /** True while input or an unfinished frame is held back. */
  get pending(): boolean {
    return this.buffer.length > 0 || this.tail.length > 0;
  }

  /**
   * Stretches one chunk. Output length is about input / speed over a stream;
   * a little audio is held back until the next chunk or {@link drain}.
   */
  process(input: Float32Array): Samples {
    if (this.speedValue === 1 && !this.pending) return Float32Array.from(input);
    this.append(input);
    if (this.speedValue === 1) return this.drain();
    const out: Samples[] = [];
    const analysisHop = this.hop * this.speedValue;
    for (;;) {
      const nominal = Math.round(this.nextAnalysis);
      if (nominal + this.seek + this.frame > this.bufferStart + this.buffer.length) break;
      const start = this.previousStart === null ? nominal : this.bestStart(nominal, this.previousStart + this.hop);
      const head = new Float32Array(this.hop);
      const nextTail = new Float32Array(this.hop);
      const base = start - this.bufferStart;
      for (let n = 0; n < this.hop; n += 1) {
        // The very first frame is not faded in: speech starts at full level.
        const rising = this.previousStart === null ? this.buffer[base + n]! : this.buffer[base + n]! * this.window[n]!;
        head[n] = rising + (this.tail[n] ?? 0);
        nextTail[n] = this.buffer[base + this.hop + n]! * this.window[this.hop + n]!;
      }
      out.push(head);
      this.tail = nextTail;
      this.previousStart = start;
      this.nextAnalysis += analysisHop;
    }
    this.trim();
    return concat(out);
  }

  /**
   * Emits everything held back, unstretched, and starts a new stream. Call it
   * when the reply ends or the speed returns to 1×.
   */
  drain(): Samples {
    const parts: Samples[] = [];
    if (this.previousStart === null) {
      parts.push(this.buffer.slice(Math.max(0, Math.round(this.nextAnalysis) - this.bufferStart)));
    } else {
      // The last frame's falling half fades out exactly where its natural
      // continuation fades in, so the rest of the input joins without a click.
      const from = this.previousStart + this.hop - this.bufferStart;
      const rest = this.buffer.slice(Math.max(0, from));
      const joined = new Float32Array(Math.max(rest.length, this.tail.length));
      for (let n = 0; n < joined.length; n += 1) {
        const fadeIn = n < this.hop ? this.window[n]! : 1;
        joined[n] = (rest[n] ?? 0) * fadeIn + (this.tail[n] ?? 0);
      }
      parts.push(joined);
    }
    this.reset();
    return concat(parts);
  }

  /** Drops everything held back, for a barge-in flush. */
  reset(): void {
    this.buffer = new Float32Array(0);
    this.bufferStart = 0;
    this.nextAnalysis = 0;
    this.previousStart = null;
    this.tail = new Float32Array(0);
  }

  private append(input: Float32Array): void {
    if (input.length === 0) return;
    const next = new Float32Array(this.buffer.length + input.length);
    next.set(this.buffer, 0);
    next.set(input, this.buffer.length);
    this.buffer = next;
  }

  /** The start near `nominal` whose opening best matches the natural continuation at `target`. */
  private bestStart(nominal: number, target: number): number {
    const end = this.bufferStart + this.buffer.length;
    const low = Math.max(this.bufferStart, nominal - this.seek);
    const high = Math.min(nominal + this.seek, end - this.frame);
    const length = Math.min(this.hop, end - target);
    if (length <= 0 || high < low) return Math.max(low, Math.min(nominal, high));
    const targetBase = target - this.bufferStart;
    let best = Math.max(low, Math.min(nominal, high));
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let candidate = low; candidate <= high; candidate += 1) {
      const base = candidate - this.bufferStart;
      let dot = 0;
      let energy = 1e-9;
      for (let n = 0; n < length; n += 2) {
        const sample = this.buffer[base + n]!;
        dot += sample * this.buffer[targetBase + n]!;
        energy += sample * sample;
      }
      const score = dot / Math.sqrt(energy);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return best;
  }

  /** Forgets input that no future frame or continuation can reach. */
  private trim(): void {
    const keepFrom = Math.min(
      Math.round(this.nextAnalysis) - this.seek,
      this.previousStart === null ? Number.POSITIVE_INFINITY : this.previousStart + this.hop,
    );
    const drop = Math.max(0, Math.min(this.buffer.length, keepFrom - this.bufferStart));
    if (drop === 0) return;
    this.buffer = this.buffer.slice(drop);
    this.bufferStart += drop;
  }
}
