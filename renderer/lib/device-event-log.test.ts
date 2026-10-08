import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventLogBuffer,
  eventLogTime,
  filterEventLog,
  formatEventLog,
  parseEventLogPayload,
  parseLogcatLine,
  parseLogcatPayload,
  subscribeAndroidLogcat,
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

test("threadtime logcat lines parse into pid, tid, level, tag, and message", () => {
  assert.deepEqual(parseLogcatLine("10-08 09:41:02.123  1234  1290 E AndroidRuntime: FATAL EXCEPTION: main"), {
    pid: 1234,
    tid: 1290,
    level: "E",
    tag: "AndroidRuntime",
    message: "FATAL EXCEPTION: main",
  });
  // Short tags are padded before the colon; the message may itself contain colons, or be empty.
  assert.deepEqual(parseLogcatLine("10-08 09:41:02.124   601   601 I ActivityTaskManager: START u0 {cmp=a/b}")?.tag, "ActivityTaskManager");
  assert.deepEqual(parseLogcatLine("10-08 09:41:02.125  2000  2001 D Tag     : key: value")?.message, "key: value");
  assert.deepEqual(parseLogcatLine("10-08 09:41:02.126  2000  2001 W Tag     :")?.message, "");
  assert.equal(parseLogcatLine("--------- beginning of main"), null);
  assert.equal(parseLogcatLine("[logcat stderr] adb: device offline"), null);
});

test("logcat batches become log entries with rising ids, a note for dropped lines, and an end on close", () => {
  const batch = parseLogcatPayload({
    lines: [
      { line: "10-08 09:41:02.123  1234  1290 E AndroidRuntime: FATAL EXCEPTION: main", at: "2026-10-08T09:41:02.200Z" },
      { line: "--------- beginning of crash", at: "2026-10-08T09:41:02.201Z" },
      { nope: true },
    ],
    dropped: 3,
  });
  assert.ok(batch && "entries" in batch);
  const entries = (batch as { entries: DeviceEventLogEntry[] }).entries;
  assert.deepEqual(
    entries.map(({ kind, summary }) => [kind, summary]),
    [
      ["error", "E AndroidRuntime: FATAL EXCEPTION: main"],
      ["logcat", "--------- beginning of crash"],
      ["logcat", "3 lines were skipped to keep up."],
    ],
  );
  assert.equal(eventLogTime(entries[0]!.timestamp), "09:41:02");
  assert.ok(entries[0]!.id < entries[1]!.id && entries[1]!.id < entries[2]!.id);
  // A later batch keeps counting up, so a cleared log stays cleared.
  const later = parseLogcatPayload({ lines: [{ line: "x", at: "" }] }) as { entries: DeviceEventLogEntry[] };
  assert.ok(later.entries[0]!.id > entries[2]!.id);
  assert.deepEqual(parseLogcatPayload({ error: "adb died", at: "now" }), { error: "adb died" });
  assert.deepEqual(parseLogcatPayload({ code: 0, signal: null }), { closed: true });
  assert.equal(parseLogcatPayload({ serial: "emulator-5554", package: null }), null, "the ready event adds nothing");
});

test("an emulator's logcat streams from serve-emu for that serial, optionally one app, until unsubscribed", async () => {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const urls: string[] = [];
  const signals: AbortSignal[] = [];
  const received: string[] = [];
  const ended: Array<string | null> = [];
  const unsubscribe = subscribeAndroidLogcat(
    { hostId: "local", deviceId: "emulator-5554", grant: GRANT, packageName: "com.example.shop" },
    (entries) => received.push(...entries.map((item) => item.summary)),
    (error) => ended.push(error),
    {
      fetch: async (url, init) => {
        urls.push(url);
        signals.push(init.signal);
        return new Response(body, { status: 200 });
      },
    },
  );
  const line = "10-08 09:41:02.123  4321  4321 I Shop: opened cart";
  controller.enqueue(encoder.encode(`event: ready\ndata: ${JSON.stringify({ serial: "emulator-5554" })}\n\n`));
  controller.enqueue(encoder.encode(`event: logs\ndata: ${JSON.stringify({ lines: [{ line, at: "2026-10-08T09:41:02Z" }], dropped: 0 })}\n\n`));
  for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    urls[0],
    "http://127.0.0.1:4100/vendor/serve-emu/api/logcat?device=emulator-5554&package=com.example.shop&t=tok&host=local",
  );
  assert.deepEqual(received, ["I Shop: opened cart"]);
  unsubscribe();
  // Aborting the request is what tells serve-emu to stop its logcat child.
  assert.equal(signals[0]!.aborted, true);
  assert.deepEqual(ended, []);

  // A package that is not an Android package name is never sent as a filter.
  const odd: string[] = [];
  subscribeAndroidLogcat(
    { hostId: "local", deviceId: "emulator-5554", grant: GRANT, packageName: "x&device=emulator-5556" },
    () => undefined,
    () => undefined,
    { fetch: async (url) => (odd.push(url), new Response("", { status: 429 })) },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(new URL(odd[0]!).searchParams.getAll("device").join(","), "emulator-5554");
  assert.equal(new URL(odd[0]!).searchParams.has("package"), false);
});

test("an emulator logcat that serve-emu refuses or ends with an error reports why, once", async () => {
  const busy: Array<string | null> = [];
  subscribeAndroidLogcat({ hostId: "local", deviceId: "emulator-5554", grant: GRANT }, () => undefined, (error) => busy.push(error), {
    fetch: async () => new Response("{}", { status: 429 }),
  });
  const failing: Array<string | null> = [];
  const payload = [
    `event: error\ndata: ${JSON.stringify({ error: "adb: device offline", at: "now" })}\n\n`,
    `event: close\ndata: ${JSON.stringify({ code: 1, signal: null })}\n\n`,
  ].join("");
  subscribeAndroidLogcat({ hostId: "local", deviceId: "emulator-5554", grant: GRANT }, () => undefined, (error) => failing.push(error), {
    fetch: async () => new Response(payload, { status: 200 }),
  });
  for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(busy, ["Too many logcat readers are open for this emulator."]);
  assert.deepEqual(failing, ["Logcat stopped: adb: device offline"]);
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
