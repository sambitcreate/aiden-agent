import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventLogBuffer,
  eventLogTime,
  filterEventLog,
  formatEventLog,
  parseEventLogPayload,
  subscribeDeviceEventLog,
  type DeviceEventLogEntry,
} from "./device-event-log.js";

const GRANT = { origin: "http://127.0.0.1:4100", token: "tok", expiresAt: Date.now() + 60_000 };
const entry = (id: number, summary = `Touch ${id}`, kind = "touch"): DeviceEventLogEntry => ({
  id,
  timestamp: `2026-10-08T12:00:${String(id % 60).padStart(2, "0")}.000Z`,
  kind,
  summary,
});

test("payloads seed or append, and malformed entries are dropped", () => {
  assert.deepEqual(parseEventLogPayload({ events: [entry(1), { id: "x" }, { ...entry(2), summary: undefined, msg: "Home" }] }), {
    entries: [entry(1), { ...entry(2), summary: "Home" }],
    reset: true,
  });
  assert.deepEqual(parseEventLogPayload({ event: entry(3) }), { entries: [entry(3)], reset: false });
  assert.equal(parseEventLogPayload({ event: { summary: "no id" } }), null);
  assert.equal(parseEventLogPayload("ping"), null);
});

test("the buffer keeps only the newest entries, in id order, replacing updated ones", () => {
  const buffer = createEventLogBuffer(3);
  buffer.apply([entry(1), entry(2)], true);
  buffer.apply([entry(4), entry(3)], false);
  assert.deepEqual(
    buffer.entries().map((item) => item.id),
    [2, 3, 4],
  );
  buffer.apply([{ ...entry(3), summary: "Launch done" }], false);
  assert.equal(buffer.entries().find((item) => item.id === 3)?.summary, "Launch done");
  assert.equal(buffer.entries().length, 3);

  const big = createEventLogBuffer(500);
  for (let id = 1; id <= 2_000; id++) big.apply([entry(id)], false);
  assert.equal(big.entries().length, 500);
  assert.equal(big.entries()[0]!.id, 1_501);
});

test("clearing hides entries already seen, even if the hub re-sends them", () => {
  const buffer = createEventLogBuffer();
  buffer.apply([entry(1), entry(2)], true);
  buffer.clear();
  assert.deepEqual(buffer.entries(), []);
  buffer.apply([entry(2), entry(3)], false);
  assert.deepEqual(
    buffer.entries().map((item) => item.id),
    [3],
  );
});

test("filtering matches summary or kind, and copying formats one line per entry", () => {
  const entries = [entry(1, "Touch begin 10,20"), entry(2, "Button home", "button"), entry(3, "Key down A", "key")];
  assert.deepEqual(
    filterEventLog(entries, "BUTTON").map((item) => item.id),
    [2],
  );
  assert.deepEqual(
    filterEventLog(entries, "  ").map((item) => item.id),
    [1, 2, 3],
  );
  assert.equal(eventLogTime("2026-10-08T09:41:07.123Z"), "09:41:07");
  assert.equal(eventLogTime(""), "");
  assert.equal(formatEventLog(entries.slice(1, 2)), "12:00:02  button  Button home");
});

test("the feed reads SSE through the proxy until it is unsubscribed", async () => {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const urls: string[] = [];
  const received: Array<{ ids: number[]; reset: boolean }> = [];
  const ended: Array<string | null> = [];
  const unsubscribe = subscribeDeviceEventLog(
    { hostId: "local", deviceId: "ABCD-1234", grant: GRANT },
    (entries, reset) => received.push({ ids: entries.map((item) => item.id), reset }),
    (error) => ended.push(error),
    {
      fetch: async (url) => {
        urls.push(url);
        return new Response(body, { status: 200 });
      },
    },
  );
  controller.enqueue(encoder.encode(`: hello\n\ndata: ${JSON.stringify({ events: [entry(1), entry(2)] })}\n\n`));
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: entry(3) })}\n`));
  controller.enqueue(encoder.encode("\n"));
  for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    urls[0],
    "http://127.0.0.1:4100/vendor/serve-sim/api/event-log/events?device=ABCD-1234&limit=100&t=tok&host=local",
  );
  assert.deepEqual(received, [
    { ids: [1, 2], reset: true },
    { ids: [3], reset: false },
  ]);
  unsubscribe();
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: entry(4) })}\n\n`));
  for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.length, 2, "nothing arrives after unsubscribing");
  assert.deepEqual(ended, []);
});

test("an unavailable feed reports once", async () => {
  const ended: Array<string | null> = [];
  subscribeDeviceEventLog(
    { hostId: "local", deviceId: "ABCD-1234", grant: GRANT },
    () => undefined,
    (error) => ended.push(error),
    { fetch: async () => new Response("nope", { status: 404 }) },
  );
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ended, ["The event log is unavailable for this simulator."]);
});
