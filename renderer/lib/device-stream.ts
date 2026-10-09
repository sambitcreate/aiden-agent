/**
 * Adapted from t3code packages/client-runtime/src/device/stream.ts @ 1c127066 (MIT)
 *
 * Framework-free client for one simulator's or emulator's stream, reached
 * only through main's token proxy (`grant.origin` + `?t=<token>&host=<hostId>`).
 * The hub vendors two servers with different wire formats:
 *
 * - iOS (serve-sim): video is the HTTP `stream.avcc` body of length-prefixed
 *   envelopes (`u32be length, u8 tag, payload`; tag 1 avcC description,
 *   2 keyframe, 3 delta, 4 JPEG seed) decoded with WebCodecs onto a canvas.
 *   When the profile cannot be decoded, the MJPEG endpoint becomes an `<img>`
 *   source. Input is the per-device helper socket as `[tag][json]` packets;
 *   the helper pushes its screen config back on the same socket.
 * - Android (serve-emu, adapted from t3code @ a6ec88f7): one WebSocket at
 *   `ws?device=<serial>&frame-meta=1` carries H.264 Annex-B access units
 *   behind a 16-byte "SEMU" header (magic, version, key flag, pts) and takes
 *   JSON gestures upstream. A fold or rotation restarts the encoder at a new
 *   size; the last frame stays on the canvas until the next keyframe.
 *
 * A hidden tab calls `stop()`, so an idle device costs nothing on the GPU.
 * Timers, fetch, sockets, and codecs are injectable for tests.
 */
import type { DevicePlatform, DeviceStreamGrant } from "../shared/devices";
import {
  DUO_POSE_IDS,
  createDuoControl,
  type DuoCommand,
  type DuoControlReply,
  type DuoControlState,
  type DuoPose,
} from "./device-duo-control";
import { createDuoPanelFeeds, type DuoFeed, type DuoFeedEvents, type DuoPanelSinks } from "./device-duo-stream";
import type { DeviceGrantSource } from "./device-grant";

export type { DuoPanelSinks } from "./device-duo-stream";

export type DeviceStreamStatus = "connecting" | "streaming" | "error";
export type DeviceOrientation =
  | "portrait"
  | "portrait_upside_down"
  | "landscape_left"
  | "landscape_right";

export interface DeviceScreenSize {
  width: number;
  height: number;
  orientation: DeviceOrientation;
  /** iPhone Duo fields, reported only by hinged simulators. */
  screenId?: number;
  supportsHingeAngle?: boolean;
  supportsPhysicalOrientation?: boolean;
  hingeAngle?: number;
  hingePose?: DuoPose | null;
  tableMode?: boolean;
  tableModeAvailable?: boolean;
}

export interface DeviceStreamEvents {
  onStatus(status: DeviceStreamStatus, detail?: string): void;
  onScreen(screen: DeviceScreenSize): void;
  /** The proxy rejected the grant; the owner should mint a fresh one and restart. */
  onUnauthorized(): void;
  /**
   * H.264 cannot be decoded here; the owner should show an `<img>` instead of
   * the canvas and attach it with `setMjpegImage` so real frames are observed.
   */
  onMjpegFallback(url: string): void;
  /** Whether touches and keys can currently reach the device. */
  onInputConnected(connected: boolean, detail?: string): void;
  /** Progress of the one in-flight iPhone Duo hinge or orientation command. */
  onDuoControl?(state: DuoControlState): void;
  /** An iPhone Duo display feed cannot be decoded or is not served; the owner should return to the flat view. */
  onDuoUnavailable?(detail?: string): void;
}

export interface DeviceStreamTarget {
  hostId: string;
  deviceId: string;
  grant: DeviceStreamGrant;
  /** Defaults to iOS. */
  platform?: DevicePlatform;
  preferMjpeg?: boolean;
  /** Internal iPhone Duo fixed-display feed (`device-duo-stream.ts`). */
  panelId?: 1 | 3;
  /** Internal feeds decode video only and share their parent's input socket. */
  videoOnly?: boolean;
  /**
   * Mints grants for connections opened after `start` (the iPhone Duo display
   * feeds). Without it those reuse `grant`, which expires a minute after minting.
   */
  grants?: DeviceGrantSource;
}

/** A synchronous, borrowed frame. The producer releases its source after `present` returns. */
export interface DeviceFrameSink {
  present(source: CanvasImageSource, width: number, height: number): boolean;
}

type Timer = ReturnType<typeof setTimeout>;

interface SocketLike {
  readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  send(data: Uint8Array | string): void;
  close(): void;
}

interface DecoderLike {
  state: string;
  decodeQueueSize: number;
  configure(config: VideoDecoderConfig): void;
  decode(chunk: unknown): void;
  close(): void;
}

interface DecoderConstructor {
  new (init: { output: (frame: VideoFrame) => void; error: (error: unknown) => void }): DecoderLike;
  isConfigSupported(config: VideoDecoderConfig): Promise<{ supported?: boolean }>;
}

