/**
 * A Bot computer's screen over RFB: the `BotComputerScreen` that P8's
 * sessions hand to the `computer` tool, plus the live frames the viewer hub
 * streams. One VNC connection per computer run serves both.
 *
 * - `capture` asks the server for the whole screen and waits for a full
 *   picture, so what the Bot sees is never a half-painted frame.
 * - While a viewer watches, incremental updates keep the framebuffer
 *   current, at most one request per `frameIntervalMs`.
 * - A dropped connection is reopened by the next capture, input or viewer.
 *
 * Encoding is injected (Electron's `nativeImage` in production), so this
 * module runs under plain Node in tests.
 */

import type { RfbClient, RfbUpdate } from "./rfb-client.js";
import { BotComputerError, type BotComputerCapture, type BotComputerScreen } from "./types.js";

export interface EncodedImage {
  image: Buffer;
  width: number;
  height: number;
}

/** BGRA pixels to PNG or JPEG, scaled down (aspect kept) to at most `maxWidth` wide. */
export type BotComputerImageEncoder = (
  bgra: Buffer,
  width: number,
  height: number,
  format: "png" | "jpeg",
  quality: number,
  maxWidth: number,
) => Promise<EncodedImage>;

export interface BotComputerLiveFrame extends EncodedImage {
  /** Increases with every painted update; equal versions are the same picture. */
  version: number;
}

/** What the viewer needs beyond the Bot's screen contract. */
export interface BotComputerLiveScreen extends BotComputerScreen {
  /** The framebuffer size, once connected. */
  size(): { width: number; height: number } | undefined;
  /** The picture's version; it changes when the screen does. */
  version(): number;
  /** Keeps updates flowing while subscribed; `listener` runs after each one. */
  watch(listener: (update: { version: number; resized: boolean; width: number; height: number }) => void): () => void;
  /** The current picture as a JPEG, scaled to at most `maxWidth` wide. */
  jpeg(options: { quality: number; maxWidth: number }): Promise<BotComputerLiveFrame>;
  /** Runs when the VNC connection drops; the next use reconnects. */
  onDisconnect(listener: () => void): () => void;
}

export function isLiveScreen(screen: BotComputerScreen): screen is BotComputerLiveScreen {
  return typeof (screen as Partial<BotComputerLiveScreen>).watch === "function";
}

export interface RfbScreenOptions {
  /** Opens a VNC connection to this run's server. */
  connect(signal?: AbortSignal): Promise<RfbClient>;
  encode: BotComputerImageEncoder;
  captureTimeoutMs?: number;
  frameIntervalMs?: number;
  schedule?(callback: () => void, ms: number): () => void;
}

const DEFAULT_JPEG_QUALITY = 70;

function validMaxWidth(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 8192;
}

