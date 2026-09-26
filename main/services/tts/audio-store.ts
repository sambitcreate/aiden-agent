// Bounded, owner-scoped session audio retention for read aloud.
//
// No cross-owner sharing; exact identity keys; eviction removes inactive
// soundbites atomically in the service, never individual segments. Nothing persists to disk and no
// audio ever enters chat JSON, portable config, or exports.

import { TTS_LIMITS } from "../../../renderer/shared/tts.js";
import type { TtsWireAudioMime } from "./gemini-wire.js";

export interface StoredTtsAudio {
  bytes: Uint8Array;
  mimeType: TtsWireAudioMime;
  sampleRate: number;
  channels: number;
}

interface AudioEntry extends StoredTtsAudio {
  jobId: string;
  segment: number;
  /** Byte offset within the segment stream consumed by bounded reads. */
  readThrough: number;
}

export interface TtsAudioReadResult {
  bytes: Uint8Array;
  mimeType: TtsWireAudioMime;
  sampleRate: number;
  channels: number;
  /** Total bytes in this segment. */
  segmentBytes: number;
  /** Offset of the first byte returned, for continuation reads. */
  nextOffset: number;
  complete: boolean;
}

export class TtsAudioStore {
  private entries = new Map<string, AudioEntry>();
  private totalBytes = 0;

  private static key(jobId: string, segment: number): string {
    return `${jobId}\u{0}${segment}`;
  }

  get retainedBytes(): number {
    return this.totalBytes;
  }

  /**
   * Bounded insert. Preserves complete soundbites; when retained audio
   * would have to be dropped to make room, throws instead — overflow must
   * fail visibly, never silently skip words (plan §12.2).
   */
  put(
    jobId: string,
    segment: number,
    audio: StoredTtsAudio,
    options: { alreadyConsumed?: boolean } = {},
  ): void {
    if (audio.bytes.byteLength > TTS_LIMITS.segmentAudioMaxBytes) {
      throw new Error("Segment audio exceeds the retained size limit.");
    }
    const key = TtsAudioStore.key(jobId, segment);
    const existing = this.entries.get(key);
    const required = this.totalBytes - (existing?.bytes.byteLength ?? 0) + audio.bytes.byteLength;
    // Playback reads do not consume the replay copy. The service may evict
    // an entire inactive soundbite, never a prefix of the active response.
    if (required > TTS_LIMITS.sessionAudioMaxBytes) {
      throw new Error("audio_buffer_limit");
    }
    if (existing) {
      this.totalBytes -= existing.bytes.byteLength;
      this.entries.delete(key);
    }
    this.entries.set(key, {
      ...audio,
      jobId,
      segment,
      readThrough: options.alreadyConsumed === true ? audio.bytes.byteLength : 0,
    });
    this.totalBytes += audio.bytes.byteLength;
  }

  has(jobId: string, segment: number): boolean {
    return this.entries.has(TtsAudioStore.key(jobId, segment));
  }

  /**
   * Bounded continuation read of one segment. One read per player keeps
   * unbounded PCM from flooding the bridge (plan §10.1).
   */
  read(
    jobId: string,
    segment: number,
    offset: number,
    maxBytes: number,
  ): TtsAudioReadResult | null {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0
    ) {
      return null;
    }
    const entry = this.entries.get(TtsAudioStore.key(jobId, segment));
    if (!entry) return null;
    const limit = Math.min(Math.max(0, Math.floor(maxBytes)), TTS_LIMITS.audioReadMaxBytes);
    const start = Math.max(0, Math.floor(offset));
    if (start >= entry.bytes.byteLength) {
      return {
        bytes: new Uint8Array(0),
        mimeType: entry.mimeType,
        sampleRate: entry.sampleRate,
        channels: entry.channels,
        segmentBytes: entry.bytes.byteLength,
        nextOffset: entry.bytes.byteLength,
        complete: true,
      };
    }
    const slice = entry.bytes.slice(start, Math.min(entry.bytes.byteLength, start + limit));
    if (start <= entry.readThrough) {
      entry.readThrough = Math.max(entry.readThrough, start + slice.byteLength);
    }
    return {
      bytes: slice,
      mimeType: entry.mimeType,
      sampleRate: entry.sampleRate,
      channels: entry.channels,
      segmentBytes: entry.bytes.byteLength,
      nextOffset: start + slice.byteLength,
      complete: start + slice.byteLength >= entry.bytes.byteLength,
    };
  }

  /** Remove a whole soundbite (eviction, cache clear, owner invalidation). */
  releaseJob(jobId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.jobId !== jobId) continue;
      this.totalBytes -= entry.bytes.byteLength;
      this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }
}