export interface DeviceStreamRuntime {
  fetch(url: string, init: { signal: AbortSignal; credentials: "omit" }): Promise<Response>;
  createSocket(url: string): SocketLike;
  VideoDecoder?: DecoderConstructor;
  EncodedVideoChunk?: new (init: {
    type: "key" | "delta";
    timestamp: number;
    data: Uint8Array;
  }) => unknown;
  createImageBitmap?: (blob: Blob) => Promise<ImageBitmap>;
  setTimeout(callback: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
  /** Wall-clock milliseconds, compared with `grant.expiresAt`. Defaults to `Date.now`. */
  now?(): number;
}

const SOCKET_OPEN = 1;

export function browserDeviceStreamRuntime(): DeviceStreamRuntime {
  const scope = globalThis as unknown as {
    VideoDecoder?: DecoderConstructor;
    EncodedVideoChunk?: DeviceStreamRuntime["EncodedVideoChunk"];
    createImageBitmap?: DeviceStreamRuntime["createImageBitmap"];
  };
  return {
    fetch: (url, init) => fetch(url, init),
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    ...(scope.VideoDecoder && scope.EncodedVideoChunk
      ? { VideoDecoder: scope.VideoDecoder, EncodedVideoChunk: scope.EncodedVideoChunk }
      : {}),
    ...(scope.createImageBitmap
      ? { createImageBitmap: (blob: Blob) => scope.createImageBitmap!(blob) }
      : {}),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer),
  };
}

export const DEVICE_STREAM_RETRY_DELAY_MS = 1_000;
/** A grant this close to `expiresAt` may already be refused by the proxy. */
export const DEVICE_STREAM_GRANT_EXPIRY_MARGIN_MS = 5_000;
export const DEVICE_STREAM_FIRST_FRAME_TIMEOUT_MS = 15_000;
export const DEVICE_STREAM_MJPEG_CHECK_MS = 250;
export const DEVICE_STREAM_PRIME_TIMEOUT_MS = 2_000;
const FRAME_DURATION_US = 16_667;
const SOFT_DECODE_QUEUE = 8;

// serve-sim binary WS message tags (browser -> helper).
export const IOS_MSG_TOUCH = 0x03;
export const IOS_MSG_BUTTON = 0x04;
/** Two contacts in one packet: `{ type, x1, y1, x2, y2 }`, normalized like a single touch. */
export const IOS_MSG_MULTI_TOUCH = 0x05;
export const IOS_MSG_KEY = 0x06;
export const IOS_MSG_ORIENTATION = 0x07;
export const IOS_MSG_HARDWARE_KEYBOARD = 0x0d;
// helper -> browser.
export const IOS_TAG_SCREEN_CONFIG = 0x82;
/** iPhone Duo hinge commands carry `{ requestId, command }`; the helper answers with IOS_TAG_CONTROL_REPLY. */
export const IOS_MSG_DUO_CONTROL = 0x10;
export const IOS_TAG_CONTROL_REPLY = 0x90;

const encoder = new TextEncoder();
const textDecoder = new TextDecoder();

function taggedJson(tag: number, payload: unknown): Uint8Array {
  const json = encoder.encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + json.length);
  out[0] = tag;
  out.set(json, 1);
  return out;
}

/** Build a proxied hub URL for this target. The grant token and host ride in the query. */
export function deviceHubUrl(
  target: Pick<DeviceStreamTarget, "hostId" | "grant">,
  path: string,
  protocol: "http" | "ws",
): string {
  const url = new URL(path, target.grant.origin);
  if (protocol === "ws") url.protocol = "ws:";
  url.searchParams.set("t", target.grant.token);
  url.searchParams.set("host", target.hostId);
  return url.toString();
}

/** Build the WebCodecs `avc1.PPCCLL` string from an avcC record or an SPS NAL. */
export function avcCodecString(bytes: Uint8Array): string {
  if (bytes.length < 4) return "avc1.42E01E";
  const hex = (byte: number) => byte.toString(16).padStart(2, "0");
  return `avc1.${hex(bytes[1]!)}${hex(bytes[2]!)}${hex(bytes[3]!)}`;
}

const SEMU_MAGIC = 0x53454d55;
const SEMU_HEADER_BYTES = 16;
const SEMU_FLAG_KEY = 1;

/** Split serve-emu's SEMU-framed message into metadata and the Annex-B payload. Unframed messages pass through. */
export function parseSemuPacket(raw: ArrayBuffer): {
  data: Uint8Array;
  isKey: boolean | null;
  timestamp: number | null;
} {
  const bytes = new Uint8Array(raw);
  if (bytes.byteLength > SEMU_HEADER_BYTES) {
    const view = new DataView(raw, 0, SEMU_HEADER_BYTES);
    if (view.getUint32(0, false) === SEMU_MAGIC && view.getUint8(4) === 1) {
      const pts = view.getBigUint64(8, false);
      return {
        data: bytes.subarray(SEMU_HEADER_BYTES),
        isKey: (view.getUint8(5) & SEMU_FLAG_KEY) !== 0,
        timestamp: pts <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pts) : null,
      };
    }
  }
  return { data: bytes, isKey: null, timestamp: null };
}

/** Walk an Annex-B access unit for its keyframe (IDR) flag and SPS bytes. */
export function scanAccessUnit(buf: Uint8Array): { isKey: boolean; sps: Uint8Array | null } {
  let isKey = false;
  let sps: Uint8Array | null = null;
  const length = buf.length;
  let index = 0;
  while (index + 2 < length) {
    if (buf[index] === 0 && buf[index + 1] === 0) {
      let codeLength = 0;
      if (buf[index + 2] === 1) codeLength = 3;
      else if (index + 3 < length && buf[index + 2] === 0 && buf[index + 3] === 1) codeLength = 4;
      if (codeLength) {
        const nalType = buf[index + codeLength]! & 0x1f;
        if (nalType === 7 && !sps) sps = buf.subarray(index + codeLength);
        if (nalType === 5) isKey = true;
        index += codeLength + 1;
        continue;
      }
    }
    index++;
  }
  return { isKey, sps };
}

/** serve-emu announces an encoder restart (a new size after a fold or rotation) as a `video-session` message. */
function isVideoSessionMessage(text: string): boolean {
  try {
    return (JSON.parse(text) as { type?: unknown }).type === "video-session";
  } catch {
    return false;
  }
}