/** Opens the first connection, so a computer whose screen can't be reached fails here. */
export async function createRfbScreen(options: RfbScreenOptions, signal?: AbortSignal): Promise<BotComputerLiveScreen> {
  const schedule =
    options.schedule ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });
  const frameIntervalMs = options.frameIntervalMs ?? 100;
  const captureTimeoutMs = options.captureTimeoutMs ?? 15_000;
  const watchers = new Set<(update: { version: number; resized: boolean; width: number; height: number }) => void>();
  const disconnectListeners = new Set<() => void>();
  let client: RfbClient | undefined;
  let connecting: Promise<RfbClient> | undefined;
  let closed = false;
  let version = 0;
  let lastRequestAt = 0;
  let cancelPump: (() => void) | undefined;

  const pump = () => {
    cancelPump?.();
    cancelPump = undefined;
    const current = client;
    if (!current || current.closed || watchers.size === 0) return;
    const wait = Math.max(0, lastRequestAt + frameIntervalMs - Date.now());
    cancelPump = schedule(() => {
      cancelPump = undefined;
      if (client !== current || current.closed || watchers.size === 0) return;
      lastRequestAt = Date.now();
      void current.requestUpdate(true).catch(() => undefined);
    }, wait);
  };

  const adopt = (next: RfbClient): RfbClient => {
    client = next;
    version += 1;
    next.onUpdate((update: RfbUpdate) => {
      if (client !== next) return;
      version += 1;
      for (const watcher of [...watchers]) {
        try {
          watcher({ version, resized: update.resized, width: update.width, height: update.height });
        } catch {
          // A failing watcher never stalls the screen.
        }
      }
      pump();
    });
    next.onClose(() => {
      if (client !== next) return;
      client = undefined;
      cancelPump?.();
      cancelPump = undefined;
      for (const listener of [...disconnectListeners]) {
        try {
          listener();
        } catch {
          // Advisory.
        }
      }
    });
    if (watchers.size > 0) pump();
    return next;
  };

  const abortError = (operationSignal: AbortSignal) =>
    operationSignal.reason instanceof Error
      ? operationSignal.reason
      : new BotComputerError("cancelled", "The computer action was cancelled.");

  const notAborted = (operationSignal?: AbortSignal) => {
    if (operationSignal?.aborted) throw abortError(operationSignal);
  };

  /**
   * The open connection, reopening a dropped one. A reconnect is shared by
   * every caller and bounded by the handshake timeout, so one caller giving
   * up stops only its own wait.
   */
  const live = async (operationSignal?: AbortSignal): Promise<RfbClient> => {
    if (closed) throw new BotComputerError("cancelled", "The computer's screen was closed.");
    if (client && !client.closed) return client;
    connecting ??= options
      .connect()
      .then((next) => {
        if (closed) {
          next.close();
          throw new BotComputerError("cancelled", "The computer's screen was closed.");
        }
        return adopt(next);
      })
      .finally(() => {
        connecting = undefined;
      });
    if (!operationSignal) return connecting;
    notAborted(operationSignal);
    return new Promise<RfbClient>((resolve, reject) => {
      const onAbort = () => reject(abortError(operationSignal));
      operationSignal.addEventListener("abort", onAbort, { once: true });
      connecting!.then(resolve, reject).finally(() => operationSignal.removeEventListener("abort", onAbort));
    });
  };

  // The first connection follows the opener's signal: an abandoned open leaves nothing behind.
  adopt(await options.connect(signal));

  const snapshot = async (format: "png" | "jpeg", quality: number, maxWidth: number) => {
    const current = await live();
    const { data, width, height } = current.framebuffer();
    const at = version;
    // The framebuffer keeps changing underneath; encode a copy.
    const encoded = await options.encode(Buffer.from(data), width, height, format, quality, maxWidth);
    return { ...encoded, framebufferWidth: width, framebufferHeight: height, version: at };
  };

  return {
    async capture({ format, maxWidth, quality, signal: captureSignal }): Promise<BotComputerCapture> {
      if (format !== "png" && format !== "jpeg") throw new BotComputerError("invalid", "Captures are PNG or JPEG.");
      if (!validMaxWidth(maxWidth)) throw new BotComputerError("invalid", "A capture's width must be 1 to 8192 pixels.");
      const jpegQuality = quality ?? DEFAULT_JPEG_QUALITY;
      if (!Number.isInteger(jpegQuality) || jpegQuality < 1 || jpegQuality > 100) {
        throw new BotComputerError("invalid", "JPEG quality must be 1 to 100.");
      }
      notAborted(captureSignal);
      const current = await live(captureSignal);
      const full = current.nextUpdate({ full: true, signal: captureSignal, timeoutMs: captureTimeoutMs });
      // A wait that loses to the request's failure must not reject unhandled.
      full.catch(() => undefined);
      await current.requestUpdate(false);
      await full;
      notAborted(captureSignal);
      const shot = await snapshot(format, jpegQuality, maxWidth);
      return {
        image: shot.image,
        mimeType: format === "png" ? "image/png" : "image/jpeg",
        width: shot.width,
        height: shot.height,
        framebufferWidth: shot.framebufferWidth,
        framebufferHeight: shot.framebufferHeight,
      };
    },

    async pointer(event, pointerSignal) {
      if (![event.x, event.y].every(Number.isFinite) || !Number.isInteger(event.buttons) || event.buttons < 0 || event.buttons > 255) {
        throw new BotComputerError("invalid", "A pointer event needs finite coordinates and a button mask from 0 to 255.");
      }
      notAborted(pointerSignal);
      await (await live(pointerSignal)).pointer(event.x, event.y, event.buttons);
    },

    async key(event, keySignal) {
      if (!Number.isInteger(event.keysym) || event.keysym < 0 || event.keysym > 0xffff_ffff) {
        throw new BotComputerError("invalid", "A keysym is a 32-bit unsigned integer.");
      }
      notAborted(keySignal);
      await (await live(keySignal)).key(event.keysym, event.down);
    },

    async close() {
      closed = true;
      watchers.clear();
      cancelPump?.();
      cancelPump = undefined;
      const current = client;
      client = undefined;
      current?.close();
    },

    size: () => (client && !client.closed ? { width: client.width, height: client.height } : undefined),

    version: () => version,

    watch(listener) {
      watchers.add(listener);
      if (watchers.size === 1) {
        // The first watcher starts the stream (at once, unless a request just went); later ones ride it.
        void live()
          .then(() => pump())
          .catch(() => undefined);
      }
      return () => {
        watchers.delete(listener);
        if (watchers.size === 0) {
          cancelPump?.();
          cancelPump = undefined;
        }
      };
    },

    async jpeg({ quality, maxWidth }) {
      if (!validMaxWidth(maxWidth)) throw new BotComputerError("invalid", "A frame's width must be 1 to 8192 pixels.");
      const shot = await snapshot("jpeg", quality, maxWidth);
      return { image: shot.image, width: shot.width, height: shot.height, version: shot.version };
    },

    onDisconnect(listener) {
      disconnectListeners.add(listener);
      return () => void disconnectListeners.delete(listener);
    },
  };
}
