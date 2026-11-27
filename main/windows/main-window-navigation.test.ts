// Register-and-invoke tests of the main window's navigation rules: today's
// behaviour with the flag off (moved from main/index.ts), and S1, admission
// and the app guard with it on.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { DesignAppFrameEvent } from "../../renderer/shared/design-canvas/app-frame-events.ts";
import { AppFrameRegistry } from "../services/design-canvas/app-frames/app-frame-registry.ts";
import { installMainWindowNavigation, type NavigationContents } from "./main-window-navigation.ts";

const ORIGIN = "http://127.0.0.1:5173";
const TOKEN = "abcdefghijklmnop";
const ERR_BLOCKED_BY_CSP = -30;

type FakeFrame = { frameTreeNodeId: number; parent: FakeFrame | null; url: string; origin: string; name: string };

class FakeContents extends EventEmitter {
  url = "file:///app/main-window.html";
  mainFrame: FakeFrame = { frameTreeNodeId: 1, parent: null, url: this.url, origin: "file://", name: "" };
  openHandler: ((details: { url: string }) => { action: string }) | null = null;
  getURL() {
    return this.url;
  }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }) {
    this.openHandler = handler;
  }
  child(id: number, url = "about:blank", name = "", parent: FakeFrame = this.mainFrame): FakeFrame {
    return { frameTreeNodeId: id, parent, url, origin: url.startsWith("http") ? new URL(url).origin : "null", name };
  }
  /** Emits will-frame-navigate and reports whether it was prevented. */
  frameNavigate(frame: FakeFrame | null, url: string, initiator: FakeFrame | null = this.mainFrame): boolean {
    let prevented = false;
    this.emit("will-frame-navigate", { url, isMainFrame: false, frame, initiator, preventDefault: () => (prevented = true) });
    return prevented;
  }
  /** Emits did-fail-provisional-load the way Electron does, naming the frame by process and routing id. */
  failLoad(frame: FakeFrame | null, url: string, errorCode = ERR_BLOCKED_BY_CSP, isMainFrame = false): void {
    const ids = frame ? [7, frame.frameTreeNodeId + 1000] : [7, 9999];
    this.emit("did-fail-provisional-load", {}, errorCode, "ERR_BLOCKED_BY_CSP", url, isMainFrame, ...ids);
  }
  redirect(frame: FakeFrame | null, url: string, isMainFrame = false): boolean {
    let prevented = false;
    this.emit("will-redirect", { url, isMainFrame, frame, preventDefault: () => (prevented = true) }, url);
    return prevented;
  }
}

function setup(options: { designLive: boolean; rendererOrigin?: string; withRegistry?: boolean }) {
  const contents = new FakeContents();
  let bound: unknown = contents;
  const registry = new AppFrameRegistry({
    mainContents: () => bound,
    liveIds: () => new Set([1, 10, 20]),
    schedule: (callback) => {
      callback();
    },
  });
  const events: DesignAppFrameEvent[] = [];
  registry.onEvent((event) => events.push(event));
  const opened: string[] = [];
  const frames = new Map<number, FakeFrame>();
  const dispose = installMainWindowNavigation(contents as unknown as NavigationContents, {
    frameFromId: (processId, routingId) => (processId === 7 ? (frames.get(routingId - 1000) ?? null) : null),
    openExternal: (url) => opened.push(url),
    warn: () => {},
    designLive: options.designLive,
    registry: () => (options.withRegistry === false ? null : registry),
    rendererOrigin: options.rendererOrigin ?? "file://",
    ownPorts: () => new Set([9222, 9229, 7777]),
  });
  const placeAndAdmit = (id = 10) => {
    registry.expectPlacement({ frameId: `f${id}`, mountToken: TOKEN, expectedOrigin: ORIGIN });
    const frame = contents.child(id, "about:blank", `aiden-app:f${id}:${TOKEN}`);
    assert.equal(contents.frameNavigate(frame, `${ORIGIN}/pricing`), false, "admitted");
    frame.url = `${ORIGIN}/pricing`;
    frame.origin = ORIGIN;
    frames.set(id, frame);
    return frame;
  };
  return { contents, registry, events, opened, frames, dispose, placeAndAdmit, rebind: (next: unknown) => (bound = next) };
}