/** Android keycodes for the keys that are not text. */
export const ANDROID_KEYCODE_BY_KEY: Readonly<Record<string, number>> = {
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Tab: 61,
  Enter: 66,
  Backspace: 67,
  Delete: 112,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
};

/** The key as the browser reported it, for platforms that take characters rather than HID usages. */
export interface DeviceKeyDetail {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

/**
 * The serve-emu gesture for one key press: Escape is Back, editing and
 * navigation keys are keycodes, printable characters are text. Releases and
 * shortcuts send nothing.
 */
export function androidKeyMessage(detail: DeviceKeyDetail, phase: "down" | "up"): string | null {
  if (phase !== "down") return null;
  if (detail.key === "Escape") return JSON.stringify({ type: "back" });
  const keycode = ANDROID_KEYCODE_BY_KEY[detail.key];
  if (keycode !== undefined) return JSON.stringify({ type: "key", keycode });
  if (Array.from(detail.key).length === 1 && !detail.metaKey && !detail.ctrlKey) {
    return JSON.stringify({ type: "text", text: detail.key });
  }
  return null;
}

const unit = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Two contacts as serve-emu gestures: one `touch` per finger, told apart by
 * `pointerId` (0 and 1), which both its scrcpy and emulator gRPC input paths
 * carry through as separate pointers. The second finger lands after the first
 * and lifts before it, as a real pinch does. serve-emu refuses coordinates
 * outside 0..1, so they are clamped.
 */
export function androidMultiTouchMessages(
  phase: "begin" | "move" | "end",
  first: { x: number; y: number },
  second: { x: number; y: number },
): string[] {
  const action = phase === "begin" ? "down" : phase === "move" ? "move" : "up";
  const touch = (point: { x: number; y: number }, pointerId: number) =>
    JSON.stringify({ type: "touch", action, x: unit(point.x), y: unit(point.y), pointerId });
  const messages = [touch(first, 0), touch(second, 1)];
  return phase === "end" ? messages.reverse() : messages;
}

export interface AvccChunk {
  type: "description" | "keyframe" | "delta" | "seed";
  payload: Uint8Array;
}

const AVCC_TAGS: Record<number, AvccChunk["type"] | undefined> = {
  1: "description",
  2: "keyframe",
  3: "delta",
  4: "seed",
};

/** Turns a fragmented AVCC byte stream into complete envelopes. Unknown tags are skipped. */
export class AvccDemuxer {
  private buffer = new Uint8Array(64 * 1024);
  private length = 0;

  push(bytes: Uint8Array): AvccChunk[] {
    if (this.length + bytes.length > this.buffer.length) {
      let capacity = this.buffer.length;
      while (capacity < this.length + bytes.length) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;

    const chunks: AvccChunk[] = [];
    let offset = 0;
    while (this.length - offset >= 4) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, 4);
      const frameLength = view.getUint32(0, false);
      if (this.length - offset - 4 < frameLength) break;
      if (frameLength >= 1) {
        const type = AVCC_TAGS[this.buffer[offset + 4]!];
        if (type) {
          chunks.push({ type, payload: this.buffer.slice(offset + 5, offset + 4 + frameLength) });
        }
      }
      offset += 4 + frameLength;
    }
    if (offset > 0) {
      this.buffer.copyWithin(0, offset, this.length);
      this.length -= offset;
    }
    return chunks;
  }

  reset(): void {
    this.length = 0;
  }
}

const HID_USAGE_BY_CODE: Readonly<Record<string, number>> = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  Delete: 0x4c,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7,
};

/** USB HID keyboard usage for a `KeyboardEvent.code`, or null when the simulator has no key for it. */
export function hidUsageForCode(code: string): number | null {
  if (/^Key[A-Z]$/u.test(code)) return 0x04 + (code.charCodeAt(3) - 65);
  if (/^Digit[1-9]$/u.test(code)) return 0x1e + (code.charCodeAt(5) - 49);
  if (code === "Digit0") return 0x27;
  return HID_USAGE_BY_CODE[code] ?? null;
}

const IOS_ORIENTATIONS: readonly DeviceOrientation[] = [
  "portrait",
  "landscape_left",
  "portrait_upside_down",
  "landscape_right",
];

// Adapted from t3code packages/client-runtime/src/device/stream.ts @ 1c127066 (MIT).
// Optional Duo fields that fail validation are dropped rather than rejecting the config.
function parseScreenConfig(value: unknown): DeviceScreenSize | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { width, height, orientation } = record;
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return null;
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return null;
  if (!IOS_ORIENTATIONS.includes(orientation as DeviceOrientation)) return null;
  const config: DeviceScreenSize = { width, height, orientation: orientation as DeviceOrientation };
  if (typeof record.screenId === "number" && Number.isFinite(record.screenId)) {
    config.screenId = record.screenId;
  }
  for (const key of [
    "supportsHingeAngle",
    "supportsPhysicalOrientation",
    "tableMode",
    "tableModeAvailable",
  ] as const) {
    const flag = record[key];
    if (typeof flag === "boolean") config[key] = flag;
  }
  const angle = record.hingeAngle;
  if (typeof angle === "number" && Number.isFinite(angle) && angle >= 0 && angle <= 180) {
    config.hingeAngle = angle;
  }
  if (record.hingePose === null || DUO_POSE_IDS.includes(record.hingePose as DuoPose)) {
    config.hingePose = record.hingePose as DuoPose | null;
  }
  return config;
}

