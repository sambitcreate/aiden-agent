import assert from "node:assert/strict";
import test from "node:test";

import {
  createSseParser,
  parseForegroundEvent,
  subscribeDeviceForeground,
  type DeviceForegroundApp,
} from "./device-foreground";

const grant = { origin: "http://127.0.0.1:4100", token: "tok", expiresAt: Date.now() + 60_000 };

test("parseForegroundEvent maps serve-sim's appstate payloads", () => {
  assert.deepEqual(parseForegroundEvent({ bundleId: "com.apple.Maps", pid: 42 }), {
    id: "com.apple.Maps",
    pid: 42,
  });
  assert.deepEqual(parseForegroundEvent({ bundleId: "com.example" }), { id: "com.example" });
  assert.equal(parseForegroundEvent({ bundleId: null }), null);
  assert.equal(parseForegroundEvent({ bundleId: "" }), null);
  assert.equal(parseForegroundEvent({ bundleId: 7 }), undefined);
  assert.equal(parseForegroundEvent("nope"), undefined);
});

test("createSseParser joins data lines, handles CRLF, and waits for complete events", () => {
  const seen: string[] = [];
  const parse = createSseParser((data) => seen.push(data));
  const encode = (text: string) => new TextEncoder().encode(text);
  parse(encode(": keep-alive\n\ndata: {\"a\":"));
  assert.deepEqual(seen, []);
  parse(encode("1}\r\n\r\ndata: one\ndata: two\n\n"));
  assert.deepEqual(seen, ['{"a":1}', "one\ntwo"]);
});

test("subscribeDeviceForeground reads the proxied feed and stops on unsubscribe", async () => {
  let pushChunk!: (text: string) => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      pushChunk = (text) => controller.enqueue(new TextEncoder().encode(text));
    },
  });
  const urls: string[] = [];
  const seen: Array<DeviceForegroundApp | null> = [];
  const stop = subscribeDeviceForeground(
    { hostId: "local", deviceId: "AB CD", grant },
    (app) => seen.push(app),
    {
      fetch: async (url, init) => {
        urls.push(url);
        assert.equal(init.credentials, "omit");
        return new Response(body, { status: 200 });
      },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(urls, [
    "http://127.0.0.1:4100/vendor/serve-sim/appstate?device=AB+CD&t=tok&host=local",
  ]);
  pushChunk('data: {"bundleId":"com.apple.Preferences","pid":9}\n\ndata: not json\n\n');
  await new Promise((resolve) => setImmediate(resolve));
  pushChunk('data: {"bundleId":null}\n\n');
  await new Promise((resolve) => setImmediate(resolve));
  stop();
  pushChunk('data: {"bundleId":"com.late"}\n\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [{ id: "com.apple.Preferences", pid: 9 }, null]);
});
