// Where the agent's browser recordings live, and how one is found again by its
// id after a relaunch, so a chat can play the video its tool step names. Only
// an id of the recorder's own shape, in Aiden's own folder, is ever opened.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  BROWSER_RECORDING_MAX_BYTES,
  browserRecordingExtension,
  isBrowserRecordingId,
  type BrowserRecordingMimeType,
} from "../../../renderer/shared/browser-recording.js";

const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const MP4_BOX = Buffer.from("ftyp", "ascii");

export function browserRecordingsFolder(userData: string): string {
  return path.join(userData, "browser", "recordings");
}

/** WebM opens with the EBML header; MP4 with a `ftyp` box. */
export function browserRecordingBytesMatch(bytes: Uint8Array, mimeType: BrowserRecordingMimeType): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 12) return false;
  return mimeType === "video/mp4"
    ? buffer.subarray(4, 8).equals(MP4_BOX)
    : buffer.subarray(0, 4).equals(WEBM_MAGIC);
}

export interface StoredBrowserRecording {
  id: string;
  path: string;
  mimeType: BrowserRecordingMimeType;
  sizeBytes: number;
}

/** The recording saved under [id], or undefined when the id is malformed or the file is gone. */
export async function findBrowserRecording(userData: string, id: string): Promise<StoredBrowserRecording | undefined> {
  if (!isBrowserRecordingId(id)) return undefined;
  const folder = browserRecordingsFolder(userData);
  for (const mimeType of ["video/mp4", "video/webm"] as const) {
    const file = path.join(folder, `${id}.${browserRecordingExtension(mimeType)}`);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size < 1 || stat.size > BROWSER_RECORDING_MAX_BYTES) continue;
      return { id, path: file, mimeType, sizeBytes: stat.size };
    } catch {
      // Not this type; try the other.
    }
  }
  return undefined;
}

/** The video's bytes, checked against its type, or undefined. */
export async function readBrowserRecording(
  userData: string,
  id: string,
): Promise<{ mimeType: BrowserRecordingMimeType; data: Buffer } | undefined> {
  const stored = await findBrowserRecording(userData, id);
  if (!stored) return undefined;
  let data: Buffer;
  try {
    data = await fs.readFile(stored.path);
  } catch {
    return undefined;
  }
  if (data.length > BROWSER_RECORDING_MAX_BYTES || !browserRecordingBytesMatch(data, stored.mimeType)) return undefined;
  return { mimeType: stored.mimeType, data };
}
