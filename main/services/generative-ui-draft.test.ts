import assert from "node:assert/strict";
import test from "node:test";
import {
  createGenerativeUiDraftSession,
  createGenerativeUiDraftTracker,
  isDraftHtmlAcceptable,
} from "./generative-ui-draft.js";

test("tracker opens once, appends only new suffixes, and restarts on non-prefix edits", () => {
  const t = createGenerativeUiDraftTracker();
  assert.equal(t.update("c1", { title: "T" }), undefined);
  assert.deepEqual(t.update("c1", { title: "T", html: "<div>" }), { kind: "open", toolCallId: "c1", title: "T" });
  assert.deepEqual(t.update("c1", { title: "T", html: "<div>" }), { kind: "append", toolCallId: "c1", chunk: "<div>" });
  assert.equal(t.update("c1", { title: "T", html: "<div>" }), undefined);
  assert.deepEqual(t.update("c1", { title: "T", html: "<div><p>hi" }), { kind: "append", toolCallId: "c1", chunk: "<p>hi" });
  assert.deepEqual(t.update("c1", { title: "T", html: "<section>" }), { kind: "restart", toolCallId: "c1", title: "T" });
  assert.deepEqual(t.update("c1", { title: "T", html: "<section>" }), { kind: "append", toolCallId: "c1", chunk: "<section>" });
});

test("path-based, empty, and non-object args never open a draft", () => {
  const t = createGenerativeUiDraftTracker();
  assert.equal(t.update("c2", { title: "T", path: "a.html", html: "<p>" }), undefined);
  assert.equal(t.update("c3", "not json yet"), undefined);
  assert.equal(t.update("c4", { title: "T", html: "" }), undefined);
  assert.equal(t.update("c5", null), undefined);
});

test("ending a call forgets it so a later call id starts fresh", () => {
  const t = createGenerativeUiDraftTracker();
  t.update("c1", { html: "<p>" });
  t.update("c1", { html: "<p>" });
  t.end("c1");
  assert.equal(t.update("c1", { html: "<p>" })?.kind, "open");
});

function fakeSession(publicIds: Record<string, string> = { raw1: "call-1", raw2: "call-2" }) {
  const events: unknown[] = [];
  const streams: Array<{ title: string; chunks: string[]; closed: boolean; src: string }> = [];
  const timers: Array<() => void> = [];
  const session = createGenerativeUiDraftSession({
    publicToolCallId: (raw) => publicIds[raw],
    send: (event) => events.push(event),
    open: (title) => {
      const stream = { title, chunks: [] as string[], closed: false, src: `aiden-genui://preview/${String(streams.length).padStart(64, "0")}` };
      streams.push(stream);
      return { src: stream.src, append: (c) => stream.chunks.push(c), close: () => { stream.closed = true; } };
    },
    schedule: (run) => { timers.push(run); return timers.length; },
    cancelScheduled: () => undefined,
  });
  const flush = () => { while (timers.length) timers.shift()!(); };
  return { session, events, streams, flush };
}

test("a disabled draft session never opens streams or emits events", () => {
  const events: unknown[] = [];
  let opened = 0;
  const session = createGenerativeUiDraftSession({
    enabled: false,
    publicToolCallId: () => "call-1",
    send: (event) => events.push(event),
    open: () => {
      opened += 1;
      return { src: "x", append: () => undefined, close: () => undefined };
    },
    schedule: (run) => { run(); return 1; },
    cancelScheduled: () => undefined,
  });
  session.delta("raw1", "render_artifact", { title: "T", html: "<p>a" });
  session.end("raw1");
  session.cancel("raw1");
  session.dispose();
  assert.equal(opened, 0);
  assert.deepEqual(events, []);
});

test("a draft session throttles deltas, then opens one stream and appends suffixes", () => {
  const { session, events, streams, flush } = fakeSession();
  session.delta("raw1", "render_artifact", { title: "Revenue", html: "<div>" });
  session.delta("raw1", "render_artifact", { title: "Revenue", html: "<div><p>1" });
  assert.equal(streams.length, 0);
  flush();
  assert.equal(streams.length, 1);
  assert.deepEqual(streams[0]!.chunks, ["<div><p>1"]);
  assert.deepEqual(events, [
    { version: 1, operation: "draft", toolCallId: "call-1", title: "Revenue", src: streams[0]!.src },
  ]);
  session.delta("raw1", "render_artifact", { title: "Revenue", html: "<div><p>12" });
  flush();
  assert.deepEqual(streams[0]!.chunks, ["<div><p>1", "2"]);
  assert.equal(events.length, 1);
});

