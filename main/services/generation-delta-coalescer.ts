import type { NotificationChannel } from "../../renderer/preload-channels.js";

/**
 * Coalesces a renderer document's streamed text and reasoning deltas into one
 * IPC message per short window instead of one per provider token.
 *
 * Ordering is preserved exactly: consecutive deltas on the same channel merge,
 * a channel switch starts a new entry, and any other notification for the
 * stream must call `flush` first so it is delivered after every earlier delta.
 * Reset deltas and payloads carrying anything beyond `{ streamId, delta }` are
 * never buffered.
 */

export type CoalescedDeltaChannel = "chat:delta" | "chat:reasoning-delta";

export interface DeltaRecipient {
  isDestroyed(): boolean;
  send(channel: NotificationChannel, payload: unknown): void;
}

export interface GenerationDeltaCoalescerOptions {
  /** Longest a buffered delta waits before delivery. */
  windowMs?: number;
  /** Buffered characters that force an immediate flush. */
  maxBufferedChars?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface PendingEntry {
  channel: CoalescedDeltaChannel;
  delta: string;
}

interface PendingStream {
  recipient: DeltaRecipient;
  entries: PendingEntry[];
  chars: number;
  timer: unknown;
}

export const DEFAULT_DELTA_COALESCE_WINDOW_MS = 16;
export const DEFAULT_DELTA_COALESCE_MAX_CHARS = 16_384;

function isCoalescedDeltaChannel(channel: NotificationChannel): channel is CoalescedDeltaChannel {
  return channel === "chat:delta" || channel === "chat:reasoning-delta";
}

/** Only plain `{ streamId, delta }` payloads merge; resets and extras pass through. */
function plainDelta(streamId: string, payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.streamId !== streamId || typeof record.delta !== "string") return null;
  for (const key in record) {
    if (key !== "streamId" && key !== "delta") return null;
  }
  return record.delta;
}

export class GenerationDeltaCoalescer {
  private readonly pending = new Map<string, PendingStream>();
  private readonly windowMs: number;
  private readonly maxBufferedChars: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(options: GenerationDeltaCoalescerOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_DELTA_COALESCE_WINDOW_MS;
    this.maxBufferedChars = options.maxBufferedChars ?? DEFAULT_DELTA_COALESCE_MAX_CHARS;
    this.setTimer =
      options.setTimer ??
      ((callback, ms) => {
        const timer = setTimeout(callback, ms);
        timer.unref?.();
        return timer;
      });
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /**
   * Buffer a delta for `recipient`. Returns false when the notification must be
   * sent directly (after `flush`) because it is not a mergeable delta.
   */
  push(
    streamId: string,
    channel: NotificationChannel,
    payload: unknown,
    recipient: DeltaRecipient,
  ): boolean {
    if (!isCoalescedDeltaChannel(channel)) return false;
    const delta = plainDelta(streamId, payload);
    if (delta === null) return false;
    let stream = this.pending.get(streamId);
    if (stream && stream.recipient !== recipient) {
      this.flush(streamId);
      stream = undefined;
    }
    if (!stream) {
      stream = { recipient, entries: [], chars: 0, timer: undefined };
      this.pending.set(streamId, stream);
    }
    const last = stream.entries[stream.entries.length - 1];
    if (last?.channel === channel) last.delta += delta;
    else stream.entries.push({ channel, delta });
    stream.chars += delta.length;
    if (stream.chars >= this.maxBufferedChars) {
      this.flush(streamId);
    } else if (stream.timer === undefined) {
      stream.timer = this.setTimer(() => {
        const current = this.pending.get(streamId);
        if (current) current.timer = undefined;
        this.flush(streamId);
      }, this.windowMs);
    }
    return true;
  }

  /** Deliver every buffered delta for the stream, in arrival order. */
  flush(streamId: string): void {
    const stream = this.pending.get(streamId);
    if (!stream) return;
    this.pending.delete(streamId);
    if (stream.timer !== undefined) this.clearTimer(stream.timer);
    if (stream.recipient.isDestroyed()) return;
    for (const entry of stream.entries) {
      if (!entry.delta) continue;
      try {
        stream.recipient.send(entry.channel, { streamId, delta: entry.delta });
      } catch {
        // A document torn down mid-flush drops the rest, as a direct send would.
        return;
      }
    }
  }

  /** Drop buffered deltas without delivering them. */
  discard(streamId: string): void {
    const stream = this.pending.get(streamId);
    if (!stream) return;
    this.pending.delete(streamId);
    if (stream.timer !== undefined) this.clearTimer(stream.timer);
  }

  hasPending(streamId: string): boolean {
    return this.pending.has(streamId);
  }
}
