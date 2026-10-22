/**
 * Adapted from t3code PR #20999 (`repeatStillFrame`, MIT), reimplemented for
 * Aiden's device hub proxy.
 *
 * Browsers paint a `multipart/x-mixed-replace` part only once the next part
 * begins. serve-sim sends an MJPEG frame only when the screen changes, so a
 * still simulator yields one frame that an `<img>` never paints, and the last
 * frame of any change stays hidden until the next one. This transform follows
 * the hub's framing and, after `idleMs` without a new frame, re-sends the
 * latest complete part once, at a part boundary. Its delimiter makes the
 * browser paint the frame before it.
 *
 * Chunks are forwarded unchanged and the last part is kept as views of them,
 * so nothing is copied while frames keep arriving. Anything it cannot follow
 * (no Content-Length, an unexpected byte, a close delimiter, an oversized part
 * or header block) is passed through unchanged and never repeated.
 */
import { Transform, type TransformCallback } from "node:stream";

/** serve-sim's boundary, used when the Content-Type names none (as the phone parsers do). */
export const MJPEG_DEFAULT_BOUNDARY = "frame";
export const MJPEG_STILL_FRAME_IDLE_MS = 100;
/** The phone parsers' limits (`AidenMJPEGMultipartParser.swift`). */
export const MJPEG_MAX_PART_BYTES = 8 * 1_048_576;
export const MJPEG_MAX_HEADER_BYTES = 16 * 1_024;

const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d;

/**
 * The delimiter boundary of a `multipart/x-mixed-replace` Content-Type, or
 * null for any other type. A missing boundary means serve-sim's `frame`; a
 * leading `--` is dropped, as the phone parsers do.
 */
export function mjpegBoundary(contentType: string | string[] | undefined): string | null {
  if (typeof contentType !== "string") return null;
  const [type, ...parameters] = contentType.split(";");
  if (type.trim().toLowerCase() !== "multipart/x-mixed-replace") return null;
  for (const parameter of parameters) {
    const equals = parameter.indexOf("=");
    if (equals < 0 || parameter.slice(0, equals).trim().toLowerCase() !== "boundary") continue;
    let value = parameter.slice(equals + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("--")) value = value.slice(2);
    if (value.length > 0 && Buffer.byteLength(value) <= 70) return value;
  }
  return MJPEG_DEFAULT_BOUNDARY;
}

export interface StillFrameTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface StillFrameOptions {
  idleMs?: number;
  maxPartBytes?: number;
  maxHeaderBytes?: number;
  timers?: StillFrameTimers;
}

const realTimers: StillFrameTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Phase =
  /** Between parts: CRLFs, then a delimiter. */
  | "between"
  | "delimiter"
  /** The CRLF that ends the delimiter line. */
  | "delimiterEnd"
  | "headers"
  | "body"
  /** The CRLF after a body. */
  | "bodyEnd"
  | "passthrough";

const CRLF = Buffer.from("\r\n");

/**
 * A transform that repeats the latest still MJPEG part once after `idleMs`.
 * `boundary` comes from `mjpegBoundary`.
 */
