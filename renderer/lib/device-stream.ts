/**
 * Adapted from t3code packages/client-runtime/src/device/stream.ts @ 1c127066 (MIT)
 *
 * Framework-free client for one iOS simulator's stream, reached only through
 * main's token proxy (`grant.origin` + `?t=<token>&host=<hostId>`).
 *
 * - Video is serve-sim's HTTP `stream.avcc` body of length-prefixed envelopes
 *   (`u32be length, u8 tag, payload`; tag 1 avcC description, 2 keyframe,
 *   3 delta, 4 JPEG seed) decoded with WebCodecs onto a canvas. When the
 *   profile cannot be decoded, the MJPEG endpoint becomes an `<img>` source.
 * - Input is the per-device helper socket as `[tag][json]` packets; the
 *   helper pushes its screen config back on the same socket.
 *
 * A hidden tab calls `stop()`, so an idle device costs nothing on the GPU.
 * Timers, fetch, sockets, and codecs are injectable for tests.
 */
import type { DeviceStreamGrant } from "../shared/devices";
import {
  DUO_POSE_IDS,
  createDuoControl,
  type DuoCommand,
  type DuoControlReply,
  type DuoControlState,
  type DuoPose,
} from "./device-duo-control";

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
}

export interface DeviceStreamTarget {
  hostId: string;
  deviceId: string;
  grant: DeviceStreamGrant;
  preferMjpeg?: boolean;
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
  send(data: Uint8Array): void;
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
export const DEVICE_STREAM_FIRST_FRAME_TIMEOUT_MS = 15_000;
export const DEVICE_STREAM_MJPEG_CHECK_MS = 250;
export const DEVICE_STREAM_PRIME_TIMEOUT_MS = 2_000;
const FRAME_DURATION_US = 16_667;
const SOFT_DECODE_QUEUE = 8;

// serve-sim binary WS message tags (browser -> helper).
export const IOS_MSG_TOUCH = 0x03;
export const IOS_MSG_BUTTON = 0x04;
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

/** Build the WebCodecs `avc1.PPCCLL` string from an avcC record. */
export function avcCodecString(bytes: Uint8Array): string {
  if (bytes.length < 4) return "avc1.42E01E";
  const hex = (byte: number) => byte.toString(16).padStart(2, "0");
  return `avc1.${hex(bytes[1]!)}${hex(bytes[2]!)}${hex(bytes[3]!)}`;
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

export type DeviceHardwareButton = "home" | "lock" | "appSwitcher";

export interface DeviceStreamClient {
  start(): void;
  stop(): void;
  /** Own the displayed MJPEG image's source and frame/error observation. `stop()` detaches it. */
  setMjpegImage(image: HTMLImageElement | null): void;
  /** Normalized 0..1 coordinates in the displayed frame. */
  sendTouch(phase: "begin" | "move" | "end", x: number, y: number): void;
  sendKey(code: string, phase: "down" | "up"): void;
  pressButton(button: DeviceHardwareButton): void;
  /** Rotates to the next orientation. On an iPhone Duo this goes through the hinge command queue. */
  rotate(): void;
  setOrientation(orientation: DeviceOrientation): void;
  /** Queues an iPhone Duo hinge command. Ignored unless the screen reports `supportsHingeAngle`. */
  controlDuo(command: DuoCommand): void;
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
  const device = encodeURIComponent(target.deviceId);
  const httpUrl = (path: string) => deviceHubUrl(target, `/vendor/serve-sim${path}`, "http");
  const wsUrl = (path: string) => deviceHubUrl(target, `/vendor/serve-sim${path}`, "ws");
  const useWebCodecs =
    Boolean(runtime.VideoDecoder && runtime.EncodedVideoChunk) && !target.preferMjpeg;
  const videoPath = `/helper/${device}/stream.avcc`;
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
        fallBackToMjpeg();
      },
    });
    return decoder;
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
    if (!support.supported) return false;
    try {
      if (!videoDecoder || videoDecoder.state === "closed") videoDecoder = makeDecoder(Decoder);
      videoDecoder.configure(full);
      return true;
    } catch {
      return false;
    }
  };

  const decode = (isKey: boolean, data: Uint8Array) => {
    const Chunk = runtime.EncodedVideoChunk;
    if (!Chunk || !videoDecoder || videoDecoder.state !== "configured") return;
    if (awaitingKeyframe) {
      if (!isKey) return;
      awaitingKeyframe = false;
    }
    if (videoDecoder.decodeQueueSize > SOFT_DECODE_QUEUE) {
      fallBackToMjpeg();
      return;
    }
    try {
      videoDecoder.decode(new Chunk({ type: isKey ? "key" : "delta", timestamp, data }));
      timestamp += FRAME_DURATION_US;
    } catch {
      fallBackToMjpeg();
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
                fallBackToMjpeg();
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
      // The proxy refuses an expired grant during the HTTP upgrade, which the
      // browser reports as 1006, so any abnormal close renews the grant once.
      if (event.code === 1008 || event.code === 4401 || event.code === 1006) {
        return handleUnauthorized();
      }
      scheduleRetry("input", () => void connectInput());
    };
    ws.onerror = () => ws.close();
  };

  const start = () => {
    if (!stopped) return;
    stopped = false;
    generation++;
    connecting();
    void connectInput();
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
    closeDecoder();
  };

  const send = (payload: Uint8Array) => {
    if (!stopped && socket?.readyState === SOCKET_OPEN) socket.send(payload);
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
    sendTouch: (phase, x, y) => send(taggedJson(IOS_MSG_TOUCH, { type: phase, ...rawPoint(x, y) })),
    sendKey: (code, phase) => {
      const usage = hidUsageForCode(code);
      if (usage !== null) send(taggedJson(IOS_MSG_KEY, { type: phase, usage }));
    },
    pressButton: (button) =>
      send(
        taggedJson(IOS_MSG_BUTTON, {
          button: button === "appSwitcher" ? "app_switcher" : button,
        }),
      ),
    rotate: () => {
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
    setOrientation: (orientation) => send(taggedJson(IOS_MSG_ORIENTATION, { orientation })),
    controlDuo: (command) => {
      if (screen?.supportsHingeAngle) duoControl.enqueue(command);
    },
  };
}
