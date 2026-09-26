// Adapted from t3code packages/client-runtime/src/device/stream.test.ts @ 1c127066 (MIT)
import assert from "node:assert/strict";
import test from "node:test";

import {
  AvccDemuxer,
  DEVICE_STREAM_FIRST_FRAME_TIMEOUT_MS,
  DEVICE_STREAM_MJPEG_CHECK_MS,
  DEVICE_STREAM_PRIME_TIMEOUT_MS,
  DEVICE_STREAM_RETRY_DELAY_MS,
  IOS_MSG_BUTTON,
  IOS_MSG_DUO_CONTROL,
  IOS_MSG_HARDWARE_KEYBOARD,
  IOS_MSG_KEY,
  IOS_MSG_ORIENTATION,
  IOS_MSG_TOUCH,
  IOS_TAG_CONTROL_REPLY,
  IOS_TAG_SCREEN_CONFIG,
  avcCodecString,
  createDeviceStreamClient,
  deviceHubUrl,
  hidUsageForCode,
  type DeviceFrameSink,
  type DeviceStreamEvents,
  type DeviceStreamRuntime,
  type DeviceStreamTarget,
} from "./device-stream";

const target: DeviceStreamTarget = {
  hostId: "local",
  deviceId: "ABCD-1234",
  grant: { origin: "http://127.0.0.1:4100", token: "tok", expiresAt: Date.now() + 60_000 },
};

