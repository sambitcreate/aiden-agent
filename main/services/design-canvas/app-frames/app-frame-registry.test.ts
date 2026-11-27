import assert from "node:assert/strict";
import test from "node:test";

import type { DesignAppFrameEvent } from "../../../../renderer/shared/design-canvas/app-frame-events.ts";
import { AppFrameRegistry, type AdmitNavigation } from "./app-frame-registry.ts";
import type { AppFrameRef } from "./app-network-policy.ts";

const ORIGIN = "http://127.0.0.1:5173";
const TOKEN = "abcdefghijklmnop";

function setup(options: { cap?: number } = {}) {
  let clock = 1_000;
  let live: Set<number> | null = new Set<number>();
  const timers: Array<() => void> = [];
  const registry = new AppFrameRegistry({
    mainContents: () => ({}),
    liveIds: () => live,
    rendererOrigin: "file://",
    cap: options.cap,
    now: () => clock,
    schedule: (callback) => {
      timers.push(callback);
    },
  });
  const events: DesignAppFrameEvent[] = [];
  registry.onEvent((event) => events.push(event));
  const navigation = (id: number, overrides: Partial<AdmitNavigation> = {}, name = `aiden-app:f${id}:${TOKEN}`): AdmitNavigation => ({
    frame: { frameTreeNodeId: id, name, url: "about:blank" },
    targetUrl: `${ORIGIN}/pricing`,
    isDirectChild: true,
    initiator: "main-frame",
    designFrame: false,
    ...overrides,
  });
  const place = (id: number) => registry.expectPlacement({ frameId: `f${id}`, mountToken: TOKEN, expectedOrigin: ORIGIN });
  const admitNew = (id: number) => {
    assert.equal(place(id), "ok");
    live?.add(id);
    return registry.admit(navigation(id));
  };
  return {
    registry,
    events,
    navigation,
    place,
    admitNew,
    tick: (ms: number) => {
      clock += ms;
    },
    setLive: (next: Set<number> | null) => {
      live = next;
    },
    live: () => live,
    flush: () => {
      for (const timer of timers.splice(0)) timer();
    },
  };
}

test("a placed frame is admitted once, on its expected origin, and the record is consumed", () => {
  const s = setup();
  s.place(5);
  assert.equal(s.registry.admit(s.navigation(5)), "app");
  assert.equal(s.registry.isAppFrame(5), true);
  assert.deepEqual(s.registry.frameInfo(5), { frameId: "f5", mountToken: TOKEN });
  // A second frame naming the same token finds no record.
  assert.equal(s.registry.admit(s.navigation(6, {}, `aiden-app:f5:${TOKEN}`)), "refused");
  assert.equal(s.registry.isAppFrame(6), false);
});

test("each failing admission condition refuses on its own", () => {
  const cases: Array<[string, Partial<AdmitNavigation>]> = [
    ["another origin", { targetUrl: "http://127.0.0.1:4321/" }],
    ["a nested frame", { isDirectChild: false }],
    ["another initiator", { initiator: "other" }],
    // Probe 5 recorded that Electron 43.8.4 reports the main frame for an
    // `src`-set navigation, so no initiator is refused too.
    ["no initiator", { initiator: "none" }],
    ["a frame on an aiden-design: page", { frame: { frameTreeNodeId: 5, name: `aiden-app:f5:${TOKEN}`, url: "aiden-design://grant/design/a.html" } }],
    ["a v1 design frame", { designFrame: true }],
  ];
  for (const [label, overrides] of cases) {
    const s = setup();
    s.place(5);
    assert.equal(s.registry.admit(s.navigation(5, overrides)), "refused", label);
    assert.equal(s.registry.isAppFrame(5), false, label);
    // Consumed whatever the outcome.
    assert.equal(s.registry.admit(s.navigation(5)), "refused", `${label}: record consumed`);
  }
  const expired = setup();
  expired.place(5);
  expired.tick(31_000);
  assert.equal(expired.registry.admit(expired.navigation(5)), "refused", "an expired record");
  const none = setup();
  assert.equal(none.registry.admit(none.navigation(5)), "refused", "no record");
  assert.equal(none.registry.admit(none.navigation(5, {}, "")), "not-candidate", "an unnamed frame");
  assert.equal(none.registry.admit(none.navigation(5, {}, "genui-preview")), "not-candidate", "another name");
});