test("a draft follows the wide layout whenever the streamed arguments name it", () => {
  const { session, events, streams, flush } = fakeSession();
  session.delta("raw1", "render_artifact", { title: "Board", html: "<div>" });
  flush();
  session.delta("raw1", "render_artifact", { title: "Board", html: "<div><p>", layout: "wide" });
  flush();
  // The same stream is re-announced as wide; no second document is opened.
  assert.equal(streams.length, 1);
  assert.deepEqual(events, [
    { version: 1, operation: "draft", toolCallId: "call-1", title: "Board", src: streams[0]!.src },
    { version: 1, operation: "draft", toolCallId: "call-1", title: "Board", src: streams[0]!.src, layout: "wide" },
  ]);
  session.delta("raw1", "render_artifact", { title: "Board", html: "<div><p>1", layout: "wide" });
  flush();
  assert.equal(events.length, 2);
  // Layout named before any HTML is announced with the first draft.
  session.delta("raw2", "render_artifact", { layout: "wide", title: "Grid", html: "<p>" });
  flush();
  assert.deepEqual(events[2], {
    version: 1, operation: "draft", toolCallId: "call-2", title: "Grid", src: streams[1]!.src, layout: "wide",
  });
});

test("other tools, unknown calls, and bad titles never leak into draft events", () => {
  const { session, events, flush } = fakeSession();
  session.delta("raw1", "read_file", { html: "<p>" });
  session.delta("raw-unknown", "render_artifact", { html: "<p>" });
  session.delta("raw2", "render_artifact", { title: " padded ", html: "<p>" });
  flush();
  assert.deepEqual(events.map((e) => (e as { toolCallId?: string; title?: string })), [
    { version: 1, operation: "draft", toolCallId: "call-2", src: (events[0] as { src: string }).src },
  ]);
});

test("ending a call flushes and closes its stream but leaves the draft for present to replace", () => {
  const { session, events, streams } = fakeSession();
  session.delta("raw1", "render_artifact", { html: "<p>a" });
  session.end("raw1");
  assert.equal(streams[0]!.closed, true);
  assert.deepEqual(streams[0]!.chunks, ["<p>a"]);
  assert.equal(events.some((e) => (e as { operation: string }).operation === "draft_end"), false);
});

test("cancel and dispose close streams and retract drafts", () => {
  const { session, events, streams, flush } = fakeSession();
  session.delta("raw1", "render_artifact", { html: "<p>a" });
  session.delta("raw2", "render_artifact", { html: "<p>b" });
  flush();
  session.cancel("raw1");
  session.dispose();
  assert.ok(streams.every((s) => s.closed));
  assert.deepEqual(
    events.filter((e) => (e as { operation: string }).operation === "draft_end"),
    [
      { version: 1, operation: "draft_end", toolCallId: "call-1" },
      { version: 1, operation: "draft_end", toolCallId: "call-2" },
    ],
  );
});

test("an inadmissible prefix stops the draft without opening more streams", () => {
  const { session, events, streams, flush } = fakeSession();
  session.delta("raw1", "render_artifact", { html: "<p>ok" });
  flush();
  session.delta("raw1", "render_artifact", { html: "<p>ok<iframe src=x>" });
  flush();
  session.delta("raw1", "render_artifact", { html: "<p>ok<iframe src=x><p>more" });
  flush();
  assert.equal(streams.length, 1);
  assert.equal(streams[0]!.closed, true);
  assert.deepEqual(streams[0]!.chunks, ["<p>ok"]);
  assert.equal(events.filter((e) => (e as { operation: string }).operation === "draft_end").length, 1);
});

test("draft admission stops at remote loads and forbidden elements but tolerates partial tags", () => {
  assert.equal(isDraftHtmlAcceptable("<div class=\"aiden-card\"><p>Revenue"), true);
  assert.equal(isDraftHtmlAcceptable("<div><scr"), true);
  assert.equal(isDraftHtmlAcceptable("<iframe src=x>"), false);
  assert.equal(isDraftHtmlAcceptable("<img src=\"https://tracker.example/x.png\">"), false);
  assert.equal(isDraftHtmlAcceptable("<a href=\"javascript:alert(1)\">"), false);
  assert.equal(isDraftHtmlAcceptable("x\u0000y"), false);
});
