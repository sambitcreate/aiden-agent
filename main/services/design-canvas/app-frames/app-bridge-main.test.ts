// Injecting the live app bridge into admitted app frames (design mode v2
// Phase 3a, D12, S11): which frames get it, with which nonce, and that the
// page can never hand main a value to wait on.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { installAppBridge } from "./app-bridge-main.ts";

const ORIGIN = "http://127.0.0.1:5173";

class FakeFrame extends EventEmitter {
  readonly calls: Array<{ code: string; userGesture: boolean | undefined }> = [];
  result: unknown = Promise.resolve(undefined);
  constructor(readonly frameTreeNodeId: number, public origin: string, readonly processId = 1, readonly routingId = frameTreeNodeId) {
    super();
  }
  executeJavaScript(code: string, userGesture?: boolean): unknown {
    this.calls.push({ code, userGesture });
    return this.result;
  }
  nonces(): string[] {
    return this.calls.map((call) => /\)\("([^"]+)",/u.exec(call.code)?.[1] ?? "?");
  }
}

function setup(options: { enabled?: boolean; members?: number[]; appOrigins?: string[] } = {}) {
  const contents = new EventEmitter();
  const frames = new Map<string, FakeFrame>();
  const members = new Set(options.members ?? [7]);
  const appOrigins = new Set(options.appOrigins ?? [ORIGIN]);
  let counter = 0;
  const remove = installAppBridge(contents, {
    enabled: options.enabled ?? true,
    registry: () => ({ isAppFrame: (id: number) => members.has(id) }),
    isAppOrigin: (origin) => appOrigins.has(origin),
    fromId: (processId, routingId) => frames.get(`${processId}:${routingId}`) ?? null,
    nonce: () => `nonce-${++counter}`,
  });
  const add = (frame: FakeFrame) => {
    frames.set(`${frame.processId}:${frame.routingId}`, frame);
    return frame;
  };
  const created = (frame: FakeFrame) => contents.emit("frame-created", {}, { frame });
  const finished = (frame: FakeFrame, isMainFrame = false) => contents.emit("did-frame-finish-load", {}, isMainFrame, frame.processId, frame.routingId);
  const navigated = (frame: FakeFrame, isMainFrame = false) =>
    contents.emit("did-frame-navigate", {}, `${frame.origin}/`, 200, "OK", isMainFrame, frame.processId, frame.routingId);
  return { contents, add, created, finished, navigated, remove, members, appOrigins };
}

test("a registered app frame gets the bridge on dom-ready, with a nonce and userGesture false", () => {
  const s = setup();
  const frame = s.add(new FakeFrame(7, ORIGIN));
  s.created(frame);
  assert.equal(frame.calls.length, 0, "nothing before dom-ready");
  frame.emit("dom-ready");
  assert.equal(frame.calls.length, 1);
  assert.equal(frame.calls[0]!.userGesture, false);
  assert.match(frame.calls[0]!.code, /^void \(/u, "the expression's value is undefined");
  assert.deepEqual(frame.nonces(), ["nonce-1"]);
});

test("did-frame-finish-load in the same document reuses the nonce; after did-frame-navigate it is new", () => {
  const s = setup();
  const frame = s.add(new FakeFrame(7, ORIGIN));
  s.created(frame);
  frame.emit("dom-ready");
  s.finished(frame);
  s.navigated(frame);
  s.finished(frame);
  assert.deepEqual(frame.nonces(), ["nonce-1", "nonce-1", "nonce-2"]);
});

test("after a full navigation, the next dom-ready injects again with the new document's nonce, until the bridge is removed", () => {
  const s = setup();
  const frame = s.add(new FakeFrame(7, ORIGIN));
  s.created(frame);
  frame.emit("dom-ready");
  s.navigated(frame);
  frame.emit("dom-ready");
  assert.deepEqual(frame.nonces(), ["nonce-1", "nonce-2"], "a reload is bridged before its load event");
  s.remove();
  s.navigated(frame);
  frame.emit("dom-ready");
  assert.deepEqual(frame.nonces(), ["nonce-1", "nonce-2"], "nothing once removed");
});

test("a nested frame, a frame on another origin, and file, genui, backstop or main frames get nothing", () => {
  const s = setup({ members: [7, 8] });
  const nested = s.add(new FakeFrame(9, ORIGIN));
  const moved = s.add(new FakeFrame(8, "http://127.0.0.1:6006"));
  const design = s.add(new FakeFrame(10, "null"));
  const genui = s.add(new FakeFrame(11, "null"));
  const backstop = s.add(new FakeFrame(12, "http://127.0.0.1:9999"));
  const main = s.add(new FakeFrame(1, "file://"));
  for (const frame of [nested, moved, design, genui, backstop]) {
    s.created(frame);
    frame.emit("dom-ready");
    s.finished(frame);
  }
  s.created(main);
  main.emit("dom-ready");
  s.finished(main, true);
  for (const frame of [nested, moved, design, genui, backstop, main]) assert.equal(frame.calls.length, 0, String(frame.frameTreeNodeId));
});

test("a rejected executeJavaScript is swallowed, and a thenable result is never awaited", async () => {
  const s = setup();
  const rejected = s.add(new FakeFrame(7, ORIGIN));
  rejected.result = Promise.reject(new Error("frame navigated away"));
  s.finished(rejected);
  const thenable = s.add(new FakeFrame(7, ORIGIN, 2, 70));
  let adopted = 0;
  thenable.result = { then: () => (adopted += 1) };
  s.finished(thenable);
  const thrower = s.add(new FakeFrame(7, ORIGIN, 3, 71));
  thrower.executeJavaScript = () => {
    throw new Error("Render frame was disposed");
  };
  s.finished(thrower);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(rejected.calls.length, 1);
  assert.equal(adopted, 0);
});

test("each window gets its own injection, and with live apps off nothing is listened to", () => {
  const first = setup();
  const second = setup();
  for (const s of [first, second]) {
    const frame = s.add(new FakeFrame(7, ORIGIN));
    s.finished(frame);
    assert.equal(frame.calls.length, 1);
  }
  first.remove();
  const after = first.add(new FakeFrame(7, ORIGIN, 4, 72));
  first.finished(after);
  assert.equal(after.calls.length, 0, "removed");

  const off = setup({ enabled: false });
  for (const event of ["frame-created", "did-frame-finish-load", "did-frame-navigate"]) assert.equal(off.contents.listenerCount(event), 0, event);
});