function parseControlReply(value: unknown): DuoControlReply | null {
  if (typeof value !== "object" || value === null) return null;
  const { requestId, ok, error } = value as Record<string, unknown>;
  if (typeof requestId !== "number" || !Number.isInteger(requestId) || typeof ok !== "boolean") {
    return null;
  }
  return { requestId, ok, ...(typeof error === "string" ? { error } : {}) };
}

/** iOS: home, lock, app switcher. Android: home, back, recents, power. */
export type DeviceHardwareButton = "home" | "lock" | "appSwitcher" | "back" | "recents" | "power";

export interface DeviceStreamClient {
  start(): void;
  stop(): void;
  /** Own the displayed MJPEG image's source and frame/error observation. `stop()` detaches it. */
  setMjpegImage(image: HTMLImageElement | null): void;
  /** Normalized 0..1 coordinates in the displayed frame. */
  sendTouch(phase: "begin" | "move" | "end", x: number, y: number): void;
  /** Two simultaneous contacts (pinch, rotate, two-finger pan), normalized like `sendTouch`. */
  sendMultiTouch(
    phase: "begin" | "move" | "end",
    first: { x: number; y: number },
    second: { x: number; y: number },
  ): void;
  /** iOS sends the HID usage for `code`; Android needs `detail` for the character or key name. */
  sendKey(code: string, phase: "down" | "up", detail?: DeviceKeyDetail): void;
  pressButton(button: DeviceHardwareButton): void;
  /** Rotates to the next orientation. On an iPhone Duo this goes through the hinge command queue. */
  rotate(): void;
  setOrientation(orientation: DeviceOrientation): void;
  /** Queues an iPhone Duo hinge command. Ignored unless the screen reports `supportsHingeAngle`. */
  controlDuo(command: DuoCommand): void;
  /** Normalized 0..1 coordinates already in raw framebuffer space, as the iPhone Duo 3D view maps them. */
  sendRawTouch(phase: "begin" | "move" | "end", x: number, y: number): void;
  /** Switches between the one active feed and per-display iPhone Duo feeds without replacing HID. */
  setDuoPanels(panels: DuoPanelSinks | null): void;
}

/** Retains the latest frame in a canvas. */
export function createCanvasFrameSink(canvas: HTMLCanvasElement): DeviceFrameSink {
  return {
    present(source, width, height) {
      const context = canvas.getContext("2d");
      if (!context) return false;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.drawImage(source, 0, 0, width, height);
      return true;
    },
  };
}

