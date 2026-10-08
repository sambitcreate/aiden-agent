// Adapted from t3code packages/client-runtime/src/device/duoStream.test.ts @ a6ec88f7 (MIT).
import assert from "node:assert/strict";
import test from "node:test";
import {
  IOS_MSG_TOUCH,
  IOS_TAG_SCREEN_CONFIG,
  createDeviceStreamClient,
  type DeviceScreenSize,
  type DeviceStreamRuntime,
} from "./device-stream";

/** The newest entry. Equivalent to `.at(-1)`, which the ES2021 lib lacks. */
const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

const settle = async (rounds = 10) => {
  for (let index = 0; index < rounds; index++) await new Promise((resolve) => setImmediate(resolve));
};

function envelope(tag: number, payload: number[]): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length + 1, false);
  out[4] = tag;
  out.set(payload, 5);
  return out;
}

const description = envelope(1, [1, 0x64, 0, 0x1f]);

class FakeSocket {
  readyState = 1;
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
  }
}

function harness() {
  const feeds: Array<{ url: string; signal: AbortSignal; push(bytes: Uint8Array): void }> = [];
  const sockets: FakeSocket[] = [];
  const decoders: Array<{ output: (frame: VideoFrame) => void }> = [];
  let supported = true;
  let panelStatus = 200;
  const runtime: DeviceStreamRuntime = {
    fetch: async (url, init) => {
      if (!url.includes("stream.avcc")) return new Response(new Uint8Array([1]), { status: 200 });
      if (url.includes("/panel/") && panelStatus !== 200) return new Response("unsupported", { status: panelStatus });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      });
      init.signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
      feeds.push({ url, signal: init.signal, push: (bytes) => controller.enqueue(bytes) });
      return new Response(body, { status: 200 });
    },
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    VideoDecoder: class {
      static isConfigSupported = async () => ({ supported });
      state = "unconfigured";
      decodeQueueSize = 0;
      constructor(init: { output: (frame: VideoFrame) => void }) {
        decoders.push({ output: init.output });
      }
      configure() {
        this.state = "configured";
      }
      decode() {}
      close() {
        this.state = "closed";
      }
    } as unknown as NonNullable<DeviceStreamRuntime["VideoDecoder"]>,
    EncodedVideoChunk: class {} as unknown as NonNullable<DeviceStreamRuntime["EncodedVideoChunk"]>,
    setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => undefined,
  };
  const presented: unknown[] = [];
  const covers: unknown[] = [];
  const inners: unknown[] = [];
  const unavailable: Array<string | undefined> = [];
  const statuses: string[] = [];
  const client = createDeviceStreamClient(
    { hostId: "peer-1", deviceId: "duo", grant: { origin: "http://127.0.0.1:4100", token: "tok", expiresAt: Date.now() + 60_000 } },
    { present: (source) => (presented.push(source), true) },
    {
      onStatus: (status) => statuses.push(status),
      onScreen: () => undefined,
      onUnauthorized: () => undefined,
      onMjpegFallback: () => undefined,
      onInputConnected: () => undefined,
      onDuoUnavailable: (detail) => unavailable.push(detail),
    },
    runtime,
  );
  const panels = {
    cover: { present: (source: CanvasImageSource) => (covers.push(source), true) },
    inner: { present: (source: CanvasImageSource) => (inners.push(source), true) },
  };
  const config = (screenId: 1 | 3, physical = false, orientation: DeviceScreenSize["orientation"] = "portrait") => {
    const json = new TextEncoder().encode(
      JSON.stringify({
        width: screenId === 1 ? 1398 : 2007,
        height: screenId === 1 ? 2034 : 2853,
        orientation,
        screenId,
        supportsHingeAngle: true,
        supportsPhysicalOrientation: physical,
        hingePose: "open",
      }),
    );
    const packet = new Uint8Array(json.length + 1);
    packet[0] = IOS_TAG_SCREEN_CONFIG;
    packet.set(json, 1);
    sockets[0]!.onmessage?.({ data: packet.buffer });
  };
  const frame = (label: string) => ({ label, displayWidth: 2007, displayHeight: 2853, close: () => undefined }) as unknown as VideoFrame;
  return {
    client,
    feeds,
    sockets,
    decoders,
    presented,
    covers,
    inners,
    unavailable,
    statuses,
    panels,
    config,
    frame,
    setSupported: (value: boolean) => (supported = value),
    setPanelStatus: (value: number) => (panelStatus = value),
  };
}

