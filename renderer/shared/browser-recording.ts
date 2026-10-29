/**
 * Renderer-safe contract for a video the agent recorded of a browser tab with
 * `browser_recording_start` and `browser_recording_stop`. The completed stop
 * step carries this recap to the transcript on desktop and on paired phones,
 * so the person can watch what the agent recorded.
 *
 * The recap is display-only: the recording's id, type, length and size. It
 * never holds the video, the file's path, the page or its address. The bytes
 * are read separately, from the Mac, for a chat that holds the step.
 */

export const BROWSER_RECORDING_STOP_TOOL_NAME = "browser_recording_stop" as const;
/** MP4 (H.264) plays on every client; WebM is the fallback when H.264 encoding is unavailable. */
export const BROWSER_RECORDING_MIME_TYPES = ["video/mp4", "video/webm"] as const;
export type BrowserRecordingMimeType = (typeof BROWSER_RECORDING_MIME_TYPES)[number];
/** The recorder stops itself at this size. */
export const BROWSER_RECORDING_MAX_BYTES = 128 * 1024 * 1024;
/** The recorder stops itself after five minutes; allow for the stop itself. */
export const BROWSER_RECORDING_MAX_DURATION_MS = 6 * 60_000;
export const BROWSER_RECORDING_ID_PATTERN =
  /^recording-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface BrowserRecordingRecapV1 {
  id: string;
  mimeType: BrowserRecordingMimeType;
  durationMs: number;
  sizeBytes: number;
}

export function isBrowserRecordingId(value: unknown): value is string {
  return typeof value === "string" && BROWSER_RECORDING_ID_PATTERN.test(value);
}

export function browserRecordingExtension(mimeType: BrowserRecordingMimeType): "mp4" | "webm" {
  return mimeType === "video/mp4" ? "mp4" : "webm";
}

/** The recap with exactly these keys, or undefined. */
export function parseBrowserRecordingRecap(value: unknown): BrowserRecordingRecapV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== 4 || !["id", "mimeType", "durationMs", "sizeBytes"].every((key) => keys.includes(key))) {
    return undefined;
  }
  const { id, mimeType, durationMs, sizeBytes } = input;
  if (
    !isBrowserRecordingId(id) ||
    !BROWSER_RECORDING_MIME_TYPES.includes(mimeType as BrowserRecordingMimeType) ||
    !Number.isSafeInteger(durationMs) ||
    (durationMs as number) < 0 ||
    (durationMs as number) > BROWSER_RECORDING_MAX_DURATION_MS ||
    !Number.isSafeInteger(sizeBytes) ||
    (sizeBytes as number) < 1 ||
    (sizeBytes as number) > BROWSER_RECORDING_MAX_BYTES
  ) {
    return undefined;
  }
  return {
    id,
    mimeType: mimeType as BrowserRecordingMimeType,
    durationMs: durationMs as number,
    sizeBytes: sizeBytes as number,
  };
}

/** `0:07`, `1:30`: the length people read on a video. */
export function browserRecordingDurationLabel(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
