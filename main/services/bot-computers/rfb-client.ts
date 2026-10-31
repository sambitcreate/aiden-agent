/**
 * A small RFB (VNC) client for a Bot computer's loopback VNC server (plan
 * §8.5, viewer option b). It runs in main, so the per-run VNC password and
 * the socket never reach the renderer.
 *
 * - RFB 3.3, 3.7 and 3.8 handshakes (Apple's 3.889 reads as 3.8), security
 *   type 2 (VNC auth) or None.
 * - Shared ClientInit; 32-bit little-endian true colour with shifts 16/8/0,
 *   so the framebuffer is BGRA in memory (alpha forced opaque).
 * - Raw, CopyRect and DesktopSize; LastRect and Cursor are understood if a
 *   server sends them unasked. Anything else ends the connection, because an
 *   unknown encoding's length cannot be skipped.
 * - Every size is bounded before it is allocated: framebuffer dimensions,
 *   rectangles (which must lie inside the framebuffer), cut text and names.
 *   A message that has started must finish within `messageTimeoutMs`.
 *
 * The socket is any `Duplex`, so tests drive it with in-memory transcripts.
 */

import type { Duplex } from "node:stream";

import { vncAuthResponse } from "./vnc-des.js";

export const RFB_MAX_DIMENSION = 8192;
export const RFB_ENCODING_RAW = 0;
export const RFB_ENCODING_COPY_RECT = 1;
export const RFB_ENCODING_DESKTOP_SIZE = -223;
export const RFB_ENCODING_LAST_RECT = -224;
export const RFB_ENCODING_CURSOR = -239;

/** Requested in this order; Raw last as the universal fallback is not needed, since every server has it. */
export const RFB_REQUESTED_ENCODINGS = [RFB_ENCODING_COPY_RECT, RFB_ENCODING_RAW, RFB_ENCODING_DESKTOP_SIZE] as const;

const BYTES_PER_PIXEL = 4;
const MAX_REASON_BYTES = 4096;
const MAX_NAME_BYTES = 4096;
const MAX_CURSOR_DIMENSION = 512;

export type RfbErrorCode =
  | "unsupported_version"
  | "security"
  | "auth_failed"
  | "malformed"
  | "too_large"
  | "timeout"
  | "closed"
  | "cancelled";

export class RfbError extends Error {
  constructor(
    readonly code: RfbErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RfbError";
  }
}

export interface RfbRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RfbUpdate {
  /** Rectangles whose pixels changed, in framebuffer pixels. */
  rects: RfbRect[];
  /** The framebuffer changed size during this update. */
  resized: boolean;
  /** The pixels this update painted cover the whole framebuffer: a full update. */
  full: boolean;
  width: number;
  height: number;
}

export interface RfbFramebuffer {
  width: number;
  height: number;
  /** BGRA, `width * height * 4` bytes, opaque. Live: it changes with every update. */
  data: Buffer;
}

export interface RfbClientOptions {
  /** Needed when the server offers only VNC auth. */
  password?: string;
  /** Default true: other viewers of the same computer stay connected. */
  shared?: boolean;
  maxDimension?: number;
  /** Whole handshake, from connect to ServerInit. */
  handshakeTimeoutMs?: number;
  /** A server message that has begun must finish within this. */
  messageTimeoutMs?: number;
  maxCutTextBytes?: number;
  signal?: AbortSignal;
  now?(): number;
}

export interface RfbClient {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly closed: boolean;
  /** The live framebuffer; copy it before keeping it across an await. */
  framebuffer(): RfbFramebuffer;
  /** Ask for the area (default: everything); `incremental` asks only for changes. */
  requestUpdate(incremental: boolean): Promise<void>;
  /**
   * The next update that satisfies `full` (default false: any update). A
   * full wait is answered only by an update covering the whole framebuffer.
   */
  nextUpdate(options?: { full?: boolean; signal?: AbortSignal; timeoutMs?: number }): Promise<RfbUpdate>;
  /** Framebuffer pixels, clamped inside the framebuffer; `buttons` is the RFB mask (1 left, 2 middle, 4 right, 8/16 wheel). */
  pointer(x: number, y: number, buttons: number): Promise<void>;
  key(keysym: number, down: boolean): Promise<void>;
  onUpdate(listener: (update: RfbUpdate) => void): () => void;
  onClose(listener: (error: RfbError | undefined) => void): () => void;
  close(): void;
}

