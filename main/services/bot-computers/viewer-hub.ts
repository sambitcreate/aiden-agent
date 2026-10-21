/**
 * The Bot computer viewer hub (plan §8.5, viewer option (b)).
 *
 * A loopback HTTP server that speaks the part of serve-sim's helper protocol
 * the device stream client uses with `preferMjpeg`, so the Computer tab and
 * its floating player reuse the Simulator viewer instead of a second one:
 *
 * - `GET /vendor/serve-sim/helper/<vm>/stream.mjpeg`: the computer's screen as
 *   `multipart/x-mixed-replace` JPEG parts, sent only when the screen changed
 *   and at most once per `frameIntervalMs` (about 10 fps).
 * - `GET /vendor/serve-sim/helper/ws?device=<vm>` (WebSocket): touch packets
 *   (0x03) become pointer events in framebuffer pixels, key packets (0x06)
 *   become keysyms, Aiden's scroll packet (0x20) becomes wheel buttons, and
 *   the screen config (0x82) goes out on open and on every resize.
 *
 * The renderer never reaches this server directly. Main's own
 * `startDeviceHubProxy` (`viewer-main.ts`) checks the grant, Host and Origin
 * and adds a per-launch secret header; this hub refuses anything without that
 * header, any other Host, and any Origin but its own, so no other local
 * process or page can drive a Bot's computer through it.
 *
 * Take over: the person's input while the Bot controls the computer calls
 * `control.takeOver(botId, "input")`, which aborts the Bot's action. That
 * first press, and the rest of its gesture, are swallowed, so the person's
 * click never lands in the middle of what the Bot was doing. Once the person
 * has control, input goes straight to the computer. When control returns to
 * the Bot, or a socket closes, any button or key the person still holds is
 * released.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

import { BOT_COMPUTER_VIEWER_SCROLL_TAG } from "../../../renderer/shared/bot-computers.js";
import { DEVICE_ID_PATTERN } from "../../../renderer/shared/devices.js";
import { keysymForHidUsage } from "./keysyms.js";
import type { BotComputerLiveScreen } from "./rfb-screen.js";
import type { BotComputerControl } from "./types.js";

/** The header main's proxy adds to every request; its value is a per-launch secret. */
export const BOT_COMPUTER_VIEWER_KEY_HEADER = "x-aiden-viewer-key";

/** serve-sim's tags, as `renderer/lib/device-stream.ts` sends them. */
const MSG_TOUCH = 0x03;
const MSG_KEY = 0x06;
const MSG_SCROLL = BOT_COMPUTER_VIEWER_SCROLL_TAG;
const TAG_SCREEN_CONFIG = 0x82;

/** Input packets are tiny; anything larger is not the stream client. */
export const VIEWER_MAX_MESSAGE_BYTES = 4_096;
/** One wheel step is about this many pixels of scroll. */
const SCROLL_STEP_PX = 40;
/** At most this many wheel steps per packet, so one flick can't flood the guest. */
const MAX_SCROLL_STEPS = 10;
const BUTTON_LEFT = 1;
const WHEEL_UP = 8;
const WHEEL_DOWN = 16;
const WHEEL_LEFT = 32;
const WHEEL_RIGHT = 64;

const MJPEG_BOUNDARY = "frame";
const STREAM_PATH = /^\/vendor\/serve-sim\/helper\/([^/]+)\/stream\.mjpeg$/u;
const SOCKET_PATH = "/vendor/serve-sim/helper/ws";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface BotComputerViewerHubOptions {
  /** Per-launch secret the proxy sends in `BOT_COMPUTER_VIEWER_KEY_HEADER`. */
  key: string;
  /** The Bot a VM belongs to, while the person may view it; undefined otherwise. */
  botForVm(vmName: string): string | undefined;
  /** The running computer's live screen. It must never start a computer. */
  screen(botId: string, signal: AbortSignal): Promise<BotComputerLiveScreen>;
  control: Pick<BotComputerControl, "controller" | "takeOver" | "onChange">;
  /** Restarts the computer's idle timer. */
  touch(botId: string): void;
  frameIntervalMs?: number;
  jpegQuality?: number;
  maxFrameWidth?: number;
  /** While anyone views a computer, its idle timer restarts this often. */
  keepAliveMs?: number;
  /** Input restarts the idle timer at most this often. */
  inputTouchMs?: number;
  now?(): number;
  log?(message: string, error?: unknown): void;
}