// ---- fakes -----------------------------------------------------------------

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    setTimeout(callback: () => void, ms: number) {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>) {
      timers.delete(timer as unknown as number);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let due: [number, { at: number; callback: () => void }] | null = null;
        for (const entry of timers) {
          if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
        }
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

class FakeSocket {
  readyState = 0;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Uint8Array[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop(code: number, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

/** A controllable streaming response body. */
function streamBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  return {
    response: new Response(body, { status: 200 }),
    push: (bytes: Uint8Array) => controller.enqueue(bytes),
    end: () => controller.close(),
  };
}

type FetchHandler = (url: string, signal: AbortSignal) => Promise<Response>;

function harness(options: { webCodecs?: boolean; preferMjpeg?: boolean } = {}) {
  const clock = fakeClock();
  const sockets: FakeSocket[] = [];
  const fetches: string[] = [];
  const log: string[] = [];
  const presented: Array<{ width: number; height: number }> = [];
  let presentResult = true;
  const handlers: { mjpeg: FetchHandler; avcc: FetchHandler } = {
    // By default the prime request resolves with an empty, finished body.
    mjpeg: async () => new Response(new Uint8Array([1]), { status: 200 }),
    avcc: async () => new Response(null, { status: 503 }),
  };
  const decoders: FakeDecoder[] = [];
  let supported = true;

  class FakeDecoder {
    static isConfigSupported = async () => ({ supported });
    state = "unconfigured";
    decodeQueueSize = 0;
    decoded: Array<{ type: string }> = [];
    constructor(readonly init: { output: (frame: VideoFrame) => void; error: (e: unknown) => void }) {
      decoders.push(this);
    }
    configure() {
      this.state = "configured";
    }
    decode(chunk: { type: string }) {
      this.decoded.push(chunk);
    }
    close() {
      this.state = "closed";
    }
  }
  class FakeChunk {
    type: string;
    constructor(init: { type: string }) {
      this.type = init.type;
    }
  }

  const runtime: DeviceStreamRuntime = {
    fetch: (url, init) => {
      fetches.push(url);
      return url.includes("stream.avcc")
        ? handlers.avcc(url, init.signal)
        : handlers.mjpeg(url, init.signal);
    },
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    ...(options.webCodecs
      ? {
          VideoDecoder: FakeDecoder as unknown as NonNullable<DeviceStreamRuntime["VideoDecoder"]>,
          EncodedVideoChunk: FakeChunk as unknown as NonNullable<
            DeviceStreamRuntime["EncodedVideoChunk"]
          >,
        }
      : {}),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  const sink: DeviceFrameSink = {
    present(_source, width, height) {
      presented.push({ width, height });
      return presentResult;
    },
  };
  const events: DeviceStreamEvents = {
    onStatus: (status, detail) => log.push(detail ? `status:${status}:${detail}` : `status:${status}`),
    onScreen: (screen) => log.push(`screen:${screen.width}x${screen.height}:${screen.orientation}`),
    onUnauthorized: () => log.push("unauthorized"),
    onMjpegFallback: (url) => log.push(`mjpeg:${url}`),
    onInputConnected: (connected) => log.push(`input:${connected}`),
    onDuoControl: (state) => log.push(`duo:${state.pending}:${state.error ?? ""}`),
  };
  const client = createDeviceStreamClient(
    { ...target, preferMjpeg: options.preferMjpeg },
    sink,
    events,
    runtime,
  );
  return {
    client,
    clock,
    sockets,
    fetches,
    log,
    presented,
    handlers,
    decoders,
    setSupported: (value: boolean) => {
      supported = value;
    },
    failPresent: () => {
      presentResult = false;
    },
  };
}

const settle = async (rounds = 10) => {
  for (let index = 0; index < rounds; index++) await new Promise((r) => setImmediate(r));
};

function envelope(tag: number, payload: number[]): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length + 1, false);
  out[4] = tag;
  out.set(payload, 5);
  return out;
}

function decodePacket(bytes: Uint8Array) {
  return { tag: bytes[0], body: JSON.parse(new TextDecoder().decode(bytes.subarray(1))) };
}

class FakeImage {
  naturalWidth = 0;
  naturalHeight = 0;
  src = "";
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

// ---- pure helpers ----------------------------------------------------------

test("AvccDemuxer reassembles envelopes split across reads and skips unknown tags", () => {
  const demuxer = new AvccDemuxer();
  const bytes = new Uint8Array([
    ...envelope(1, [1, 0x64, 0x00, 0x1f]),
    ...envelope(9, [7, 7]),
    ...envelope(2, [5, 6, 7]),
  ]);
  const first = demuxer.push(bytes.subarray(0, 6));
  assert.deepEqual(first, []);
  const rest = demuxer.push(bytes.subarray(6));
  assert.deepEqual(
    rest.map((chunk) => [chunk.type, [...chunk.payload]]),
    [
      ["description", [1, 0x64, 0x00, 0x1f]],
      ["keyframe", [5, 6, 7]],
    ],
  );
});

test("AvccDemuxer grows past its initial buffer", () => {
  const demuxer = new AvccDemuxer();
  const payload = new Array(200_000).fill(3);
  const chunks = demuxer.push(envelope(3, payload));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.type, "delta");
  assert.equal(chunks[0]!.payload.length, 200_000);
});

test("avcCodecString reads profile, constraints, and level", () => {
  assert.equal(avcCodecString(new Uint8Array([1, 0x64, 0x00, 0x1f])), "avc1.64001f");
  assert.equal(avcCodecString(new Uint8Array([1, 0x42])), "avc1.42E01E");
});

test("hidUsageForCode maps letters, digits, and named keys", () => {
  assert.equal(hidUsageForCode("KeyA"), 0x04);
  assert.equal(hidUsageForCode("KeyZ"), 0x1d);
  assert.equal(hidUsageForCode("Digit1"), 0x1e);
  assert.equal(hidUsageForCode("Digit0"), 0x27);
  assert.equal(hidUsageForCode("Enter"), 0x28);
  assert.equal(hidUsageForCode("ArrowUp"), 0x52);
  assert.equal(hidUsageForCode("MetaRight"), 0xe7);
  assert.equal(hidUsageForCode("F13"), null);
});

test("deviceHubUrl carries the grant token and host for http and ws", () => {
  assert.equal(
    deviceHubUrl(target, "/vendor/serve-sim/helper/ABCD-1234/stream.mjpeg", "http"),
    "http://127.0.0.1:4100/vendor/serve-sim/helper/ABCD-1234/stream.mjpeg?t=tok&host=local",
  );
  assert.equal(
    deviceHubUrl({ ...target, hostId: "ssh-1" }, "/vendor/serve-sim/helper/ws?device=ABCD-1234", "ws"),
    "ws://127.0.0.1:4100/vendor/serve-sim/helper/ws?device=ABCD-1234&t=tok&host=ssh-1",
  );
});

// ---- input socket ----------------------------------------------------------

test("input socket primes the helper, disables the hardware keyboard, and sends tagged input", async () => {
  const h = harness();
  h.client.start();
  await settle();
  assert.match(h.fetches[0]!, /helper\/ABCD-1234\/stream\.mjpeg\?t=tok&host=local$/);
  assert.equal(h.sockets.length, 1);
  assert.equal(
    h.sockets[0]!.url,
    "ws://127.0.0.1:4100/vendor/serve-sim/helper/ws?device=ABCD-1234&t=tok&host=local",
  );
  h.sockets[0]!.open();
  assert.deepEqual(decodePacket(h.sockets[0]!.sent[0]!), {
    tag: IOS_MSG_HARDWARE_KEYBOARD,
    body: { enabled: false },
  });
  assert.ok(h.log.includes("input:true"));

  h.client.sendTouch("begin", 0.25, 0.5);
  h.client.pressButton("appSwitcher");
  h.client.pressButton("lock");
  h.client.rotate();
  h.client.sendKey("KeyB", "down");
  h.client.sendKey("F13", "down");
  const packets = h.sockets[0]!.sent.slice(1).map(decodePacket);
  assert.deepEqual(packets, [
    { tag: IOS_MSG_TOUCH, body: { type: "begin", x: 0.25, y: 0.5 } },
    { tag: IOS_MSG_BUTTON, body: { button: "app_switcher" } },
    { tag: IOS_MSG_BUTTON, body: { button: "lock" } },
    { tag: IOS_MSG_ORIENTATION, body: { orientation: "landscape_left" } },
    { tag: IOS_MSG_KEY, body: { type: "down", usage: 0x05 } },
  ]);
  h.client.stop();
});

test("screen config remaps touches from a rotated device into raw portrait space", async () => {
  const h = harness();
  h.client.start();
  await settle();
  const socket = h.sockets[0]!;
  socket.open();
  const config = new TextEncoder().encode(
    JSON.stringify({ width: 390, height: 844, orientation: "landscape_left" }),
  );
  const message = new Uint8Array(config.length + 1);
  message[0] = IOS_TAG_SCREEN_CONFIG;
  message.set(config, 1);
  socket.onmessage?.({ data: message.buffer });
  assert.ok(h.log.includes("screen:390x844:landscape_left"));

  h.client.sendTouch("move", 0.2, 0.3);
  const touch = decodePacket(socket.sent[socket.sent.length - 1]!);
  assert.deepEqual(touch.body.type, "move");
  assert.ok(Math.abs(touch.body.x - 0.3) < 1e-9);
  assert.ok(Math.abs(touch.body.y - 0.8) < 1e-9);

  h.client.rotate();
  assert.deepEqual(decodePacket(socket.sent[socket.sent.length - 1]!).body, {
    orientation: "portrait_upside_down",
  });
  h.client.stop();
});

test("a closed input socket retries after the delay, and late closes from discarded sockets are ignored", async () => {
  const h = harness();
  h.client.start();
  await settle();
  const first = h.sockets[0]!;
  first.open();
  first.drop(1001, "going away");
  assert.ok(h.log.includes("input:false"));
  h.clock.advance(DEVICE_STREAM_RETRY_DELAY_MS);
  await settle();
  assert.equal(h.sockets.length, 2);
  const inputEvents = h.log.filter((entry) => entry.startsWith("input:")).length;
  first.drop(1001);
  assert.equal(h.log.filter((entry) => entry.startsWith("input:")).length, inputEvents);
  h.client.stop();
});

test("a stopped client never reconnects", async () => {
  const h = harness();
  h.client.start();
  await settle();
  const socket = h.sockets[0]!;
  socket.open();
  h.client.stop();
  assert.equal(socket.closed, true);
  socket.drop(1006);
  h.clock.advance(DEVICE_STREAM_RETRY_DELAY_MS * 5);
  await settle();
  assert.equal(h.sockets.length, 1);
  assert.ok(!h.log.includes("unauthorized"));
});

test("a policy close reports unauthorized once and stops", async () => {
  const h = harness();
  h.client.start();
  await settle();
  h.sockets[0]!.drop(4401, "grant expired");
  assert.equal(h.log.filter((entry) => entry === "unauthorized").length, 1);
  h.clock.advance(DEVICE_STREAM_RETRY_DELAY_MS * 3);
  await settle();
  assert.equal(h.sockets.length, 1);
});

test("a hung prime request is aborted after its timeout and the socket still connects", async () => {
  const h = harness();
  let aborted = false;
  h.handlers.mjpeg = (_url, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    });
  h.client.start();
  await settle();
  assert.equal(h.sockets.length, 0);
  h.clock.advance(DEVICE_STREAM_PRIME_TIMEOUT_MS);
  await settle();
  assert.equal(aborted, true);
  assert.equal(h.sockets.length, 1);
  h.client.stop();
});

// ---- MJPEG -----------------------------------------------------------------

test("without WebCodecs the client falls back to MJPEG and waits for image dimensions", async () => {
  const h = harness();
  h.client.start();
  const fallback = h.log.find((entry) => entry.startsWith("mjpeg:"));
  assert.equal(
    fallback,
    "mjpeg:http://127.0.0.1:4100/vendor/serve-sim/helper/ABCD-1234/stream.mjpeg?t=tok&host=local",
  );
  const image = new FakeImage();
  h.client.setMjpegImage(image as unknown as HTMLImageElement);
  assert.match(image.src, /stream\.mjpeg\?t=tok&host=local$/);
  assert.ok(!h.log.includes("status:streaming"));
  h.clock.advance(DEVICE_STREAM_MJPEG_CHECK_MS);
  assert.ok(!h.log.includes("status:streaming"));
  image.naturalWidth = 390;
  image.naturalHeight = 844;
  h.clock.advance(DEVICE_STREAM_MJPEG_CHECK_MS);
  assert.ok(h.log.includes("status:streaming"));
  h.client.stop();
  assert.equal(image.src, "");
});

test("an MJPEG image error fails the stream", () => {
  const h = harness();
  h.client.start();
  const image = new FakeImage();
  h.client.setMjpegImage(image as unknown as HTMLImageElement);
  image.emit("error");
  assert.ok(
    h.log.includes(
      "status:error:Could not receive the simulator stream. Reconnect to try again.",
    ),
  );
  assert.equal(image.src, "");
});

test("no frame within the first-frame timeout fails the stream", () => {
  const h = harness({ preferMjpeg: true });
  h.client.start();
  h.clock.advance(DEVICE_STREAM_FIRST_FRAME_TIMEOUT_MS);
  assert.ok(
    h.log.includes("status:error:No video received from the simulator. Reconnect to try again."),
  );
});

// ---- AVCC / WebCodecs ------------------------------------------------------

test("an unsupported H.264 profile falls back to MJPEG", async () => {
  const h = harness({ webCodecs: true });
  h.setSupported(false);
  const body = streamBody();
  h.handlers.avcc = async () => body.response;
  h.client.start();
  await settle();
  body.push(envelope(1, [1, 0x64, 0x00, 0x33]));
  await settle();
  assert.ok(h.log.some((entry) => entry.startsWith("mjpeg:")));
  h.client.stop();
});

test("keyframes gate decoding and decoded frames are painted and released", async () => {
  const h = harness({ webCodecs: true });
  const body = streamBody();
  h.handlers.avcc = async () => body.response;
  h.client.start();
  await settle();
  body.push(envelope(3, [9]));
  body.push(envelope(1, [1, 0x42, 0xe0, 0x1e]));
  await settle();
  body.push(envelope(3, [9]));
  body.push(envelope(2, [8]));
  body.push(envelope(3, [7]));
  await settle();
  const decoder = h.decoders[0]!;
  assert.deepEqual(
    decoder.decoded.map((chunk) => chunk.type),
    ["key", "delta"],
  );

  let closed = 0;
  const frame = { displayWidth: 390, displayHeight: 844, close: () => closed++ };
  decoder.init.output(frame as unknown as VideoFrame);
  assert.deepEqual(h.presented, [{ width: 390, height: 844 }]);
  assert.equal(closed, 1);
  assert.ok(h.log.includes("status:streaming"));
  h.client.stop();
});

test("a sink that cannot present fails the stream and still releases the frame", async () => {
  const h = harness({ webCodecs: true });
  h.failPresent();
  const body = streamBody();
  h.handlers.avcc = async () => body.response;
  h.client.start();
  await settle();
  body.push(envelope(1, [1, 0x42, 0xe0, 0x1e]));
  await settle();
  let closed = 0;
  h.decoders[0]!.init.output({
    displayWidth: 10,
    displayHeight: 10,
    close: () => closed++,
  } as unknown as VideoFrame);
  assert.equal(closed, 1);
  assert.ok(
    h.log.includes("status:error:Could not display the simulator stream. Reconnect to try again."),
  );
});

test("a 401 from the video stream reports unauthorized, but a stale one after stop does not", async () => {
  const h = harness({ webCodecs: true });
  h.handlers.avcc = async () => new Response(null, { status: 401 });
  h.client.start();
  await settle();
  assert.equal(h.log.filter((entry) => entry === "unauthorized").length, 1);

  const stale = harness({ webCodecs: true });
  let resolve!: (response: Response) => void;
  stale.handlers.avcc = () => new Promise((r) => (resolve = r));
  stale.client.start();
  await settle();
  stale.client.stop();
  resolve(new Response(null, { status: 401 }));
  await settle();
  assert.ok(!stale.log.includes("unauthorized"));
});

test("a JPEG seed that resolves after stop is released without painting", async () => {
  let resolveBitmap!: (bitmap: ImageBitmap) => void;
  let bitmapClosed = false;
  const body = streamBody();
  const clientRuntimeBitmap = () =>
    new Promise<ImageBitmap>((resolve) => {
      resolveBitmap = resolve;
    });
  const log: string[] = [];
  const presented: number[] = [];
  const clock = fakeClock();
  const client = createDeviceStreamClient(
    target,
    { present: () => (presented.push(1), true) },
    {
      onStatus: (status) => log.push(status),
      onScreen: () => undefined,
      onUnauthorized: () => undefined,
      onMjpegFallback: () => undefined,
      onInputConnected: () => undefined,
    },
    {
      fetch: async (url) =>
        url.includes("stream.avcc") ? body.response : new Response(new Uint8Array([1])),
      createSocket: (url) => new FakeSocket(url),
      VideoDecoder: class {
        static isConfigSupported = async () => ({ supported: true });
      } as unknown as NonNullable<DeviceStreamRuntime["VideoDecoder"]>,
      EncodedVideoChunk: class {} as unknown as NonNullable<DeviceStreamRuntime["EncodedVideoChunk"]>,
      createImageBitmap: clientRuntimeBitmap,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  );
  client.start();
  await settle();
  body.push(envelope(4, [0xff, 0xd8]));
  await settle();
  client.stop();
  resolveBitmap({ width: 1, height: 1, close: () => (bitmapClosed = true) } as ImageBitmap);
  await settle();
  assert.equal(bitmapClosed, true);
  assert.deepEqual(presented, []);
});

test("a stalled AVCC body fails after the read timeout", async () => {
  const h = harness({ webCodecs: true });
  const body = streamBody();
  h.handlers.avcc = async () => body.response;
  h.client.start();
  await settle();
  body.push(envelope(1, [1, 0x42, 0xe0, 0x1e]));
  await settle();
  let closed = 0;
  h.decoders[0]!.init.output({
    displayWidth: 10,
    displayHeight: 10,
    close: () => closed++,
  } as unknown as VideoFrame);
  assert.ok(h.log.includes("status:streaming"));
  h.clock.advance(DEVICE_STREAM_FIRST_FRAME_TIMEOUT_MS);
  assert.ok(
    h.log.includes(
      "status:error:The simulator stream stopped receiving video. Reconnect to try again.",
    ),
  );
});

test("an ended AVCC body retries after the delay", async () => {
  const h = harness({ webCodecs: true });
  const bodies = [streamBody(), streamBody()];
  let calls = 0;
  h.handlers.avcc = async () => bodies[calls++]!.response;
  h.client.start();
  await settle();
  bodies[0]!.end();
  await settle();
  assert.equal(calls, 1);
  h.clock.advance(DEVICE_STREAM_RETRY_DELAY_MS);
  await settle();
  assert.equal(calls, 2);
  h.client.stop();
});

function tagged(tag: number, body: unknown): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(body));
  const message = new Uint8Array(json.length + 1);
  message[0] = tag;
  message.set(json, 1);
  return message.buffer;
}