test("flag off: window.open opens externally and is denied", () => {
  const s = setup({ designLive: false });
  assert.deepEqual(s.contents.openHandler!({ url: "https://example.com/" }), { action: "deny" });
  assert.deepEqual(s.opened, ["https://example.com/"]);
});

test("flag off: a main-frame navigation elsewhere is prevented and opened externally; the same URL is allowed", () => {
  const s = setup({ designLive: false });
  let prevented = false;
  s.contents.emit("will-navigate", { preventDefault: () => (prevented = true) }, "https://example.com/");
  assert.equal(prevented, true);
  assert.deepEqual(s.opened, ["https://example.com/"]);
  prevented = false;
  s.contents.emit("will-navigate", { preventDefault: () => (prevented = true) }, s.contents.url);
  assert.equal(prevented, false);
});

test("flag off: a redirect in any frame is prevented and opened externally (today's)", () => {
  const s = setup({ designLive: false });
  assert.equal(s.contents.redirect(s.contents.child(5, `${ORIGIN}/`), "https://example.com/"), true);
  assert.equal(s.contents.redirect(s.contents.mainFrame, "https://example.org/", true), true);
  assert.deepEqual(s.opened, ["https://example.com/", "https://example.org/"]);
});

test("flag off: the v1 design guard keeps a design frame on its host (G24)", () => {
  const s = setup({ designLive: false });
  const frame = s.contents.child(30);
  assert.equal(s.contents.frameNavigate(frame, "aiden-design://grant-a/design/a.html"), false);
  frame.url = "aiden-design://grant-a/design/a.html";
  assert.equal(s.contents.frameNavigate(frame, "aiden-design://grant-b/design/b.html"), true);
  assert.equal(s.contents.frameNavigate(frame, "aiden-design://grant-a/design/c.html"), false);
});

test("flag off: loopback is refused for every subframe but the renderer's own origin (G9–G12, G14, G21)", () => {
  const s = setup({ designLive: false, rendererOrigin: "http://127.0.0.1:4143" });
  assert.equal(s.contents.frameNavigate(s.contents.child(40), "http://127.0.0.1:5173/"), true, "a direct child");
  assert.equal(s.contents.frameNavigate(s.contents.child(41, "aiden-genui://preview/x"), "http://127.0.0.1:8080/"), true, "a genui frame");
  const file = s.contents.child(42);
  s.contents.frameNavigate(file, "aiden-design://grant/design/a.html");
  file.url = "aiden-design://grant/design/a.html";
  assert.equal(s.contents.frameNavigate(file, `${ORIGIN}/`), true, "a file frame");
  assert.equal(s.contents.frameNavigate(null, "http://127.0.0.1:5173/"), true, "frame: null");
  assert.equal(s.contents.frameNavigate(s.contents.child(43, "about:blank", `aiden-app:f43:${TOKEN}`), "http://localhost:5173/"), true, "a named frame");
  assert.equal(s.contents.frameNavigate(s.contents.child(44), "http://127.0.0.1:4143/visual-viewer.html"), false, "the renderer's own origin");
  // And no flag-on listener exists.
  assert.equal(s.contents.listenerCount("select-bluetooth-device"), 0);
});

test("flag on: a subframe redirect never calls openExternal (S1, G1, G2)", () => {
  const s = setup({ designLive: true });
  const app = s.placeAndAdmit();
  assert.equal(s.contents.redirect(app, `${ORIGIN}/login`), false, "loopback → loopback proceeds");
  assert.equal(s.contents.redirect(app, "https://example.com/"), true);
  assert.deepEqual(s.opened, []);
  assert.deepEqual(
    s.events.filter((e) => e.kind === "navigation-refused"),
    [{ kind: "navigation-refused", frameId: "f10", mountToken: TOKEN, url: "https://example.com/" }],
  );
  assert.ok(s.events.some((e) => e.kind === "blocked" && e.hosts.includes("example.com")));
  assert.equal(s.contents.redirect(null, "https://example.com/"), true, "frame: null prevented");
  assert.equal(s.contents.redirect(s.contents.child(50, "aiden-genui://x"), "https://example.com/"), true);
  assert.deepEqual(s.opened, []);
});