interface PixelFormat {
  bitsPerPixel: number;
  depth: number;
  bigEndian: boolean;
  trueColour: boolean;
  redMax: number;
  greenMax: number;
  blueMax: number;
  redShift: number;
  greenShift: number;
  blueShift: number;
}

/** What the client asks for: BGRX in memory. */
const TARGET_FORMAT: PixelFormat = {
  bitsPerPixel: 32,
  depth: 24,
  bigEndian: false,
  trueColour: true,
  redMax: 255,
  greenMax: 255,
  blueMax: 255,
  redShift: 16,
  greenShift: 8,
  blueShift: 0,
};

function parsePixelFormat(bytes: Buffer): PixelFormat {
  return {
    bitsPerPixel: bytes[0],
    depth: bytes[1],
    bigEndian: bytes[2] !== 0,
    trueColour: bytes[3] !== 0,
    redMax: bytes.readUInt16BE(4),
    greenMax: bytes.readUInt16BE(6),
    blueMax: bytes.readUInt16BE(8),
    redShift: bytes[10],
    greenShift: bytes[11],
    blueShift: bytes[12],
  };
}

/** The server's own format already lays pixels out as BGRX: no SetPixelFormat needed. */
function isTargetLayout(format: PixelFormat): boolean {
  return (
    format.bitsPerPixel === 32 &&
    !format.bigEndian &&
    format.trueColour &&
    format.redMax === 255 &&
    format.greenMax === 255 &&
    format.blueMax === 255 &&
    format.redShift === 16 &&
    format.greenShift === 8 &&
    format.blueShift === 0
  );
}

function setPixelFormatMessage(format: PixelFormat): Buffer {
  const message = Buffer.alloc(20);
  message[0] = 0;
  message[4] = format.bitsPerPixel;
  message[5] = format.depth;
  message[6] = format.bigEndian ? 1 : 0;
  message[7] = format.trueColour ? 1 : 0;
  message.writeUInt16BE(format.redMax, 8);
  message.writeUInt16BE(format.greenMax, 10);
  message.writeUInt16BE(format.blueMax, 12);
  message[14] = format.redShift;
  message[15] = format.greenShift;
  message[16] = format.blueShift;
  return message;
}

function setEncodingsMessage(encodings: readonly number[]): Buffer {
  const message = Buffer.alloc(4 + encodings.length * 4);
  message[0] = 2;
  message.writeUInt16BE(encodings.length, 2);
  encodings.forEach((encoding, index) => message.writeInt32BE(encoding, 4 + index * 4));
  return message;
}

function updateRequestMessage(incremental: boolean, width: number, height: number): Buffer {
  const message = Buffer.alloc(10);
  message[0] = 3;
  message[1] = incremental ? 1 : 0;
  message.writeUInt16BE(0, 2);
  message.writeUInt16BE(0, 4);
  message.writeUInt16BE(width, 6);
  message.writeUInt16BE(height, 8);
  return message;
}

interface PendingRead {
  length: number;
  resolve(bytes: Buffer): void;
  reject(error: RfbError): void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Buffered, length-exact reads off a byte stream, one reader at a time. */
class ByteReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private pending: PendingRead | undefined;
  private failure: RfbError | undefined;

  push(chunk: Buffer): void {
    if (this.failure) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this.drain();
  }