export interface BotComputerViewerHub {
  origin: string;
  /** Open MJPEG streams and input sockets for a Bot's computer. */
  viewers(botId: string): number;
  /** Ends every stream and socket for a VM, e.g. when its computer stops. */
  closeVm(vmName: string): void;
  close(): Promise<void>;
}

interface MjpegClient {
  response: ServerResponse;
  blocked: boolean;
  sentVersion: number;
}

interface InputClient {
  socket: Duplex;
  /** The size last sent as a screen config. */
  configured?: { width: number; height: number };
  /** Framebuffer point of the last pointer event, and the buttons the computer holds there. */
  point: { x: number; y: number };
  buttons: number;
  /** A touch whose press reached the computer and hasn't ended. */
  touching: boolean;
  /** A touch that took over is swallowed until it ends. */
  swallowTouch: boolean;
  /** Keysyms the computer saw go down, by HID usage. */
  keysDown: Map<number, number>;
  /** Keys whose press took over; their release is swallowed too. */
  swallowedKeys: Set<number>;
  scrollRemainder: { x: number; y: number };
  queue: Promise<void>;
}

interface Device {
  vmName: string;
  botId: string;
  abort: AbortController;
  screen?: Promise<BotComputerLiveScreen>;
  mjpeg: Set<MjpegClient>;
  inputs: Set<InputClient>;
  unwatch?: () => void;
  dirty: boolean;
  encoding: boolean;
  lastFrameAt: number;
  frameTimer?: NodeJS.Timeout;
  latest?: { part: Buffer; version: number };
  keepAlive?: NodeJS.Timeout;
  lastInputTouchAt: number;
}

function sameSecret(expected: string, actual: string | string[] | undefined): boolean {
  if (typeof actual !== "string") return false;
  // Digests have one length, so the comparison leaks neither the value nor its size.
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(actual).digest();
  return timingSafeEqual(a, b);
}