test("flag on: a main-frame redirect still opens externally (G3)", () => {
  const s = setup({ designLive: true });
  assert.equal(s.contents.redirect(s.contents.mainFrame, "https://example.com/", true), true);
  assert.deepEqual(s.opened, ["https://example.com/"]);
});

test("flag on: an app frame's link out is prevented and sends one navigation-refused (G4)", () => {
  const s = setup({ designLive: true });
  const app = s.placeAndAdmit();
  assert.equal(s.contents.frameNavigate(app, "https://example.com/x", app), true);
  assert.deepEqual(
    s.events.filter((e) => e.kind === "navigation-refused").map((e) => e.kind === "navigation-refused" && e.url),
    ["https://example.com/x"],
  );
});

test("flag on: mailto:, vscode: and slack: from an app frame are refused and never opened (G23)", () => {
  const s = setup({ designLive: true });
  const app = s.placeAndAdmit();
  for (const url of ["mailto:x", "vscode://x", "slack://x"]) assert.equal(s.contents.frameNavigate(app, url, app), true, url);
  assert.deepEqual(s.opened, []);
  assert.equal(s.events.some((e) => e.kind === "navigation-refused"), false);
});

test("flag on: an app frame's CSP-blocked way out is refused like a redirect, counted, and the frame is put back (S1, D1)", () => {
  const s = setup({ designLive: true });
  const app = s.placeAndAdmit();
  // The main window's frame-src refuses these before will-frame-navigate or will-redirect runs.
  s.contents.failLoad(app, "https://example.com/");
  s.contents.failLoad(app, "mailto:x@example.com");
  assert.deepEqual(s.opened, [], "nothing opens by itself");
  assert.deepEqual(
    s.events.filter((e) => e.kind === "navigation-refused").map((e) => e.kind === "navigation-refused" && e.url),
    ["https://example.com/"],
    "Open in browser is offered for the web target only",
  );
  const blocked = s.events.filter((e) => e.kind === "blocked").slice(-1)[0];
  assert.equal(blocked?.kind === "blocked" && blocked.count, 2);
  assert.deepEqual(blocked?.kind === "blocked" && blocked.hosts, ["example.com", "mailto"]);
  assert.deepEqual(
    s.events.filter((e) => e.kind === "navigation-restore"),
    [
      { kind: "navigation-restore", frameId: "f10", mountToken: TOKEN },
      { kind: "navigation-restore", frameId: "f10", mountToken: TOKEN },
    ],
  );
});

test("flag on: other load failures, other frames and the flag off leave a failed load alone", () => {
  const s = setup({ designLive: true });
  const app = s.placeAndAdmit();
  s.contents.failLoad(app, "https://example.com/", -3);
  s.contents.failLoad(s.contents.child(30, `${ORIGIN}/`), "https://example.com/");
  s.contents.failLoad(null, "https://example.com/");
  s.contents.failLoad(s.contents.mainFrame, "https://example.com/", ERR_BLOCKED_BY_CSP, true);
  assert.deepEqual(s.events, [], "an aborted load, an unplaced frame, an unknown frame and the main frame get nothing");

  const off = setup({ designLive: false });
  off.contents.failLoad(off.contents.child(10, `${ORIGIN}/`), "https://example.com/");
  assert.deepEqual(off.events, []);
  assert.deepEqual(off.opened, []);
});

