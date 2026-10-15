import type { ServerResponse } from "node:http";
import {
  AIDEN_REMOTE_PROTOCOL_VERSION,
  AIDEN_REMOTE_SSE_HEARTBEAT_MS,
} from "./aiden-remote-protocol.js";

/** One pull from a cursor-backed source. */
export type CursorSsePull =
  /** Frames to write now. `end` closes the stream cleanly after writing them. */
  | { frames: readonly string[]; end?: boolean }
  /** The cursor can no longer be served; drop the connection so the client reconnects. */
  | { abort: true };

export interface CursorSseOptions {
  /**
   * Pull the next bounded batch. The source owns the cursor and advances it
   * as frames are returned; an empty batch means "caught up, wait for wake".
   */
  pull(): CursorSsePull;
  /** Called exactly once when the connection ends for any reason. */
  onClose(): void;
  /** Extra response headers (for example an epoch header). */
  headers?: Record<string, string>;
  heartbeatMs?: number;
  drainTimeoutMs?: number;
}

export interface CursorSseHandle {
  /** Pull and write whatever is ready. Safe to call at any time, any number of times. */
  wake(): void;
  /** Drop the connection immediately (revocation, shutdown). */
  close(): void;
  readonly closed: boolean;
}

export const AIDEN_REMOTE_SSE_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Serialize one SSE frame. `id` and `event` never contain newlines. A frame
 * without an `id` leaves the client's `Last-Event-ID` unchanged.
 */
export function sseFrame(id: string | undefined, event: string, data: unknown): string {
  const idLine = id === undefined ? "" : `id: ${id}\n`;
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Wake-then-read SSE pump shared by the host feed and run streams. The
 * source journal is the only queue: the pump pulls one bounded batch at a
 * time and stops pulling while Node's writable buffer is blocked, so a slow
 * client costs bounded journal memory and never back-pressure on the source.
 * A client that stays blocked past the drain timeout is disconnected.
 */
export function openCursorSse(
  response: ServerResponse,
  options: CursorSseOptions,
): CursorSseHandle {
  const heartbeatMs = options.heartbeatMs ?? AIDEN_REMOTE_SSE_HEARTBEAT_MS;
  const drainTimeoutMs = options.drainTimeoutMs ?? AIDEN_REMOTE_SSE_DRAIN_TIMEOUT_MS;
  let closed = false;
  let blocked = false;
  let ending = false;
  let pumping = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let drainTimeout: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(drainTimeout);
    response.off("close", cleanup);
    response.off("error", abort);
    response.off("drain", onDrain);
    try {
      options.onClose();
    } catch {
      // Source bookkeeping must not keep a dead connection alive.
    }
  };
  const abort = () => {
    cleanup();
    response.destroy();
  };
  const end = () => {
    if (closed || ending) return;
    ending = true;
    response.once("finish", cleanup);
    drainTimeout = setTimeout(abort, drainTimeoutMs);
    drainTimeout.unref?.();
    try {
      response.end();
    } catch {
      abort();
    }
  };
  const write = (frame: string): boolean => {
    try {
      if (response.destroyed || response.writableEnded) {
        cleanup();
        return false;
      }
      if (!response.write(frame) && !blocked) {
        // One drain timer per blocked period; a later frame in the same batch
        // must not orphan a timer that `onDrain` can no longer clear.
        blocked = true;
        drainTimeout = setTimeout(abort, drainTimeoutMs);
        drainTimeout.unref?.();
      }
    } catch {
      abort();
      return false;
    }
    return !closed;
  };
  const wake = () => {
    if (closed || ending || pumping) return;
    pumping = true;
    try {
      while (!closed && !blocked && !ending) {
        let pulled: CursorSsePull;
        try {
          pulled = options.pull();
        } catch {
          abort();
          return;
        }
        if ("abort" in pulled) {
          abort();
          return;
        }
        for (const frame of pulled.frames) {
          if (!write(frame)) return;
        }
        if (pulled.end) {
          end();
          return;
        }
        if (pulled.frames.length === 0) return;
      }
    } finally {
      pumping = false;
    }
  };
  const onDrain = () => {
    if (closed || ending) return;
    blocked = false;
    clearTimeout(drainTimeout);
    drainTimeout = undefined;
    wake();
  };
  response.once("close", cleanup);
  response.once("error", abort);
  response.on("drain", onDrain);
  try {
    response.writeHead(200, {
      "aiden-protocol-version": String(AIDEN_REMOTE_PROTOCOL_VERSION),
      "cache-control": "no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
      ...options.headers,
    });
    // Node holds the headers until the first body write. A resumed stream
    // with nothing new to replay must still tell the client it is open, not
    // leave it waiting for the next change or heartbeat.
    response.flushHeaders?.();
    wake();
    if (!closed && !ending) {
      heartbeat = setInterval(() => {
        if (!closed && !blocked && !ending) write(": heartbeat\n\n");
      }, heartbeatMs);
      heartbeat.unref?.();
    }
  } catch {
    abort();
  }
  return {
    wake,
    close: abort,
    get closed() {
      return closed;
    },
  };
}