function mjpegPart(image: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${image.length}\r\n\r\n`),
    image,
    Buffer.from("\r\n"),
  ]);
}

/** One unmasked server frame. */
function wsFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : Buffer.from([0x80 | opcode, 126, (length >> 8) & 0xff, length & 0xff]);
  return Buffer.concat([header, payload]);
}

function closeFrame(code: number): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return wsFrame(0x8, payload);
}

function screenConfig(width: number, height: number): Buffer {
  return wsFrame(0x2, Buffer.concat([Buffer.from([TAG_SCREEN_CONFIG]), Buffer.from(JSON.stringify({ width, height, orientation: "portrait" }))]));
}

type ParsedFrame = { opcode: number; payload: Buffer; length: number } | { error: number } | undefined;

/** Reads one client frame from `buffer`: masked, final, and small. Undefined until it is complete. */
function readFrame(buffer: Buffer): ParsedFrame {
  if (buffer.length < 2) return undefined;
  const fin = (buffer[0] & 0x80) !== 0;
  const reserved = buffer[0] & 0x70;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  // No extension was negotiated, the client always masks, and its packets are never fragmented.
  if (reserved !== 0 || !masked) return { error: 1002 };
  if (!fin || opcode === 0) return { error: 1003 };
  if (length === 127) return { error: 1009 };
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  if (length > VIEWER_MAX_MESSAGE_BYTES) return { error: 1009 };
  if (buffer.length < offset + 4 + length) return undefined;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return { opcode, payload, length: offset + 4 + length };
}

function parseJson(payload: Buffer): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(payload.subarray(1).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function unit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;
}

function finite(value: unknown, limit: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(limit, Math.max(-limit, value)) : undefined;
}

export async function startBotComputerViewerHub(options: BotComputerViewerHubOptions): Promise<BotComputerViewerHub> {
  const frameIntervalMs = options.frameIntervalMs ?? 100;
  const jpegQuality = options.jpegQuality ?? 70;
  const maxFrameWidth = options.maxFrameWidth ?? 2_560;
  const keepAliveMs = options.keepAliveMs ?? 30_000;
  const inputTouchMs = options.inputTouchMs ?? 5_000;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const devices = new Map<string, Device>();
  const sockets = new Set<Socket>();
  let port = 0;
  let closed = false;

  const unsubscribeControl = options.control.onChange((botId) => {
    if (options.control.controller(botId) !== "bot") return;
    // Give back: nothing the person still holds may stay pressed for the Bot.
    for (const device of devices.values()) {
      if (device.botId !== botId) continue;
      for (const input of device.inputs) releaseHeld(device, input);
    }
  });

  const device = (vmName: string, botId: string): Device => {
    const existing = devices.get(vmName);
    if (existing && existing.botId === botId) return existing;
    if (existing) closeVm(vmName);
    const created: Device = {
      vmName,
      botId,
      abort: new AbortController(),
      mjpeg: new Set(),
      inputs: new Set(),
      dirty: true,
      encoding: false,
      lastFrameAt: 0,
      lastInputTouchAt: 0,
    };
    devices.set(vmName, created);
    return created;
  };

  const openScreen = (target: Device): Promise<BotComputerLiveScreen> => {
    if (!target.screen) {
      const opening = options.screen(target.botId, target.abort.signal).then((screen) => {
        // The run this screen belonged to ended (the computer stopped or restarted): start over.
        if (screen.closed()) {
          closeVm(target.vmName);
          throw new Error("The computer's screen was closed.");
        }
        return screen;
      });
      target.screen = opening;
      opening.catch(() => {
        if (target.screen === opening) target.screen = undefined;
      });
      return opening;
    }
    return target.screen.then((screen) => {
      if (!screen.closed()) return screen;
      closeVm(target.vmName);
      throw new Error("The computer's screen was closed.");
    });
  };

  const viewerCount = (target: Device) => target.mjpeg.size + target.inputs.size;

  /** The first viewer keeps the computer awake; the last one leaving restarts its idle timer. */
  const viewersChanged = (target: Device) => {
    if (viewerCount(target) > 0) {
      if (!target.keepAlive) {
        options.touch(target.botId);
        target.keepAlive = setInterval(() => options.touch(target.botId), keepAliveMs);
        target.keepAlive.unref?.();
      }
      return;
    }
    clearInterval(target.keepAlive);
    target.keepAlive = undefined;
    clearTimeout(target.frameTimer);
    target.frameTimer = undefined;
    target.unwatch?.();
    target.unwatch = undefined;
    target.latest = undefined;
    target.dirty = true;
    options.touch(target.botId);
  };

  const sendPart = (target: Device, client: MjpegClient) => {
    const latest = target.latest;
    if (!latest || client.blocked || client.sentVersion === latest.version || client.response.destroyed) return;
    client.sentVersion = latest.version;
    if (!client.response.write(latest.part)) {
      // A slow viewer skips frames rather than buffering them; it gets the newest once drained.
      client.blocked = true;
      client.response.once("drain", () => {
        client.blocked = false;
        sendPart(target, client);
      });
    }
  };

  const scheduleFrame = (target: Device) => {
    if (closed || target.encoding || target.frameTimer || target.mjpeg.size === 0 || !target.dirty) return;
    const wait = Math.max(0, target.lastFrameAt + frameIntervalMs - now());
    target.frameTimer = setTimeout(() => {
      target.frameTimer = undefined;
      if (target.mjpeg.size === 0 || !target.screen) return;
      target.dirty = false;
      target.encoding = true;
      target.lastFrameAt = now();
      void openScreen(target)
        .then((screen) => screen.jpeg({ quality: jpegQuality, maxWidth: maxFrameWidth }))
        .then((frame) => {
          if (target.latest?.version === frame.version) return;
          target.latest = { part: mjpegPart(frame.image), version: frame.version };
          for (const client of target.mjpeg) sendPart(target, client);
        })
        .catch((error: unknown) => {
          // The screen reconnects on its own while watched; the next change tries again.
          if (target.mjpeg.size > 0) log("A Bot computer frame could not be encoded.", error);
        })
        .finally(() => {
          target.encoding = false;
          scheduleFrame(target);
        });
    }, wait);
    target.frameTimer.unref?.();
  };

  const sendConfig = (input: InputClient, width: number, height: number) => {
    if (input.configured?.width === width && input.configured.height === height) return;
    input.configured = { width, height };
    if (!input.socket.destroyed) input.socket.write(screenConfig(width, height));
  };

  /** Watching keeps updates flowing for the stream and tells every socket about resizes. */
  const watch = (target: Device, screen: BotComputerLiveScreen) => {
    if (target.unwatch) return;
    target.unwatch = screen.watch((update) => {
      target.dirty = true;
      for (const input of target.inputs) sendConfig(input, update.width, update.height);
      scheduleFrame(target);
    });
  };

  const forbidden = (request: IncomingMessage): boolean =>
    !sameSecret(options.key, request.headers[BOT_COMPUTER_VIEWER_KEY_HEADER]) ||
    request.headers.host !== `127.0.0.1:${port}` ||
    (request.headers.origin !== undefined && request.headers.origin !== `http://127.0.0.1:${port}`);

  const deviceFor = (vmName: string | null | undefined): Device | undefined => {
    if (!vmName || !DEVICE_ID_PATTERN.test(vmName)) return undefined;
    const botId = options.botForVm(vmName);
    return botId ? device(vmName, botId) : undefined;
  };

  async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    const answer = (status: number, message: string) => {
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end(message);
    };
    if (forbidden(request)) return answer(403, "Forbidden");
    if (request.method !== "GET" && request.method !== "HEAD") return answer(405, "Method Not Allowed");
    const rawPath = (request.url ?? "").split("?", 1)[0];
    const match = STREAM_PATH.exec(rawPath);
    const target = deviceFor(match?.[1]);
    if (!target) return answer(404, "Not Found");
    let screen: BotComputerLiveScreen;
    try {
      screen = await openScreen(target);
    } catch (error) {
      log("The Bot computer's screen could not be opened for the viewer.", error);
      if (!response.destroyed) answer(503, "The computer's screen isn't available.");
      return;
    }
    if (response.destroyed || devices.get(target.vmName) !== target) {
      if (!response.destroyed) answer(503, "The computer's screen isn't available.");
      return;
    }
    response.writeHead(200, {
      "content-type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
      "cache-control": "no-store, no-transform",
      connection: "close",
    });
    if (request.method === "HEAD") return void response.end();
    const client: MjpegClient = { response, blocked: false, sentVersion: -1 };
    target.mjpeg.add(client);
    response.once("close", () => {
      target.mjpeg.delete(client);
      viewersChanged(target);
    });
    viewersChanged(target);
    watch(target, screen);
    // A new viewer sees the current picture at once when nothing has changed since it was taken.
    if (target.latest && target.latest.version === screen.version()) sendPart(target, client);
    else target.dirty = true;
    scheduleFrame(target);
  }

  const refuseUpgrade = (socket: Duplex, status: number, message: string) => {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  function enqueue(target: Device, input: InputClient, run: (screen: BotComputerLiveScreen) => Promise<void>) {
    input.queue = input.queue
      .then(async () => {
        const screen = await openScreen(target);
        await run(screen);
      })
      .catch((error: unknown) => log("The person's input did not reach the Bot computer.", error));
  }

  /** Lifts what the person holds: the gesture state now, the computer's buttons and keys in input order. */
  function releaseHeld(target: Device, input: InputClient) {
    const keys = [...input.keysDown.values()].reverse();
    input.keysDown.clear();
    input.touching = false;
    input.swallowTouch = false;
    input.swallowedKeys.clear();
    input.scrollRemainder = { x: 0, y: 0 };
    enqueue(target, input, async (screen) => {
      if (input.buttons !== 0) {
        input.buttons = 0;
        await screen.pointer({ ...input.point, buttons: 0 });
      }
      for (const keysym of keys) await screen.key({ keysym, down: false });
    });
  }

  /** True when this input goes to the computer; false when it took over (or the Bot still drives). */
  const personDrives = (target: Device): boolean => {
    if (options.control.controller(target.botId) === "person") return true;
    options.control.takeOver(target.botId, "input");
    return false;
  };

  const inputTouched = (target: Device) => {
    const at = now();
    if (at - target.lastInputTouchAt < inputTouchMs) return;
    target.lastInputTouchAt = at;
    options.touch(target.botId);
  };

  function handleMessage(target: Device, input: InputClient, payload: Buffer) {
    if (payload.length < 2) return;
    const tag = payload[0];
    if (tag !== MSG_TOUCH && tag !== MSG_KEY && tag !== MSG_SCROLL) return;
    const body = parseJson(payload);
    if (!body || !target.screen) return;
    inputTouched(target);

    if (tag === MSG_TOUCH) {
      const phase = body.type;
      const x = unit(body.x);
      const y = unit(body.y);
      if ((phase !== "begin" && phase !== "move" && phase !== "end") || x === undefined || y === undefined) return;
      if (phase === "begin") {
        if (!personDrives(target)) {
          input.swallowTouch = true;
          input.touching = false;
          return;
        }
        input.swallowTouch = false;
        input.touching = true;
      } else if (input.swallowTouch) {
        if (phase === "end") input.swallowTouch = false;
        return;
      } else if (!input.touching || options.control.controller(target.botId) !== "person") {
        // A move or release whose press never reached the computer, or one the Bot got back during.
        input.touching = false;
        return;
      } else if (phase === "end") {
        input.touching = false;
      }
      enqueue(target, input, async (live) => {
        const size = live.size();
        if (!size) return;
        const point = {
          x: Math.min(size.width - 1, Math.floor(x * size.width)),
          y: Math.min(size.height - 1, Math.floor(y * size.height)),
        };
        input.point = point;
        input.buttons = phase === "end" ? 0 : BUTTON_LEFT;
        await live.pointer({ ...point, buttons: input.buttons });
      });
      return;
    }

    if (tag === MSG_KEY) {
      const phase = body.type;
      const usage = body.usage;
      if ((phase !== "down" && phase !== "up") || typeof usage !== "number" || !Number.isInteger(usage)) return;
      const keysym = keysymForHidUsage(usage);
      if (keysym === undefined) return;
      if (phase === "down") {
        if (input.keysDown.has(usage)) return;
        if (!personDrives(target)) {
          input.swallowedKeys.add(usage);
          return;
        }
        input.keysDown.set(usage, keysym);
        enqueue(target, input, (live) => live.key({ keysym, down: true }));
        return;
      }
      if (input.swallowedKeys.delete(usage)) return;
      // Only keys the computer saw go down are released there; Give back already lifted the rest.
      if (!input.keysDown.delete(usage)) return;
      enqueue(target, input, (live) => live.key({ keysym, down: false }));
      return;
    }

    const x = unit(body.x);
    const y = unit(body.y);
    const dx = finite(body.dx, 10_000);
    const dy = finite(body.dy, 10_000);
    if (x === undefined || y === undefined || dx === undefined || dy === undefined) return;
    if (!personDrives(target)) return;
    input.scrollRemainder.x += dx;
    input.scrollRemainder.y += dy;
    const steps = (axis: "x" | "y") => {
      const whole = Math.trunc(input.scrollRemainder[axis] / SCROLL_STEP_PX);
      input.scrollRemainder[axis] -= whole * SCROLL_STEP_PX;
      return Math.max(-MAX_SCROLL_STEPS, Math.min(MAX_SCROLL_STEPS, whole));
    };
    const vertical = steps("y");
    const horizontal = steps("x");
    if (vertical === 0 && horizontal === 0) return;
    enqueue(target, input, async (live) => {
      const size = live.size();
      if (!size) return;
      const point = {
        x: Math.min(size.width - 1, Math.floor(x * size.width)),
        y: Math.min(size.height - 1, Math.floor(y * size.height)),
      };
      input.point = point;
      const wheel = async (mask: number, count: number) => {
        for (let step = 0; step < count; step += 1) {
          await live.pointer({ ...point, buttons: input.buttons | mask });
          await live.pointer({ ...point, buttons: input.buttons });
        }
      };
      await wheel(vertical < 0 ? WHEEL_UP : WHEEL_DOWN, Math.abs(vertical));
      await wheel(horizontal < 0 ? WHEEL_LEFT : WHEEL_RIGHT, Math.abs(horizontal));
    });
  }

  async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => socket.destroy());
    if (forbidden(request)) return refuseUpgrade(socket, 403, "Forbidden");
    if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket") {
      return refuseUpgrade(socket, 400, "Bad Request");
    }
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string" || request.headers["sec-websocket-version"] !== "13") {
      return refuseUpgrade(socket, 400, "Bad Request");
    }
    const [rawPath, query = ""] = (request.url ?? "").split("?", 2);
    const devicesNamed = new URLSearchParams(query).getAll("device");
    const target = rawPath === SOCKET_PATH && devicesNamed.length === 1 ? deviceFor(devicesNamed[0]) : undefined;
    if (!target) return refuseUpgrade(socket, 404, "Not Found");
    let screen: BotComputerLiveScreen;
    try {
      screen = await openScreen(target);
    } catch (error) {
      log("The Bot computer's screen could not be opened for input.", error);
      return refuseUpgrade(socket, 503, "Service Unavailable");
    }
    if (socket.destroyed) return;
    if (devices.get(target.vmName) !== target) return refuseUpgrade(socket, 503, "Service Unavailable");
    const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const input: InputClient = {
      socket,
      point: { x: 0, y: 0 },
      buttons: 0,
      touching: false,
      swallowTouch: false,
      keysDown: new Map(),
      swallowedKeys: new Set(),
      scrollRemainder: { x: 0, y: 0 },
      queue: Promise.resolve(),
    };
    target.inputs.add(input);
    viewersChanged(target);
    let ended = false;
    const end = (code?: number) => {
      if (ended) return;
      ended = true;
      if (code !== undefined && !socket.destroyed) socket.end(closeFrame(code));
      else socket.destroy();
    };
    socket.once("close", () => {
      ended = true;
      if (!target.inputs.delete(input)) return;
      // Only the person's own presses are lifted (while the Bot drives they never reached the
      // computer), and only on a run that is still current.
      if (devices.get(target.vmName) === target && options.control.controller(target.botId) === "person") {
        releaseHeld(target, input);
      }
      viewersChanged(target);
    });
    const size = screen.size();
    if (size) sendConfig(input, size.width, size.height);
    // The config also follows resizes, which arrive while the stream is watched.
    watch(target, screen);

    let buffered: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      if (ended) return;
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      for (;;) {
        const frame = readFrame(buffered);
        if (!frame) {
          if (buffered.length > VIEWER_MAX_MESSAGE_BYTES + 14) end(1009);
          return;
        }
        if ("error" in frame) return end(frame.error);
        buffered = buffered.subarray(frame.length);
        switch (frame.opcode) {
          case 0x2:
            handleMessage(target, input, frame.payload);
            break;
          case 0x8:
            return end(1000);
          case 0x9:
            socket.write(wsFrame(0xa, frame.payload));
            break;
          case 0x1:
          case 0xa:
            break;
          default:
            return end(1002);
        }
      }
    };
    socket.on("data", onData);
    // HTTP servers keep sockets half-open; a viewer that hangs up is gone.
    socket.once("end", () => socket.destroy());
    if (head.length > 0) onData(head);
  }

  const server = createServer((request, response) => void handleRequest(request, response));
  server.on("upgrade", (request, socket, head) => void handleUpgrade(request, socket, head));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;

  function closeVm(vmName: string) {
    const target = devices.get(vmName);
    if (!target) return;
    devices.delete(vmName);
    target.abort.abort();
    clearTimeout(target.frameTimer);
    clearInterval(target.keepAlive);
    target.unwatch?.();
    target.unwatch = undefined;
    for (const client of target.mjpeg) client.response.destroy();
    for (const input of target.inputs) input.socket.destroy();
  }

  return {
    origin: `http://127.0.0.1:${port}`,
    viewers: (botId) => [...devices.values()].filter((target) => target.botId === botId).reduce((sum, target) => sum + viewerCount(target), 0),
    closeVm,
    close: () =>
      new Promise<void>((resolve) => {
        closed = true;
        unsubscribeControl();
        for (const vmName of [...devices.keys()]) closeVm(vmName);
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
