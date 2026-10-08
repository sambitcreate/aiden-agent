/**
 * Device power features (erase, clipboard, screen recording, screenshot files)
 * cross the renderer ↔ main boundary only through these fail-closed shapes.
 *
 * Every target names its `platform`, so another platform's variant (Android's
 * adb) can be added beside iOS without changing the contract. Today only iOS
 * simulators on this Mac implement them.
 */
import { DEVICE_HOST_ID_PATTERN, type DevicePlatform } from "./devices.js";

/** Text larger than this is refused by Paste to device and Copy from device. */
export const DEVICE_CLIPBOARD_MAX_BYTES = 64 * 1024;
/** A screen recording stops by itself after this long. */
export const DEVICE_RECORDING_MAX_MS = 10 * 60_000;

const DEVICE_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/u;
const RECORDING_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u;
const CHAT_ID_MAX_LENGTH = 256;
const KNOWN_PLATFORMS: readonly DevicePlatform[] = ["ios"];

export interface DeviceFeatureTarget {
  platform: DevicePlatform;
  hostId: string;
  deviceId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlatform(value: unknown): value is DevicePlatform {
  return typeof value === "string" && (KNOWN_PLATFORMS as readonly string[]).includes(value);
}

/** Fail-closed parse of one device a feature acts on. Unknown keys are dropped. */
export function parseDeviceFeatureTarget(value: unknown): DeviceFeatureTarget | null {
  if (!isRecord(value)) return null;
  const { platform, hostId, deviceId } = value;
  if (!isPlatform(platform)) return null;
  if (typeof hostId !== "string" || !DEVICE_HOST_ID_PATTERN.test(hostId)) return null;
  if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) return null;
  return { platform, hostId, deviceId };
}

export function isDeviceRecordingId(value: unknown): value is string {
  return typeof value === "string" && RECORDING_ID_PATTERN.test(value);
}

export function isDeviceChatId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= CHAT_ID_MAX_LENGTH;
}

const CLIPBOARD_TOO_LARGE = `The clipboard text is larger than ${DEVICE_CLIPBOARD_MAX_BYTES / 1024} KB.`;

export type DeviceClipboardCheck = { ok: true; text: string; bytes: number } | { ok: false; reason: string };

/** Only non-empty text up to `DEVICE_CLIPBOARD_MAX_BYTES` of UTF-8 crosses to or from a device. */
export function checkDeviceClipboardText(value: unknown): DeviceClipboardCheck {
  if (typeof value !== "string") return { ok: false, reason: "Only text can be pasted to the simulator." };
  if (value.length === 0) return { ok: false, reason: "The clipboard has no text." };
  // A UTF-16 length over the cap is always over it in UTF-8 too; skip encoding huge strings.
  if (value.length > DEVICE_CLIPBOARD_MAX_BYTES) return { ok: false, reason: CLIPBOARD_TOO_LARGE };
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > DEVICE_CLIPBOARD_MAX_BYTES) return { ok: false, reason: CLIPBOARD_TOO_LARGE };
  return { ok: true, text: value, bytes };
}

export const DEVICE_RECORDING_STATUSES = ["recording", "stopping", "ready", "failed"] as const;
export type DeviceRecordingStatus = (typeof DEVICE_RECORDING_STATUSES)[number];
/** Why a recording stopped: the user, the duration cap, or the recorder exiting by itself. */
export type DeviceRecordingStopReason = "user" | "max-duration" | "exited";

/** What the renderer sees of one recording. The temp file path never leaves main. */
export interface DeviceRecordingInfo {
  id: string;
  chatId: string;
  platform: DevicePlatform;
  hostId: string;
  deviceId: string;
  status: DeviceRecordingStatus;
  startedAt: number;
  /** When the duration cap stops it. */
  endsBy: number;
  stoppedAt?: number;
  reason?: DeviceRecordingStopReason;
  error?: string;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseDeviceRecordingInfo(value: unknown): DeviceRecordingInfo | null {
  if (!isRecord(value)) return null;
  const target = parseDeviceFeatureTarget(value);
  const { id, chatId, status, startedAt, endsBy, stoppedAt, reason, error } = value;
  if (!target || !isDeviceRecordingId(id) || !isDeviceChatId(chatId)) return null;
  if (!(DEVICE_RECORDING_STATUSES as readonly unknown[]).includes(status)) return null;
  if (!finiteNumber(startedAt) || !finiteNumber(endsBy)) return null;
  if (stoppedAt !== undefined && !finiteNumber(stoppedAt)) return null;
  if (reason !== undefined && reason !== "user" && reason !== "max-duration" && reason !== "exited") return null;
  if (error !== undefined && typeof error !== "string") return null;
  return {
    id,
    chatId,
    ...target,
    status: status as DeviceRecordingStatus,
    startedAt,
    endsBy,
    ...(stoppedAt === undefined ? {} : { stoppedAt }),
    ...(reason === undefined ? {} : { reason }),
    ...(error === undefined ? {} : { error }),
  };
}

export function parseDeviceRecordingList(value: unknown): DeviceRecordingInfo[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const recordings: DeviceRecordingInfo[] = [];
  for (const item of value) {
    const parsed = parseDeviceRecordingInfo(item);
    if (!parsed) return null;
    recordings.push(parsed);
  }
  return recordings;
}

/** The result of a save dialog: the chosen file, or nothing when the user cancelled. */
export type DeviceSaveResult = { status: "saved"; path: string } | { status: "cancelled" };

export function parseDeviceSaveResult(value: unknown): DeviceSaveResult | null {
  if (!isRecord(value)) return null;
  if (value.status === "cancelled") return { status: "cancelled" };
  if (value.status === "saved" && typeof value.path === "string" && value.path.startsWith("/")) {
    return { status: "saved", path: value.path };
  }
  return null;
}

/** `Name-2026-10-08-142530.ext`: the device name kept readable and safe for every file system. */
export function deviceCaptureFileName(deviceName: string, at: Date, extension: "png" | "mp4"): string {
  const name =
    deviceName
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._ -]+/gu, " ")
      .trim()
      .replace(/\s+/gu, "-")
      .replace(/^[.-]+/u, "")
      .slice(0, 80) || "Simulator";
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${name}-${stamp}.${extension}`;
}