export function createDeviceStreamClient(
  target: DeviceStreamTarget,
  output: HTMLCanvasElement | DeviceFrameSink,
  events: DeviceStreamEvents,
  runtime: DeviceStreamRuntime = browserDeviceStreamRuntime(),
): DeviceStreamClient {
  const sink = "present" in output ? output : createCanvasFrameSink(output);
  const platform: DevicePlatform = target.platform ?? "ios";
  const android = platform === "android";
  const vendor = android ? "/vendor/serve-emu" : "/vendor/serve-sim";
  const device = encodeURIComponent(target.deviceId);
  // Connections opened later (a resumed video read) may carry a newer grant from `target.grants`.
  let grant = target.grant;
  const grantExpiring = () => grant.expiresAt - (runtime.now?.() ?? Date.now()) <= DEVICE_STREAM_GRANT_EXPIRY_MARGIN_MS;
  /**
   * The proxy refuses an expired grant during the HTTP upgrade, which the browser
   * reports only as 1006. A 1006 with a live grant is a dropped or refused
   * device connection and takes the normal retry path.
   */
  const refusedGrant = (code: number) =>
    code === 1008 || code === 4401 || (code === 1006 && grantExpiring());
  const httpUrl = (path: string) => deviceHubUrl({ hostId: target.hostId, grant }, `${vendor}${path}`, "http");
  const wsUrl = (path: string) => deviceHubUrl({ hostId: target.hostId, grant }, `${vendor}${path}`, "ws");
  const useWebCodecs =
    Boolean(runtime.VideoDecoder && runtime.EncodedVideoChunk) && !target.preferMjpeg;
  const videoPath = `/helper/${device}${target.panelId ? `/panel/${target.panelId}` : ""}/stream.avcc`;
  const mjpegUrl = () => httpUrl(`/helper/${device}/stream.mjpeg`);

  let stopped = true;
  let socket: SocketLike | null = null;
  let controller: AbortController | null = null;
  const retryTimers = new Map<"video" | "input", Timer>();
  let primeController: AbortController | null = null;
  let videoDecoder: DecoderLike | null = null;
  let timestamp = 0;
  let awaitingKeyframe = true;
  let screen: DeviceScreenSize | null = null;
  let firstFrame = false;
  let configuring = false;
  let mjpeg = false;
  let generation = 0;
  let decoderEpoch = 0;
  let frameTimer: Timer | null = null;
  let videoReadTimer: Timer | null = null;
  let mjpegImage: HTMLImageElement | null = null;
  let releaseImage: (() => void) | null = null;
  let videoGeneration = 0;
  // The next rotation's base on an iPhone Duo, where the reported orientation lags queued commands.
  let rotationCursor: DeviceOrientation | null = null;
  let pendingOrientation: { requestId: number } | null = null;
  const duoControl = createDuoControl({
    send(request) {
      const ws = socket;
      if (stopped || ws?.readyState !== SOCKET_OPEN || !screen?.supportsHingeAngle) return false;
      if (request.command.control === "physical" && !screen.supportsPhysicalOrientation) {
        return false;
      }
      try {
        pendingOrientation = null;
        if (request.command.control === "orientation") {
          // The helper serializes orientation with hinge commands and answers with a new screen config.
          pendingOrientation = { requestId: request.requestId };
          rotationCursor = request.command.value;
          ws.send(taggedJson(IOS_MSG_ORIENTATION, { orientation: request.command.value }));
        } else {
          ws.send(taggedJson(IOS_MSG_DUO_CONTROL, request));
        }
        return true;
      } catch {
        return false;
      }
    },
    onChange(state) {
      if (!state.pending) pendingOrientation = null;
      events.onDuoControl?.(state);
    },
    setTimeout: (callback, ms) => runtime.setTimeout(callback, ms),
    clearTimeout: (timer) => runtime.clearTimeout(timer),
  });

  const setStatus = (status: DeviceStreamStatus, detail?: string) => {
    if (!stopped) events.onStatus(status, detail);
  };

  const clearFrameTimer = () => {
    if (frameTimer !== null) runtime.clearTimeout(frameTimer);
    frameTimer = null;
  };

  const fail = (detail: string) => {
    if (stopped) return;
    stop();
    events.onInputConnected(false, detail);
    events.onStatus("error", detail);
  };

  const connecting = (detail?: string) => {
    firstFrame = false;
    if (frameTimer === null) {
      frameTimer = runtime.setTimeout(
        () => fail("No video received from the simulator. Reconnect to try again."),
        DEVICE_STREAM_FIRST_FRAME_TIMEOUT_MS,
      );
    }
    setStatus("connecting", detail);
  };

  const frameReceived = () => {
    if (firstFrame) return;
    firstFrame = true;
    clearFrameTimer();
    setStatus("streaming");
  };

  const observeMjpegImage = () => {
    releaseImage?.();
    releaseImage = null;
    const image = mjpegImage;
    if (!image || stopped || !mjpeg) return;
    let timer: Timer | null = null;
    let released = false;
    const check = () => {
      if (released || stopped) return;
      if (timer !== null) runtime.clearTimeout(timer);
      timer = null;
      if (image.naturalWidth > 0 && image.naturalHeight > 0) frameReceived();
      // Multipart images may not emit load until the response ends. Stop checking after the first frame.
      else timer = runtime.setTimeout(check, DEVICE_STREAM_MJPEG_CHECK_MS);
    };
    const error = () => {
      if (!released) fail("Could not receive the simulator stream. Reconnect to try again.");
    };
    image.addEventListener("load", check);
    image.addEventListener("error", error);
    releaseImage = () => {
      released = true;
      if (timer !== null) runtime.clearTimeout(timer);
      image.removeEventListener("load", check);
      image.removeEventListener("error", error);
      image.removeAttribute("src");
    };
    image.src = mjpegUrl();
    check();
  };

  const setMjpegImage = (image: HTMLImageElement | null) => {
    if (mjpegImage === image) return;
    releaseImage?.();
    releaseImage = null;
    mjpegImage = image;
    observeMjpegImage();
  };

  const closeDecoder = () => {
    decoderEpoch++;
    try {
      videoDecoder?.close();
    } catch {
      // Already closed.
    }
    videoDecoder = null;
    awaitingKeyframe = true;
  };

  const fallBackToMjpeg = () => {
    if (stopped || mjpeg) return;
    // A Duo display feed has no image fallback; its owner returns to the flat view.
    if (target.videoOnly) return fail("This browser cannot decode the Duo display stream.");
    mjpeg = true;
    controller?.abort();
    controller = null;
    closeDecoder();
    connecting();
    events.onMjpegFallback(mjpegUrl());
    if (!releaseImage) observeMjpegImage();
  };

  const paint = (source: CanvasImageSource, width: number, height: number) => {
    if (stopped) return;
    // serve-emu sends no screen config; the decoded frame's size is the screen.
    if (android && (screen?.width !== width || screen.height !== height)) {
      screen = { width, height, orientation: width > height ? "landscape_left" : "portrait" };
      events.onScreen(screen);
    }
    if (!sink.present(source, width, height)) {
      fail("Could not display the simulator stream. Reconnect to try again.");
      return;
    }
    frameReceived();
  };

  const makeDecoder = (Decoder: DecoderConstructor) => {
    const feedGeneration = videoGeneration;
    const decoder = new Decoder({
      output: (frame) => {
        try {
          if (videoDecoder === decoder && feedGeneration === videoGeneration) {
            paint(frame, frame.displayWidth, frame.displayHeight);
          }
        } finally {
          frame.close();
        }
      },
      error: () => {
        if (stopped || videoDecoder !== decoder || feedGeneration !== videoGeneration) return;
        recoverDecoder();
      },
    });
    return decoder;
  };

  /** iOS falls back to MJPEG; Android has no MJPEG, so it rebuilds the decoder from the next keyframe. */
  const recoverDecoder = () => {
    if (!android) {
      fallBackToMjpeg();
      return;
    }
    closeDecoder();
    connecting("Video decoder restarted.");
    requestKeyframe();
  };

  const requestKeyframe = () => {
    if (android && socket?.readyState === SOCKET_OPEN) socket.send(JSON.stringify({ type: "reset-video", ack: false }));
  };

  /** Returns false when this H.264 profile cannot be decoded; the caller falls back to MJPEG. */
  const configureDecoder = async (
    config: VideoDecoderConfig,
    isCurrent: () => boolean,
  ): Promise<boolean> => {
    const Decoder = runtime.VideoDecoder;
    if (!Decoder) return false;
    const epoch = decoderEpoch;
    const full: VideoDecoderConfig = { ...config, optimizeForLatency: true };
    const support = await Decoder.isConfigSupported(full).catch(() => ({ supported: false }));
    if (!isCurrent() || epoch !== decoderEpoch) return false;
    if (!support.supported) {
      if (android) fail(`This Mac cannot decode the emulator's ${config.codec} video.`);
      return false;
    }
    try {
      if (!videoDecoder || videoDecoder.state === "closed") videoDecoder = makeDecoder(Decoder);
      videoDecoder.configure(full);
      return true;
    } catch (cause) {
      if (android) fail(`The emulator video could not be decoded: ${cause instanceof Error ? cause.message : String(cause)}`);
      return false;
    }
  };

  const decode = (isKey: boolean, data: Uint8Array, pts?: number | null) => {
    const Chunk = runtime.EncodedVideoChunk;
    if (!Chunk || !videoDecoder || videoDecoder.state !== "configured") return;
    if (awaitingKeyframe) {
      if (!isKey) return;
      awaitingKeyframe = false;
    }
    if (videoDecoder.decodeQueueSize > SOFT_DECODE_QUEUE) {
      recoverDecoder();
      return;
    }
    try {
      videoDecoder.decode(new Chunk({ type: isKey ? "key" : "delta", timestamp: pts ?? timestamp, data }));
      timestamp += FRAME_DURATION_US;
    } catch {
      recoverDecoder();
    }
  };

  const scheduleRetry = (channel: "video" | "input", run: () => void) => {
    if (stopped || retryTimers.has(channel)) return;
    retryTimers.set(
      channel,
      runtime.setTimeout(() => {
        retryTimers.delete(channel);
        run();
      }, DEVICE_STREAM_RETRY_DELAY_MS),
    );
  };

  const handleUnauthorized = () => {
    stop();
    events.onInputConnected(false);
    events.onUnauthorized();
  };

  const readVideo = async () => {
    const lifecycle = generation;
    const feedGeneration = ++videoGeneration;
    const demuxer = new AvccDemuxer();
    const videoController = new AbortController();
    controller = videoController;
    const isCurrent = () =>
      !stopped &&
      generation === lifecycle &&
      videoGeneration === feedGeneration &&
      controller === videoController;
    let retryDetail: string | undefined;
    try {
      const response = await runtime.fetch(httpUrl(videoPath), {
        signal: videoController.signal,
        credentials: "omit",
      });
      if (!isCurrent()) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      if (response.status === 401 || response.status === 403) return handleUnauthorized();
      if (target.panelId && [400, 404, 405, 410].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        return fail("This Device Hub does not provide fixed Duo display feeds.");
      }
      if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
      const reader = response.body.getReader();
      for (;;) {
        // An AVCC body can stay open after its helper stops producing frames.
        const timer = runtime.setTimeout(() => {
          if (isCurrent()) fail("The simulator stream stopped receiving video. Reconnect to try again.");
        }, DEVICE_STREAM_FIRST_FRAME_TIMEOUT_MS);
        videoReadTimer = timer;
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } finally {
          runtime.clearTimeout(timer);
          if (videoReadTimer === timer) videoReadTimer = null;
        }
        const { done, value } = result;
        if (!isCurrent()) return;
        if (done) break;
        for (const chunk of demuxer.push(value)) {
          switch (chunk.type) {
            case "seed": {
              const createBitmap = runtime.createImageBitmap;
              if (!createBitmap) break;
              void createBitmap(new Blob([chunk.payload as BlobPart], { type: "image/jpeg" }))
                .then((bitmap) => {
                  try {
                    if (isCurrent()) paint(bitmap, bitmap.width, bitmap.height);
                  } finally {
                    bitmap.close();
                  }
                })
                .catch(() => undefined);
              break;
            }
            case "description": {
              awaitingKeyframe = true;
              const configured = await configureDecoder(
                { codec: avcCodecString(chunk.payload), description: chunk.payload },
                isCurrent,
              );
              if (!isCurrent()) return;
              if (!configured) {
                await reader.cancel().catch(() => undefined);
                if (!isCurrent()) return;
                if (target.videoOnly) {
                  fail(`This browser cannot decode the Duo display's ${avcCodecString(chunk.payload)} stream.`);
                } else fallBackToMjpeg();
                return;
              }
              break;
            }
            case "keyframe":
            case "delta":
              decode(chunk.type === "keyframe", chunk.payload);
              break;
          }
        }
      }
    } catch (cause) {
      if (!isCurrent()) return;
      retryDetail = cause instanceof Error ? cause.message : String(cause);
    }
    if (isCurrent()) {
      controller = null;
      videoController.abort();
      closeDecoder();
      connecting(retryDetail);
      scheduleRetry("video", () => void readVideo());
    }
  };

  /**
   * serve-sim's helper only accepts HID and pushes its screen config once
   * screen capture is running, and the AVCC stream does not reliably start
   * it. Touching the MJPEG endpoint does; one aborted request is enough.
   */
  const primeHelper = async (session: number) => {
    const prime = new AbortController();
    primeController = prime;
    const timeout = runtime.setTimeout(() => prime.abort(), DEVICE_STREAM_PRIME_TIMEOUT_MS);
    try {
      const response = await runtime.fetch(mjpegUrl(), { signal: prime.signal, credentials: "omit" });
      if (stopped || generation !== session) return;
      if (response.status === 401 || response.status === 403) return handleUnauthorized();
      await response.body?.getReader().read();
    } catch {
      // A failed prime just means the socket may take a retry to come up.
    } finally {
      runtime.clearTimeout(timeout);
      prime.abort();
      if (primeController === prime) primeController = null;
    }
  };

  const connectInput = async () => {
    if (stopped) return;
    const session = generation;
    await primeHelper(session);
    if (stopped || generation !== session) return;
    const ws = runtime.createSocket(wsUrl(`/helper/ws?device=${device}`));
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onopen = () => {
      if (stopped || socket !== ws) return;
      ws.send(taggedJson(IOS_MSG_HARDWARE_KEYBOARD, { enabled: false }));
      events.onInputConnected(true);
    };
    ws.onmessage = (event) => {
      if (stopped || socket !== ws || !(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      if (bytes[0] !== IOS_TAG_SCREEN_CONFIG && bytes[0] !== IOS_TAG_CONTROL_REPLY) return;
      try {
        const payload: unknown = JSON.parse(textDecoder.decode(bytes.subarray(1)));
        if (bytes[0] === IOS_TAG_CONTROL_REPLY) {
          const reply = parseControlReply(payload);
          if (reply) duoControl.receive(reply);
          return;
        }
        const config = parseScreenConfig(payload);
        if (!config) return;
        const previous = screen;
        screen = config;
        if (config.hingePose && config.hingePose !== previous?.hingePose) {
          rotationCursor = config.hingePose === "laptop" ? "landscape_left" : "portrait";
        } else if (config.orientation !== previous?.orientation) {
          rotationCursor = config.orientation;
        }
        duoPanels.screenChanged(previous, config);
        events.onScreen(config);
        if (pendingOrientation) {
          const receipt = pendingOrientation;
          pendingOrientation = null;
          duoControl.receive({ requestId: receipt.requestId, ok: true });
        }
      } catch {
        // Ignore malformed frames.
      }
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      duoControl.clear();
      rotationCursor = null;
      if (stopped) return;
      events.onInputConnected(
        false,
        event.reason || (event.code === 1006 ? "input socket refused" : `closed ${event.code}`),
      );
      if (refusedGrant(event.code)) return handleUnauthorized();
      scheduleRetry("input", () => void connectInput());
    };
    ws.onerror = () => ws.close();
  };

  // Android: one socket for video down and gestures up.
  const connectAndroid = () => {
    if (stopped) return;
    const ws = runtime.createSocket(wsUrl(`/ws?device=${device}&frame-meta=1`));
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onopen = () => {
      if (stopped || socket !== ws) return;
      connecting();
      events.onInputConnected(true);
    };
    ws.onmessage = (event) => {
      if (stopped || socket !== ws) return;
      if (typeof event.data === "string") {
        // The encoder restarted at a new size; the next keyframe carries a fresh SPS.
        if (isVideoSessionMessage(event.data)) {
          closeDecoder();
          configuring = false;
          connecting();
          requestKeyframe();
        }
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      const packet = parseSemuPacket(event.data);
      const unconfigured = !videoDecoder || videoDecoder.state !== "configured";
      const scanned = packet.isKey === null || (packet.isKey && unconfigured) ? scanAccessUnit(packet.data) : null;
      const isKey = packet.isKey ?? scanned?.isKey ?? false;
      if (scanned?.sps && unconfigured) {
        if (configuring) return;
        configuring = true;
        const epoch = decoderEpoch;
        const isCurrent = () => !stopped && socket === ws;
        void configureDecoder({ codec: avcCodecString(scanned.sps) }, isCurrent).then((configured) => {
          if (!isCurrent() || epoch !== decoderEpoch) return;
          configuring = false;
          awaitingKeyframe = true;
          if (configured) requestKeyframe();
        });
        return;
      }
      if (unconfigured) {
        if (!isKey) requestKeyframe();
        return;
      }
      decode(isKey, packet.data, packet.timestamp);
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      closeDecoder();
      if (stopped) return;
      events.onInputConnected(false, event.reason || `closed ${event.code}`);
      if (refusedGrant(event.code)) return handleUnauthorized();
      configuring = false;
      connecting(event.reason || undefined);
      scheduleRetry("input", connectAndroid);
    };
    ws.onerror = () => ws.close();
  };

  const start = () => {
    if (!stopped) return;
    stopped = false;
    generation++;
    configuring = false;
    connecting();
    if (android) {
      if (useWebCodecs) connectAndroid();
      else fail("This Mac cannot decode the emulator stream (WebCodecs is unavailable).");
      return;
    }
    if (!target.videoOnly) void connectInput();
    if (useWebCodecs) void readVideo();
    else fallBackToMjpeg();
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    generation++;
    videoGeneration++;
    mjpeg = false;
    clearFrameTimer();
    if (videoReadTimer !== null) runtime.clearTimeout(videoReadTimer);
    videoReadTimer = null;
    releaseImage?.();
    releaseImage = null;
    mjpegImage = null;
    for (const timer of retryTimers.values()) runtime.clearTimeout(timer);
    retryTimers.clear();
    primeController?.abort();
    primeController = null;
    controller?.abort();
    controller = null;
    const discarded = socket;
    socket = null;
    discarded?.close();
    duoControl.clear();
    rotationCursor = null;
    duoPanels.stop();
    closeDecoder();
  };

  const send = (payload: Uint8Array | string) => {
    if (!stopped && socket?.readyState === SOCKET_OPEN) socket.send(payload);
  };

  const duoPanels = createDuoPanelFeeds({
    screen: () => screen,
    canAttach: () => !android && !target.videoOnly && !stopped,
    // Display feeds paint the flat canvas too, and count as this stream's frames.
    primary: {
      present(source, width, height) {
        const presented = sink.present(source, width, height);
        if (presented) frameReceived();
        return presented;
      },
    },
    pausePrimaryVideo: () => {
      videoGeneration++;
      controller?.abort();
      controller = null;
      closeDecoder();
      const retry = retryTimers.get("video");
      if (retry !== undefined) runtime.clearTimeout(retry);
      retryTimers.delete("video");
    },
    resumePrimaryVideo: () => {
      if (!useWebCodecs || mjpeg) return;
      if (!target.grants) return void readVideo();
      // The 3D view may have held the display feeds for longer than the original grant lives.
      const paused = videoGeneration;
      const current = () => !stopped && videoGeneration === paused;
      target.grants.get().then(
        (fresh) => {
          if (!current()) return;
          grant = fresh;
          void readVideo();
        },
        () => {
          if (current()) void readVideo();
        },
      );
    },
    openFeed: (panelId, feedSink, feedEvents) => openPanelFeed(panelId, feedSink, feedEvents),
    onUnavailable: (detail) => events.onDuoUnavailable?.(detail),
    // A refused display feed returns the viewer to the flat view; the parent's session stays.
    onUnauthorized: () => events.onDuoUnavailable?.("The iPhone Duo display stream refused access."),
  });

  /**
   * A video-only display feed. Each open draws a grant from `target.grants`, so
   * a feed opened long after the parent connected never presents an expired
   * one. A refused feed renews its own grant once; a second refusal in a row is
   * reported to the panel host, never to the parent session.
   */
  const openPanelFeed = (
    panelId: 1 | 3 | null,
    feedSink: DeviceFrameSink,
    feedEvents: DuoFeedEvents,
  ): DuoFeed => {
    const grants = target.grants;
    let closed = true;
    let client: DeviceStreamClient | null = null;
    let renewed = false;
    const open = () => {
      const pending = grants ? grants.get() : Promise.resolve(grant);
      pending.then(
        (fresh) => {
          if (closed) return;
          const feed = createDeviceStreamClient(
            { ...target, grant: fresh, ...(panelId === null ? {} : { panelId }), videoOnly: true },
            feedSink,
            {
              onStatus: (status, detail) => {
                if (status === "streaming") renewed = false;
                feedEvents.onStatus(status, detail);
              },
              onScreen: () => undefined,
              onUnauthorized: () => {
                if (client === feed) client = null;
                if (closed) return;
                if (!grants || renewed) return feedEvents.onUnauthorized();
                renewed = true;
                grants.invalidate();
                open();
              },
              onMjpegFallback: () => undefined,
              onInputConnected: () => undefined,
            },
            runtime,
          );
          client = feed;
          feed.start();
        },
        (error: unknown) => {
          if (!closed) feedEvents.onStatus("error", error instanceof Error ? error.message : undefined);
        },
      );
    };
    return {
      start() {
        if (!closed) return;
        closed = false;
        renewed = false;
        open();
      },
      stop() {
        closed = true;
        client?.stop();
        client = null;
      },
    };
  };

  const rawPoint = (x: number, y: number) => {
    // serve-sim streams the raw portrait framebuffer; rotated devices need
    // input remapped into that raw space.
    if (!screen || screen.width > screen.height) return { x, y };
    switch (screen.orientation) {
      case "landscape_left":
        return { x: y, y: 1 - x };
      case "landscape_right":
        return { x: 1 - y, y: x };
      case "portrait_upside_down":
        return { x: 1 - x, y: 1 - y };
      default:
        return { x, y };
    }
  };

  return {
    start,
    stop,
    setMjpegImage,
    sendTouch: (phase, x, y) => {
      if (android) {
        send(JSON.stringify({ type: "touch", action: phase === "begin" ? "down" : phase === "move" ? "move" : "up", x, y }));
        return;
      }
      send(taggedJson(IOS_MSG_TOUCH, { type: phase, ...rawPoint(x, y) }));
    },
    sendMultiTouch: (phase, first, second) => {
      if (android) {
        for (const message of androidMultiTouchMessages(phase, first, second)) send(message);
        return;
      }
      const a = rawPoint(first.x, first.y);
      const b = rawPoint(second.x, second.y);
      send(taggedJson(IOS_MSG_MULTI_TOUCH, { type: phase, x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
    },
    sendKey: (code, phase, detail) => {
      if (android) {
        const message = detail ? androidKeyMessage(detail, phase) : null;
        if (message) send(message);
        return;
      }
      const usage = hidUsageForCode(code);
      if (usage !== null) send(taggedJson(IOS_MSG_KEY, { type: phase, usage }));
    },
    pressButton: (button) => {
      if (android) {
        const type = button === "appSwitcher" ? "recents" : button === "lock" ? "power" : button;
        if (type === "home" || type === "back" || type === "recents" || type === "power") send(JSON.stringify({ type }));
        return;
      }
      if (button !== "home" && button !== "lock" && button !== "appSwitcher") return;
      send(taggedJson(IOS_MSG_BUTTON, { button: button === "appSwitcher" ? "app_switcher" : button }));
    },
    rotate: () => {
      // Android rotates through the setOrientation action, which tilts the emulator's sensor.
      if (android) return;
      const current = screen?.supportsHingeAngle
        ? (rotationCursor ?? screen.orientation)
        : (screen?.orientation ?? "portrait");
      const next =
        IOS_ORIENTATIONS[(IOS_ORIENTATIONS.indexOf(current) + 1) % IOS_ORIENTATIONS.length]!;
      if (screen?.supportsHingeAngle) {
        rotationCursor = next;
        duoControl.enqueue({ control: "orientation", value: next });
      } else {
        send(taggedJson(IOS_MSG_ORIENTATION, { orientation: next }));
      }
    },
    setOrientation: (orientation) => {
      if (!android) send(taggedJson(IOS_MSG_ORIENTATION, { orientation }));
    },
    controlDuo: (command) => {
      if (screen?.supportsHingeAngle) duoControl.enqueue(command);
    },
    sendRawTouch: (phase, x, y) => {
      if (!android) send(taggedJson(IOS_MSG_TOUCH, { type: phase, x, y }));
    },
    setDuoPanels: (panels) => duoPanels.set(panels),
  };
}