export function repeatStillFrame(boundary: string, options: StillFrameOptions = {}): Transform {
  const idleMs = options.idleMs ?? MJPEG_STILL_FRAME_IDLE_MS;
  const maxPartBytes = options.maxPartBytes ?? MJPEG_MAX_PART_BYTES;
  const maxHeaderBytes = options.maxHeaderBytes ?? MJPEG_MAX_HEADER_BYTES;
  const timers = options.timers ?? realTimers;
  const delimiter = Buffer.from(`--${boundary}`, "latin1");

  let phase: Phase = "between";
  /** Bytes consumed in the current `between`, `delimiter`, `delimiterEnd` or `bodyEnd` phase. */
  let matched = 0;
  /** The last byte consumed while `between`. */
  let lastGapByte = -1;
  let headerText = "";
  let bodyRemaining = 0;
  /** Views of the part being read, from its delimiter through its body. */
  let current: Buffer[] = [];
  /** Views of the latest complete part, without the CRLF that follows it. */
  let lastPart: Buffer[] | null = null;
  let repeated = false;
  let timer: unknown = null;

  const stopTimer = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };

  const giveUp = () => {
    phase = "passthrough";
    stopTimer();
    current = [];
    lastPart = null;
  };

  const take = (chunk: Buffer, start: number, end: number) => {
    if (end > start) current.push(chunk.subarray(start, end));
  };

  const contentLength = (): number | null => {
    let length: number | null = null;
    for (const line of headerText.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      if (line.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
      const value = line.slice(colon + 1).trim();
      if (!/^\d{1,10}$/u.test(value)) return null;
      length = Number(value);
    }
    return length;
  };

  const repeat = (stream: Transform) => {
    timer = null;
    const part = lastPart;
    if (!part || repeated || stream.destroyed || stream.writableEnded) return;
    // A push can reach a client that closes on the spot, which destroys this
    // stream and drops `lastPart`; stop at once rather than write after that.
    const send = (views: readonly Buffer[]) => {
      for (const view of views) {
        if (stream.destroyed) return;
        stream.push(view);
      }
    };
    // Only at a part boundary, never inside a part that is still arriving.
    if (phase === "bodyEnd" && matched === 0) {
      send([CRLF, ...part]);
    } else if (phase === "between" && (matched === 0 || lastGapByte === LF)) {
      send([...part, CRLF]);
    } else {
      // Mid-boundary or mid-part: look again shortly. A part that completes
      // first replaces this timer with its own.
      timer = timers.set(() => repeat(stream), idleMs);
      return;
    }
    repeated = true;
  };

  /** Follows one chunk's framing. Returns false when the stream cannot be followed. */
  const track = (stream: Transform, chunk: Buffer): boolean => {
    let index = 0;
    while (index < chunk.length) {
      switch (phase) {
        case "passthrough":
          return true;
        case "between": {
          const byte = chunk[index];
          if (byte === CR || byte === LF) {
            matched += 1;
            lastGapByte = byte;
            index += 1;
            if (matched > maxHeaderBytes) return false;
            continue;
          }
          if (byte !== DASH) return false;
          phase = "delimiter";
          matched = 0;
          current = [];
          continue;
        }
        case "delimiter": {
          const start = index;
          while (index < chunk.length && matched < delimiter.length) {
            if (chunk[index] !== delimiter[matched]) return false;
            matched += 1;
            index += 1;
          }
          take(chunk, start, index);
          if (matched === delimiter.length) {
            phase = "delimiterEnd";
            matched = 0;
          }
          continue;
        }
        case "delimiterEnd": {
          // A close delimiter (`--`) or transport padding ends tracking.
          if (chunk[index] !== (matched === 0 ? CR : LF)) return false;
          take(chunk, index, index + 1);
          index += 1;
          matched += 1;
          if (matched === 2) {
            phase = "headers";
            headerText = "";
          }
          continue;
        }
        case "headers": {
          const start = index;
          while (index < chunk.length && !headerText.endsWith("\r\n\r\n")) {
            headerText += String.fromCharCode(chunk[index]);
            index += 1;
            if (headerText.length > maxHeaderBytes) return false;
            // An empty header block ends at its first CRLF.
            if (headerText === "\r\n") break;
          }
          take(chunk, start, index);
          if (headerText === "\r\n" || headerText.endsWith("\r\n\r\n")) {
            const length = contentLength();
            if (length === null || length > maxPartBytes) return false;
            phase = "body";
            bodyRemaining = length;
          }
          continue;
        }
        case "body": {
          const end = Math.min(chunk.length, index + bodyRemaining);
          take(chunk, index, end);
          bodyRemaining -= end - index;
          index = end;
          if (bodyRemaining === 0) completePart(stream);
          continue;
        }
        case "bodyEnd": {
          if (chunk[index] !== (matched === 0 ? CR : LF)) return false;
          index += 1;
          matched += 1;
          if (matched === 2) {
            phase = "between";
            matched = 0;
            lastGapByte = -1;
          }
          continue;
        }
      }
    }
    // An empty body completes as soon as its headers end, even at a chunk's end.
    if (phase === "body" && bodyRemaining === 0) completePart(stream);
    return true;
  };

  const completePart = (stream: Transform) => {
    lastPart = current;
    current = [];
    repeated = false;
    phase = "bodyEnd";
    matched = 0;
    stopTimer();
    timer = timers.set(() => repeat(stream), idleMs);
  };

  return new Transform({
    transform(this: Transform, chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      // The timer runs from the latest complete part; while the next part is half-read it only re-arms.
      if (phase !== "passthrough" && !track(this, chunk)) giveUp();
      callback(null, chunk);
    },
    flush(callback: TransformCallback) {
      giveUp();
      callback();
    },
    destroy(error: Error | null, callback: (error: Error | null) => void) {
      giveUp();
      callback(error);
    },
  });
}