  fail(error: RfbError): void {
    if (this.failure) return;
    this.failure = error;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  /** `deadline` is a wall-clock time; omitted, the read may wait forever (an idle server). */
  read(length: number, deadline: number | undefined, now: () => number): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new RfbError("malformed", "Only one RFB read can be pending."));
    if (length === 0) return Promise.resolve(Buffer.alloc(0));
    if (this.buffered >= length) return Promise.resolve(this.take(length));
    return new Promise<Buffer>((resolve, reject) => {
      const pending: PendingRead = { length, resolve, reject };
      if (deadline !== undefined) {
        pending.timer = setTimeout(
          () => this.fail(new RfbError("timeout", "The computer's screen stopped answering.")),
          Math.max(0, deadline - now()),
        );
      }
      this.pending = pending;
    });
  }

  private drain(): void {
    const pending = this.pending;
    if (!pending || this.buffered < pending.length) return;
    this.pending = undefined;
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(this.take(pending.length));
  }

  private take(length: number): Buffer {
    this.buffered -= length;
    const first = this.chunks[0];
    if (first.length === length) {
      this.chunks.shift();
      return first;
    }
    if (first.length > length) {
      this.chunks[0] = first.subarray(length);
      return first.subarray(0, length);
    }
    const out = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const chunk = this.chunks[0];
      const used = Math.min(chunk.length, length - offset);
      chunk.copy(out, offset, 0, used);
      offset += used;
      if (used === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(used);
    }
    return out;
  }
}

function opaque(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * BYTES_PER_PIXEL);
  for (let index = 3; index < data.length; index += BYTES_PER_PIXEL) data[index] = 255;
  return data;
}

function validDimension(value: number, max: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= max;
}

/**
 * Runs the RFB handshake on `socket` and returns a connected client whose
 * first full update has been requested. Rejects (and destroys the socket) on
 * a refused password, an unsupported server, a malformed or oversized reply,
 * a handshake slower than `handshakeTimeoutMs`, or an abort.
 */