test("flag on: an app frame's own data: or blob: page, which the window's frame-src refuses, is counted with no toast and put back", () => {
  const s = setup({ designLive: true });
  const app = s.placeAndAdmit();
  s.contents.failLoad(app, "data:text/html,<p>preview</p>");
  s.contents.failLoad(app, `blob:${ORIGIN}/5b1c-preview`);
  assert.equal(s.events.some((e) => e.kind === "navigation-refused"), false, "no Open in browser for these");
  const blocked = s.events.filter((e) => e.kind === "blocked").slice(-1)[0];
  assert.equal(blocked?.kind === "blocked" && blocked.count, 2);
  assert.equal(s.events.filter((e) => e.kind === "navigation-restore").length, 2);

  // A frame inside the app answers to the app's own policy, and a loopback page that
  // refuses framing (frame-ancestors) isn't a way out: neither touches the app frame.
  const quiet = setup({ designLive: true });
  const parent = quiet.placeAndAdmit();
  const nested = quiet.contents.child(40, `${ORIGIN}/inner`, "", parent);
  quiet.frames.set(40, nested);
  quiet.contents.failLoad(nested, "data:text/html,x");
  quiet.contents.failLoad(parent, "http://127.0.0.1:4000/");
  quiet.contents.failLoad(parent, "about:blank");
  assert.deepEqual(quiet.events, []);
});

test("flag on: a placed frame is admitted only on its expected origin and initiator (G7, G8, G15)", () => {
  const s = setup({ designLive: true });
  s.registry.expectPlacement({ frameId: "f20", mountToken: TOKEN, expectedOrigin: ORIGIN });
  assert.equal(s.contents.frameNavigate(s.contents.child(20, "about:blank", `aiden-app:f20:${TOKEN}`), "http://127.0.0.1:4321/"), true);
  s.registry.expectPlacement({ frameId: "f21", mountToken: TOKEN, expectedOrigin: ORIGIN });
  const other = s.contents.child(99, `${ORIGIN}/`);
  assert.equal(s.contents.frameNavigate(s.contents.child(21, "about:blank", `aiden-app:f21:${TOKEN}`), `${ORIGIN}/`, other), true);
  s.registry.expectPlacement({ frameId: "f22", mountToken: TOKEN, expectedOrigin: ORIGIN });
  assert.equal(s.contents.frameNavigate(s.contents.child(22, "about:blank", `aiden-app:f22:${TOKEN}`), `${ORIGIN}/`), false);
  assert.equal(s.registry.isAppFrame(22), true);
});

test("flag on: before the registry is installed, a loopback subframe is refused (G22)", () => {
  const s = setup({ designLive: true, withRegistry: false });
  assert.equal(s.contents.frameNavigate(s.contents.child(20, "about:blank", `aiden-app:f20:${TOKEN}`), `${ORIGIN}/`), true);
});

test("flag on: a second window gets the same handlers, and the registry decides only for the bound window", () => {
  const s = setup({ designLive: true });
  // Window A closes: the getter no longer returns it.
  s.rebind(null);
  s.registry.expectPlacement({ frameId: "f20", mountToken: TOKEN, expectedOrigin: ORIGIN });
  assert.equal(s.contents.frameNavigate(s.contents.child(20, "about:blank", `aiden-app:f20:${TOKEN}`), `${ORIGIN}/`), true, "an unbound window refuses");
  const b = new FakeContents();
  s.rebind(b);
  installMainWindowNavigation(b as unknown as NavigationContents, {
    openExternal: () => {},
    warn: () => {},
    designLive: true,
    registry: () => s.registry,
    rendererOrigin: "file://",
    ownPorts: () => new Set(),
  });
  s.registry.expectPlacement({ frameId: "f21", mountToken: TOKEN, expectedOrigin: ORIGIN });
  assert.equal(b.frameNavigate(b.child(21, "about:blank", `aiden-app:f21:${TOKEN}`), `${ORIGIN}/`), false, "an app frame in B is admitted");
  assert.equal(b.frameNavigate(b.child(22, "aiden-genui://preview/x"), `${ORIGIN}/`), true, "a genui frame in B is refused");
});

test("flag on: select-bluetooth-device is answered with an empty choice", () => {
  const s = setup({ designLive: true });
  let prevented = false;
  let chosen: string | null = null;
  s.contents.emit("select-bluetooth-device", { preventDefault: () => (prevented = true) }, [{ deviceId: "a" }], (id: string) => (chosen = id));
  assert.equal(prevented, true);
  assert.equal(chosen, "");
});