test("membership is sticky: a later navigation elsewhere doesn't remove the frame", () => {
  const s = setup();
  s.admitNew(5);
  const moved: AppFrameRef = { frameTreeNodeId: 5, parent: null, url: "http://127.0.0.1:4321/", origin: "http://127.0.0.1:4321", isMainFrame: false };
  assert.equal(s.registry.appContext(moved, true), "registered");
  assert.equal("reset" in s.registry, false);
});

test("a live frame is never evicted, however many frames come and go (R6)", () => {
  const s = setup({ cap: 64 });
  assert.equal(s.admitNew(1), "app");
  for (let id = 100; id < 700; id++) {
    assert.equal(s.admitNew(id), "app", `admission ${id}`);
    s.live()!.delete(id); // removed from the frame tree right after
    assert.equal(s.registry.isAppFrame(1), true);
  }
  const child: AppFrameRef = {
    frameTreeNodeId: 900,
    parent: { frameTreeNodeId: 1, parent: null, url: `${ORIGIN}/`, origin: ORIGIN, isMainFrame: false },
    url: "about:srcdoc",
    origin: "null",
    isMainFrame: false,
  };
  assert.equal(s.registry.appContext(child, true), "registered");
});

test("a full registry of live frames refuses, and recovers when one leaves the tree", () => {
  const s = setup({ cap: 3 });
  for (const id of [1, 2, 3]) assert.equal(s.admitNew(id), "app");
  assert.equal(s.place(4), "too-many-frames");
  s.live()!.add(4);
  assert.equal(s.registry.admit(s.navigation(4)), "refused");
  s.live()!.delete(2);
  assert.equal(s.place(4), "ok");
  assert.equal(s.registry.admit(s.navigation(4)), "app");
  assert.equal(s.registry.isAppFrame(1), true);
  assert.equal(s.registry.isAppFrame(3), true);
  // With no window to read the tree from, nothing is pruned.
  s.setLive(null);
  assert.equal(s.place(9), "too-many-frames");
});

test("appContext walks to a registered ancestor and fails closed in the main window", () => {
  const s = setup();
  s.admitNew(10);
  const main: AppFrameRef = { frameTreeNodeId: 1, parent: null, url: "file:///main.html", origin: "file://", isMainFrame: true };
  const app: AppFrameRef = { frameTreeNodeId: 10, parent: main, url: `${ORIGIN}/`, origin: ORIGIN, isMainFrame: false };
  const l1: AppFrameRef = { frameTreeNodeId: 11, parent: app, url: "about:srcdoc", origin: ORIGIN, isMainFrame: false };
  const l2: AppFrameRef = { frameTreeNodeId: 12, parent: l1, url: "data:text/html,x", origin: "null", isMainFrame: false };
  const l3: AppFrameRef = { frameTreeNodeId: 13, parent: l2, url: "blob:x", origin: "null", isMainFrame: false };
  assert.equal(s.registry.appContext(l3, true), "registered");
  const loopback: AppFrameRef = { frameTreeNodeId: 20, parent: main, url: "http://127.0.0.1:4321/", origin: "http://127.0.0.1:4321", isMainFrame: false };
  assert.equal(s.registry.appContext(loopback, true), "backstop");
  const orphan: AppFrameRef = { frameTreeNodeId: 21, parent: null, url: "about:blank", origin: "null", isMainFrame: false };
  assert.equal(s.registry.appContext(orphan, true), "backstop");
  const throwing = {
    frameTreeNodeId: 22,
    get parent(): AppFrameRef | null {
      throw new Error("destroyed");
    },
    url: "",
    origin: "null",
    isMainFrame: false,
  } as AppFrameRef;
  assert.equal(s.registry.appContext(throwing, true), "backstop");
  const design: AppFrameRef = { frameTreeNodeId: 23, parent: main, url: "aiden-design://g/a.html", origin: "aiden-design://g", isMainFrame: false };
  assert.equal(s.registry.appContext(design, true), null);
  assert.equal(s.registry.appContext(main, true), null);
  assert.equal(s.registry.appContext(orphan, false), null, "other windows have no backstop");
});