export async function connectRfb(socket: Duplex, options: RfbClientOptions = {}): Promise<RfbClient> {
  const now = options.now ?? Date.now;
  const maxDimension = Math.min(options.maxDimension ?? RFB_MAX_DIMENSION, RFB_MAX_DIMENSION);
  const messageTimeoutMs = options.messageTimeoutMs ?? 30_000;
  const maxCutTextBytes = options.maxCutTextBytes ?? 1024 * 1024;
  const reader = new ByteReader();
  const updateListeners = new Set<(update: RfbUpdate) => void>();
  const closeListeners = new Set<(error: RfbError | undefined) => void>();
  const waiters = new Set<{ full: boolean; resolve(update: RfbUpdate): void; reject(error: RfbError): void }>();
  let closed = false;
  let closeError: RfbError | undefined;
  let width = 0;
  let height = 0;
  let name = "";
  let data: Buffer = Buffer.alloc(0);

  const finish = (error: RfbError | undefined) => {
    if (closed) return;
    closed = true;
    closeError = error;
    reader.fail(error ?? new RfbError("closed", "The computer's screen connection closed."));
    socket.destroy();
    for (const waiter of [...waiters]) waiter.reject(error ?? new RfbError("closed", "The computer's screen connection closed."));
    waiters.clear();
    for (const listener of [...closeListeners]) {
      try {
        listener(error);
      } catch {
        // Close listeners are advisory.
      }
    }
  };

  socket.on("data", (chunk: Buffer) => reader.push(chunk));
  socket.once("error", () => finish(new RfbError("closed", "The computer's screen connection failed.")));
  socket.once("close", () => finish(closed ? closeError : new RfbError("closed", "The computer's screen connection closed.")));
  socket.once("end", () => finish(new RfbError("closed", "The computer's screen connection closed.")));

  const write = (bytes: Buffer): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (closed || socket.destroyed) {
        reject(closeError ?? new RfbError("closed", "The computer's screen connection closed."));
        return;
      }
      socket.write(bytes, (error) => (error ? reject(new RfbError("closed", "The computer's screen connection failed.")) : resolve()));
    });

  const abort = () => finish(new RfbError("cancelled", "Connecting to the computer's screen was cancelled."));
  if (options.signal?.aborted) {
    abort();
    throw closeError;
  }
  options.signal?.addEventListener("abort", abort, { once: true });

  const handshakeDeadline = now() + (options.handshakeTimeoutMs ?? 15_000);
  const read = (length: number) => reader.read(length, handshakeDeadline, now);

  async function readReason(): Promise<string> {
    const length = (await read(4)).readUInt32BE(0);
    if (length > MAX_REASON_BYTES) throw new RfbError("too_large", "The computer's screen sent an oversized message.");
    return (await read(length)).toString("utf8");
  }

  try {
    const banner = (await read(12)).toString("latin1");
    const version = /^RFB (\d{3})\.(\d{3})\n$/u.exec(banner);
    if (!version) throw new RfbError("malformed", "The computer's screen did not speak RFB.");
    const major = Number(version[1]);
    const minor = Number(version[2]);
    if (major !== 3) throw new RfbError("unsupported_version", `The computer's screen speaks an unsupported RFB version (${major}.${minor}).`);
    // Unknown 3.x minors are 3.3 by the spec; Apple's 3.889 understands 3.8.
    const use = minor >= 8 ? 8 : minor === 7 ? 7 : 3;
    await write(Buffer.from(`RFB 003.00${use}\n`, "latin1"));

    let security: number;
    if (use === 3) {
      security = (await read(4)).readUInt32BE(0);
      if (security === 0) throw new RfbError("security", `The computer's screen refused the connection: ${await readReason()}`);
    } else {
      const count = (await read(1))[0];
      if (count === 0) throw new RfbError("security", `The computer's screen refused the connection: ${await readReason()}`);
      const offered = [...(await read(count))];
      if (offered.includes(2) && options.password !== undefined) security = 2;
      else if (offered.includes(1)) security = 1;
      else if (offered.includes(2)) throw new RfbError("security", "The computer's screen needs a password.");
      else throw new RfbError("security", "The computer's screen offers no supported security type.");
      await write(Buffer.from([security]));
    }
    if (security === 2) {
      if (options.password === undefined) throw new RfbError("security", "The computer's screen needs a password.");
      await write(vncAuthResponse(options.password, await read(16)));
    } else if (security !== 1) {
      throw new RfbError("security", "The computer's screen offers no supported security type.");
    }
    if (security === 2 || use === 8) {
      const result = (await read(4)).readUInt32BE(0);
      if (result !== 0) {
        const reason = use === 8 ? await readReason() : "";
        throw new RfbError("auth_failed", reason ? `The computer's screen refused the password: ${reason}` : "The computer's screen refused the password.");
      }
    }

    await write(Buffer.from([options.shared === false ? 0 : 1]));
    const init = await read(24);
    width = init.readUInt16BE(0);
    height = init.readUInt16BE(2);
    if (!validDimension(width, maxDimension) || !validDimension(height, maxDimension)) {
      throw new RfbError("too_large", `The computer's screen is an unsupported size (${width}×${height}).`);
    }
    const format = parsePixelFormat(init.subarray(4, 20));
    const nameLength = init.readUInt32BE(20);
    if (nameLength > MAX_NAME_BYTES) throw new RfbError("too_large", "The computer's screen sent an oversized name.");
    name = (await read(nameLength)).toString("utf8");
    data = opaque(width, height);

    if (!isTargetLayout(format)) await write(setPixelFormatMessage(TARGET_FORMAT));
    await write(setEncodingsMessage(RFB_REQUESTED_ENCODINGS));
    await write(updateRequestMessage(false, width, height));
  } catch (error) {
    const failure =
      error instanceof RfbError ? error : new RfbError("malformed", "The computer's screen sent an unexpected reply.");
    finish(closeError ?? failure);
    options.signal?.removeEventListener("abort", abort);
    throw closeError ?? failure;
  }
  options.signal?.removeEventListener("abort", abort);

  const messageRead = (deadline: number) => (length: number) => reader.read(length, deadline, now);

  function copyRaw(pixels: Buffer, rect: RfbRect): void {
    const rowBytes = rect.width * BYTES_PER_PIXEL;
    for (let row = 0; row < rect.height; row += 1) {
      const target = ((rect.y + row) * width + rect.x) * BYTES_PER_PIXEL;
      pixels.copy(data, target, row * rowBytes, (row + 1) * rowBytes);
      for (let alpha = target + 3; alpha < target + rowBytes; alpha += BYTES_PER_PIXEL) data[alpha] = 255;
    }
  }

  function copyRect(sourceX: number, sourceY: number, rect: RfbRect): void {
    const rowBytes = rect.width * BYTES_PER_PIXEL;
    // Read the source block first: source and destination may overlap.
    const block = Buffer.allocUnsafe(rowBytes * rect.height);
    for (let row = 0; row < rect.height; row += 1) {
      const source = ((sourceY + row) * width + sourceX) * BYTES_PER_PIXEL;
      data.copy(block, row * rowBytes, source, source + rowBytes);
    }
    for (let row = 0; row < rect.height; row += 1) {
      block.copy(data, ((rect.y + row) * width + rect.x) * BYTES_PER_PIXEL, row * rowBytes, (row + 1) * rowBytes);
    }
  }

  const inside = (rect: RfbRect) =>
    rect.width >= 0 && rect.height >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height;

  async function framebufferUpdate(readMessage: (length: number) => Promise<Buffer>): Promise<void> {
    const header = await readMessage(3);
    const count = header.readUInt16BE(1);
    const rects: RfbRect[] = [];
    let resized = false;
    let covered = 0;
    for (let index = 0; index < count; index += 1) {
      const rectHeader = await readMessage(12);
      const rect = {
        x: rectHeader.readUInt16BE(0),
        y: rectHeader.readUInt16BE(2),
        width: rectHeader.readUInt16BE(4),
        height: rectHeader.readUInt16BE(6),
      };
      const encoding = rectHeader.readInt32BE(8);
      if (encoding === RFB_ENCODING_LAST_RECT) break;
      if (encoding === RFB_ENCODING_DESKTOP_SIZE) {
        if (!validDimension(rect.width, maxDimension) || !validDimension(rect.height, maxDimension)) {
          throw new RfbError("too_large", `The computer's screen changed to an unsupported size (${rect.width}×${rect.height}).`);
        }
        width = rect.width;
        height = rect.height;
        data = opaque(width, height);
        resized = true;
        // Pixels painted before the resize belong to the old framebuffer.
        rects.length = 0;
        covered = 0;
        continue;
      }
      if (encoding === RFB_ENCODING_CURSOR) {
        if (rect.width > MAX_CURSOR_DIMENSION || rect.height > MAX_CURSOR_DIMENSION) {
          throw new RfbError("too_large", "The computer's screen sent an oversized cursor.");
        }
        await readMessage(rect.width * rect.height * BYTES_PER_PIXEL + Math.ceil(rect.width / 8) * rect.height);
        continue;
      }
      if (!inside(rect)) throw new RfbError("malformed", "The computer's screen sent a rectangle outside its framebuffer.");
      if (encoding === RFB_ENCODING_RAW) {
        copyRaw(await readMessage(rect.width * rect.height * BYTES_PER_PIXEL), rect);
      } else if (encoding === RFB_ENCODING_COPY_RECT) {
        const source = await readMessage(4);
        const sourceX = source.readUInt16BE(0);
        const sourceY = source.readUInt16BE(2);
        if (!inside({ x: sourceX, y: sourceY, width: rect.width, height: rect.height })) {
          throw new RfbError("malformed", "The computer's screen copied from outside its framebuffer.");
        }
        copyRect(sourceX, sourceY, rect);
      } else {
        throw new RfbError("malformed", `The computer's screen sent an unsupported encoding (${encoding}).`);
      }
      if (rect.width > 0 && rect.height > 0) {
        rects.push(rect);
        covered += rect.width * rect.height;
      }
    }
    const update: RfbUpdate = { rects, resized, full: covered >= width * height, width, height };
    if (resized) {
      // The new framebuffer is blank until the server repaints all of it.
      void write(updateRequestMessage(false, width, height)).catch(() => undefined);
    }
    for (const waiter of [...waiters]) {
      if (waiter.full && !update.full) continue;
      waiters.delete(waiter);
      waiter.resolve(update);
    }
    for (const listener of [...updateListeners]) {
      try {
        listener(update);
      } catch {
        // A failing listener never stalls the stream.
      }
    }
  }

  async function loop(): Promise<void> {
    for (;;) {
      const type = (await reader.read(1, undefined, now))[0];
      const readMessage = messageRead(now() + messageTimeoutMs);
      switch (type) {
        case 0:
          await framebufferUpdate(readMessage);
          break;
        case 1: {
          // SetColourMapEntries: never used with true colour, but well formed.
          const header = await readMessage(5);
          await readMessage(header.readUInt16BE(3) * 6);
          break;
        }
        case 2:
          // Bell.
          break;
        case 3: {
          const header = await readMessage(7);
          // Extended clipboard sends a negative length; both are skipped.
          const length = Math.abs(header.readInt32BE(3));
          if (length > maxCutTextBytes) throw new RfbError("too_large", "The computer's screen sent oversized clipboard text.");
          await readMessage(length);
          break;
        }
        default:
          throw new RfbError("malformed", `The computer's screen sent an unknown message (${type}).`);
      }
    }
  }

  void loop().catch((error: unknown) =>
    finish(error instanceof RfbError ? (error.code === "closed" && closed ? closeError : error) : new RfbError("malformed", "The computer's screen sent an unexpected message.")),
  );

  const clampTo = (value: number, size: number) => Math.min(size - 1, Math.max(0, Math.round(value)));

  return {
    get name() {
      return name;
    },
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get closed() {
      return closed;
    },
    framebuffer: () => ({ width, height, data }),
    requestUpdate: (incremental) => write(updateRequestMessage(incremental, width, height)),
    nextUpdate(waitOptions = {}) {
      if (closed) return Promise.reject(closeError ?? new RfbError("closed", "The computer's screen connection closed."));
      if (waitOptions.signal?.aborted) return Promise.reject(new RfbError("cancelled", "Waiting for the computer's screen was cancelled."));
      return new Promise<RfbUpdate>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          waiters.delete(waiter);
          if (timer) clearTimeout(timer);
          waitOptions.signal?.removeEventListener("abort", onAbort);
        };
        const waiter = {
          full: waitOptions.full === true,
          resolve: (update: RfbUpdate) => {
            cleanup();
            resolve(update);
          },
          reject: (error: RfbError) => {
            cleanup();
            reject(error);
          },
        };
        const onAbort = () => waiter.reject(new RfbError("cancelled", "Waiting for the computer's screen was cancelled."));
        waiters.add(waiter);
        waitOptions.signal?.addEventListener("abort", onAbort, { once: true });
        if (waitOptions.timeoutMs !== undefined) {
          timer = setTimeout(() => waiter.reject(new RfbError("timeout", "The computer's screen did not send a picture in time.")), waitOptions.timeoutMs);
        }
      });
    },
    pointer(x, y, buttons) {
      if (![x, y].every(Number.isFinite) || !Number.isInteger(buttons) || buttons < 0 || buttons > 255) {
        return Promise.reject(new RangeError("A pointer event needs finite coordinates and a button mask from 0 to 255."));
      }
      const message = Buffer.alloc(6);
      message[0] = 5;
      message[1] = buttons;
      message.writeUInt16BE(clampTo(x, width), 2);
      message.writeUInt16BE(clampTo(y, height), 4);
      return write(message);
    },
    key(keysym, down) {
      if (!Number.isInteger(keysym) || keysym < 0 || keysym > 0xffff_ffff) {
        return Promise.reject(new RangeError("A keysym is a 32-bit unsigned integer."));
      }
      const message = Buffer.alloc(8);
      message[0] = 4;
      message[1] = down ? 1 : 0;
      message.writeUInt32BE(keysym, 4);
      return write(message);
    },
    onUpdate(listener) {
      updateListeners.add(listener);
      return () => void updateListeners.delete(listener);
    },
    onClose(listener) {
      if (closed) {
        queueMicrotask(() => listener(closeError));
        return () => undefined;
      }
      closeListeners.add(listener);
      return () => void closeListeners.delete(listener);
    },
    close: () => finish(undefined),
  };
}