test("an iPhone Duo queues hinge commands and rotation, acknowledged by reply and by screen config", async () => {
  const h = harness();
  h.client.start();
  await settle();
  const socket = h.sockets[0]!;
  socket.open();
  const sentAfter = (index: number) => socket.sent.slice(index).map(decodePacket);

  // Before the helper reports a hinge, Duo commands are ignored.
  h.client.controlDuo({ control: "pose", value: "book" });
  assert.equal(socket.sent.length, 1);

  const duo = { width: 460, height: 1000, orientation: "portrait", supportsHingeAngle: true };
  socket.onmessage?.({ data: tagged(IOS_TAG_SCREEN_CONFIG, { ...duo, hingeAngle: 180, hingePose: "open", screenId: 1 }) });
  socket.onmessage?.({ data: tagged(IOS_TAG_SCREEN_CONFIG, { ...duo, hingeAngle: 999, hingePose: "wobbly" }) });

  h.client.controlDuo({ control: "pose", value: "book" });
  h.client.controlDuo({ control: "angle", value: 120 });
  assert.deepEqual(sentAfter(1), [
    { tag: IOS_MSG_DUO_CONTROL, body: { requestId: 1, command: { control: "pose", value: "book" } } },
  ]);
  socket.onmessage?.({ data: tagged(IOS_TAG_CONTROL_REPLY, { requestId: 1, ok: true }) });
  assert.deepEqual(sentAfter(2), [
    { tag: IOS_MSG_DUO_CONTROL, body: { requestId: 2, command: { control: "angle", value: 120 } } },
  ]);
  socket.onmessage?.({ data: tagged(IOS_TAG_CONTROL_REPLY, { requestId: 2, ok: false, error: "native refused" }) });
  assert.equal(h.log[h.log.length - 1], "duo:false:native refused");

  // Rotation goes through the queue, twice in a row, without waiting for the device to catch up.
  h.client.rotate();
  h.client.rotate();
  assert.deepEqual(sentAfter(3), [{ tag: IOS_MSG_ORIENTATION, body: { orientation: "landscape_left" } }]);
  socket.onmessage?.({ data: tagged(IOS_TAG_SCREEN_CONFIG, { ...duo, orientation: "landscape_left" }) });
  assert.deepEqual(sentAfter(4), [{ tag: IOS_MSG_ORIENTATION, body: { orientation: "portrait_upside_down" } }]);

  // A dropped socket abandons the in-flight command.
  socket.drop(1011, "helper restarted");
  assert.deepEqual(h.log.slice(-2), ["duo:false:", "input:false"]);
  h.client.stop();
});

test("an unanswered Duo command times out and reports that its position is unknown", async () => {
  const h = harness();
  h.client.start();
  await settle();
  const socket = h.sockets[0]!;
  socket.open();
  socket.onmessage?.({
    data: tagged(IOS_TAG_SCREEN_CONFIG, { width: 460, height: 1000, orientation: "portrait", supportsHingeAngle: true }),
  });
  h.client.controlDuo({ control: "pose", value: "tent" });
  assert.equal(h.log[h.log.length - 1], "duo:true:");
  h.clock.advance(5_000);
  assert.match(h.log[h.log.length - 1]!, /^duo:false:Device control timed out/u);
  h.client.stop();
});