test("fixed display feeds replace the primary video, share one input socket, and route only the active display", async () => {
  const h = harness();
  h.client.start();
  await settle();
  h.config(3);
  h.feeds[0]!.push(description);
  await settle();
  assert.equal(h.decoders.length, 1);
  h.client.setDuoPanels(h.panels);
  assert.equal(h.feeds[0]!.signal.aborted, true, "the primary feed stops");
  await settle();
  assert.equal(h.sockets.length, 1, "HID is not replaced");
  for (const [index, id] of [
    [1, 1],
    [2, 3],
  ] as const) {
    const url = new URL(h.feeds[index]!.url);
    assert.ok(url.pathname.endsWith(`/helper/duo/panel/${id}/stream.avcc`), url.pathname);
    // Panel feeds go through the same proxy grant as the primary stream.
    assert.equal(url.searchParams.get("t"), "tok");
    assert.equal(url.searchParams.get("host"), "peer-1");
  }
  h.feeds[1]!.push(description);
  h.feeds[2]!.push(description);
  await settle();
  assert.equal(h.decoders.length, 3);
  const inner = h.frame("inner");
  // The superseded primary decoder can no longer paint.
  h.decoders[0]!.output(h.frame("stale"));
  assert.deepEqual(h.presented, []);
  // The inactive cover's shutdown frame is dropped.
  h.decoders[1]!.output(h.frame("cover-blank"));
  assert.deepEqual(h.covers, []);
  assert.deepEqual(h.presented, []);
  h.decoders[2]!.output(inner);
  assert.deepEqual(h.inners, [inner]);
  assert.deepEqual(h.presented, [inner], "the flat canvas keeps the active display");
  h.config(1);
  h.decoders[2]!.output(h.frame("inner-blank"));
  assert.equal(h.inners.length, 1);
  const cover = h.frame("cover");
  h.decoders[1]!.output(cover);
  assert.deepEqual(h.covers, [cover]);
  // Detaching closes the panels and resumes the primary video.
  h.client.setDuoPanels(null);
  assert.equal(h.feeds[1]!.signal.aborted, true);
  assert.equal(h.feeds[2]!.signal.aborted, true);
  await settle();
  assert.ok(!h.feeds[3]!.url.includes("/panel/"));
  h.decoders[1]!.output(h.frame("late"));
  assert.equal(h.covers.length, 1);
  h.client.stop();
  assert.equal(h.feeds[3]!.signal.aborted, true);
  assert.equal(h.sockets[0]!.closed, true);
});

test("with physical orientation one elected feed runs, and a display election reopens only video", async () => {
  const h = harness();
  h.client.start();
  await settle();
  h.config(1, true);
  h.client.setDuoPanels(h.panels);
  await settle();
  assert.equal(h.feeds.length, 2, "one active feed replaces the primary");
  assert.ok(!h.feeds[1]!.url.includes("/panel/"));
  h.feeds[1]!.push(description);
  await settle();
  const elected = h.frame("elected-cover");
  last(h.decoders)!.output(elected);
  assert.deepEqual(h.presented, [elected], "the main sink owns elected frames");
  assert.deepEqual(h.covers, []);
  h.config(3, true);
  assert.equal(h.feeds[1]!.signal.aborted, true);
  await settle();
  assert.equal(h.feeds.length, 3);
  h.feeds[2]!.push(description);
  await settle();
  const before = h.presented.length;
  h.decoders[h.decoders.length - 2]!.output(h.frame("old-election"));
  assert.equal(h.presented.length, before, "the former display cannot paint after handoff");
  // Duplicate native readback does not reconnect.
  h.config(3, true);
  await settle();
  assert.equal(h.feeds.length, 3);
  assert.equal(h.sockets.length, 1);
  h.client.stop();
});

test("a display feed that cannot be decoded or is not served hands the 3D view back without failing the stream", async () => {
  const h = harness();
  h.client.start();
  await settle();
  h.config(3);
  h.setSupported(false);
  h.client.setDuoPanels(h.panels);
  await settle();
  h.feeds[1]!.push(description);
  await settle();
  assert.match(last(h.unavailable) ?? "", /cannot decode/u);
  h.client.setDuoPanels(null);
  h.setPanelStatus(404);
  h.client.setDuoPanels(h.panels);
  await settle();
  assert.match(last(h.unavailable) ?? "", /does not provide fixed Duo/u);
  assert.equal(h.statuses.includes("error"), false, "the primary stream keeps running");
  assert.equal(h.sockets.length, 1);
  h.client.stop();
});

test("display feeds attached before the first primary frame bring the stream live", async () => {
  const h = harness();
  h.client.start();
  await settle();
  h.config(3);
  h.client.setDuoPanels(h.panels);
  await settle();
  h.feeds[2]!.push(description);
  await settle();
  assert.equal(h.statuses.includes("streaming"), false);
  last(h.decoders)!.output(h.frame("inner"));
  assert.equal(last(h.statuses), "streaming");
  h.client.stop();
});

test("panels attach only to a hinged simulator, and raw touches skip the rotation remap", async () => {
  const h = harness();
  h.client.start();
  await settle();
  h.client.setDuoPanels(h.panels);
  await settle();
  assert.equal(h.feeds.length, 1, "no hinge report yet: the primary feed stays");
  h.config(3, false, "landscape_left");
  h.client.sendRawTouch("begin", 0.2, 0.7);
  h.client.sendTouch("begin", 0.2, 0.7);
  const touches = h.sockets[0]!.sent.filter((packet) => packet[0] === IOS_MSG_TOUCH).map((packet) =>
    JSON.parse(new TextDecoder().decode(packet.subarray(1))),
  );
  assert.deepEqual(touches[0], { type: "begin", x: 0.2, y: 0.7 });
  // The flat path remaps a rotated portrait framebuffer; the Duo's 3D path already mapped it.
  assert.notDeepEqual(touches[1], touches[0]);
  h.client.stop();
});