test("blocked reports coalesce per frame with a running count and at most 20 hosts", () => {
  const s = setup();
  s.admitNew(10);
  const app: AppFrameRef = { frameTreeNodeId: 10, parent: null, url: `${ORIGIN}/`, origin: ORIGIN, isMainFrame: false };
  const nested: AppFrameRef = { frameTreeNodeId: 11, parent: app, url: "about:srcdoc", origin: ORIGIN, isMainFrame: false };
  for (let i = 0; i < 30; i++) s.registry.reportBlocked(i % 2 ? nested : app, `h${i}.example`);
  s.flush();
  assert.equal(s.events.length, 1);
  const first = s.events[0]!;
  assert.equal(first.kind, "blocked");
  if (first.kind !== "blocked") return;
  assert.equal(first.count, 30);
  assert.equal(first.hosts.length, 20);
  assert.equal(first.frameId, "f10");
  s.registry.reportBlocked(app, "again.example");
  s.flush();
  const second = s.events[1]!;
  assert.equal(second.kind === "blocked" && second.count, 31);
});

test("a backstop frame or an unregistered frame emits nothing", () => {
  const s = setup();
  const loopback: AppFrameRef = { frameTreeNodeId: 20, parent: null, url: "http://127.0.0.1:4321/", origin: "http://127.0.0.1:4321", isMainFrame: false };
  s.registry.reportBlocked(loopback, "example.com");
  s.registry.emitFor(20, { kind: "navigation-refused", url: "https://example.com/" });
  s.flush();
  assert.deepEqual(s.events, []);
});

test("export contents are registered for their lifetime", () => {
  const s = setup();
  const remove = s.registry.addExportContents(77);
  assert.equal(s.registry.isExportContents(77), true);
  remove();
  assert.equal(s.registry.isExportContents(77), false);
});

test("an export window's request starts are stamped for its settle, and only while it is registered", () => {
  const s = setup();
  s.registry.noteExportRequest(77);
  assert.equal(s.registry.lastExportRequest(77), undefined, "not an export window yet");
  const remove = s.registry.addExportContents(77);
  assert.equal(s.registry.lastExportRequest(77), undefined, "no request yet");
  s.registry.noteExportRequest(77);
  assert.equal(s.registry.lastExportRequest(77), 1_000);
  s.registry.noteExportRequest(78);
  assert.equal(s.registry.lastExportRequest(78), undefined);
  remove();
  assert.equal(s.registry.lastExportRequest(77), undefined, "forgotten with the window");
});

// 3b (S85, M7): canvas_read's blocked count, from live mounts only.
test("3b: blockedForFrame sums the live mounts of one frame and ignores dead ones", () => {
  const s = setup();
  const TOKEN_B = "qrstuvwxyzabcdef";
  const admit = (node: number, token: string) => {
    assert.equal(s.registry.expectPlacement({ frameId: "f1", mountToken: token, expectedOrigin: ORIGIN }), "ok");
    s.live()?.add(node);
    assert.equal(s.registry.admit(s.navigation(node, {}, `aiden-app:f1:${token}`)), "app");
  };
  admit(20, TOKEN);
  admit(21, TOKEN_B);
  const ref = (id: number): AppFrameRef => ({ frameTreeNodeId: id, parent: null, url: `${ORIGIN}/`, origin: ORIGIN, isMainFrame: false });
  for (let i = 0; i < 3; i++) s.registry.reportBlocked(ref(20), `a${i}.example`);
  for (let i = 0; i < 2; i++) s.registry.reportBlocked(ref(21), `b${i}.example`);
  assert.equal(s.registry.blockedForFrame("f1"), 5);
  s.setLive(new Set([20]));
  assert.equal(s.registry.blockedForFrame("f1"), 3, "a mount that left the window doesn't count");
  s.setLive(null);
  assert.equal(s.registry.blockedForFrame("f1"), 0, "no window, no count");
  s.setLive(new Set([20, 21]));
  assert.equal(s.registry.blockedForFrame("unknown"), 0);
});
