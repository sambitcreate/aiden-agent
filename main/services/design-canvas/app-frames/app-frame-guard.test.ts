// D9's guard table, G1–G24, each verdict written by hand.
import assert from "node:assert/strict";
import test from "node:test";

import { createDesignFrameNavigationGuard } from "../frame-navigation.ts";
import { AppFrameRegistry } from "./app-frame-registry.ts";
import type { NamedFrameRef } from "./app-frame-ref.ts";
import { decideFrameNavigation, decideRedirect, type GuardContext, type GuardNavigation } from "./app-frame-guard.ts";

const ORIGIN = "http://127.0.0.1:5173";
const TOKEN = "abcdefghijklmnop";
const OWN = new Set([9222, 9229, 4143, 7777]);

type F = { frameTreeNodeId: number; parent: F | null; url: string; origin: string; name: string; isMainFrame: boolean };
const main: F = { frameTreeNodeId: 1, parent: null, url: "file:///main.html", origin: "file://", name: "", isMainFrame: true };
const child = (id: number, url = "about:blank", name = "", parent: F = main): F => ({
  frameTreeNodeId: id,
  parent,
  url,
  origin: url.startsWith("http") ? new URL(url).origin : "null",
  name,
  isMainFrame: false,
});

function setup(options: { designLive?: boolean; bound?: boolean; cap?: number; rendererOrigin?: string } = {}) {
  let clock = 0;
  const live = new Set<number>([1]);
  const registry = new AppFrameRegistry({ mainContents: () => ({}), liveIds: () => live, now: () => clock, cap: options.cap, schedule: () => undefined });
  const v1 = createDesignFrameNavigationGuard();
  const context: GuardContext = {
    designLive: options.designLive ?? true,
    registry: options.bound === false || options.designLive === false ? null : registry,
    v1,
    rendererOrigin: options.rendererOrigin ?? "file://",
    ownPorts: OWN,
  };
  const nav = (frame: F | null, url: string, initiator: GuardNavigation["initiator"] = "main-frame"): GuardNavigation => ({
    url,
    isMainFrame: false,
    frame: frame as NamedFrameRef | null,
    initiator,
  });
  /** Places and admits an app frame; returns it. */
  const app = (id = 10) => {
    registry.expectPlacement({ frameId: `f${id}`, mountToken: TOKEN, expectedOrigin: ORIGIN });
    const frame = child(id, "about:blank", `aiden-app:f${id}:${TOKEN}`);
    live.add(id);
    assert.equal(decideFrameNavigation(nav(frame, `${ORIGIN}/pricing`), context).allow, true);
    frame.url = `${ORIGIN}/pricing`;
    frame.origin = ORIGIN;
    return frame;
  };
  return { registry, context, nav, app, v1, live, tick: (ms: number) => (clock += ms) };
}

test("G1–G6: an app frame stays on loopback, redirects inside the app proceed", () => {
  const s = setup();
  const app = s.app();
  // G1
  assert.deepEqual(decideRedirect({ url: `${ORIGIN}/login`, isMainFrame: false, frame: app as NamedFrameRef }, s.context), { action: "proceed" });
  // G2
  assert.deepEqual(decideRedirect({ url: "https://example.com/", isMainFrame: false, frame: app as NamedFrameRef }, s.context), {
    action: "prevent",
    blocked: "example.com",
    refusedUrl: "https://example.com/",
  });
  // G3
  assert.deepEqual(decideRedirect({ url: "https://example.com/", isMainFrame: true, frame: main as NamedFrameRef }, s.context), { action: "prevent-and-open" });
  assert.deepEqual(decideRedirect({ url: "https://example.com/", isMainFrame: true, frame: main as NamedFrameRef }, setup({ designLive: false }).context), {
    action: "prevent-and-open",
  });
  // G4
  assert.deepEqual(decideFrameNavigation(s.nav(app, "https://example.com/"), s.context), {
    allow: false,
    blocked: "example.com",
    refusedUrl: "https://example.com/",
  });
  // G5
  assert.deepEqual(decideFrameNavigation(s.nav(app, "http://127.0.0.1:4321/"), s.context), { allow: true });
  assert.equal(s.registry.isAppFrame(10), true);
  // G6
  const nested = child(11, "about:blank", "", app);
  assert.deepEqual(decideFrameNavigation(s.nav(nested, "https://www.youtube.com/embed/x", "other"), s.context), {
    allow: false,
    blocked: "www.youtube.com",
    refusedUrl: undefined,
  });
});

test("G7, G8, G15, G16, G17: admission needs the record, its origin, the main frame as initiator, time and room", () => {
  const g7 = setup();
  g7.registry.expectPlacement({ frameId: "f20", mountToken: TOKEN, expectedOrigin: ORIGIN });
  assert.deepEqual(decideFrameNavigation(g7.nav(child(20, "about:blank", `aiden-app:f20:${TOKEN}`), `${ORIGIN}/pricing`), g7.context), {
    allow: true,
    admitted: true,
  });

  const g8 = setup();
  g8.registry.expectPlacement({ frameId: "f20", mountToken: TOKEN, expectedOrigin: ORIGIN });
  const frame8 = child(20, "about:blank", `aiden-app:f20:${TOKEN}`);
  assert.equal(decideFrameNavigation(g8.nav(frame8, "http://127.0.0.1:4321/"), g8.context).allow, false);
  assert.equal(decideFrameNavigation(g8.nav(frame8, `${ORIGIN}/`), g8.context).allow, false, "record consumed");

  const g15 = setup();
  g15.registry.expectPlacement({ frameId: "f20", mountToken: TOKEN, expectedOrigin: ORIGIN });
  assert.equal(decideFrameNavigation(g15.nav(child(20, "about:blank", `aiden-app:f20:${TOKEN}`), `${ORIGIN}/`, "other"), g15.context).allow, false);

  const g16 = setup();
  g16.registry.expectPlacement({ frameId: "f20", mountToken: TOKEN, expectedOrigin: ORIGIN });
  g16.tick(30_001);
  assert.equal(decideFrameNavigation(g16.nav(child(20, "about:blank", `aiden-app:f20:${TOKEN}`), `${ORIGIN}/`), g16.context).allow, false);

  const g17 = setup({ cap: 2 });
  g17.app(10);
  g17.app(11);
  g17.registry.expectPlacement({ frameId: "f20", mountToken: TOKEN, expectedOrigin: ORIGIN });
  assert.equal(decideFrameNavigation(g17.nav(child(20, "about:blank", `aiden-app:f20:${TOKEN}`), `${ORIGIN}/`), g17.context).allow, false);
});

test("G9–G14 and G24, flag on and off: frames that aren't admitted never reach loopback", () => {
  for (const designLive of [true, false]) {
    const s = setup({ designLive });
    const label = `flag ${designLive ? "on" : "off"}`;
    // G9: a generative-UI frame self-navigating to loopback.
    const genui = child(30, "aiden-genui://preview/x");
    assert.equal(decideFrameNavigation(s.nav(genui, "http://127.0.0.1:8080/", "other"), s.context).allow, false, `G9 ${label}`);
    // G10: a v1 file frame on an aiden-design: host to an app origin.
    const file = child(31);
    assert.equal(decideFrameNavigation(s.nav(file, "aiden-design://grant-a/design/a.html"), s.context).allow, true);
    file.url = "aiden-design://grant-a/design/a.html";
    assert.equal(decideFrameNavigation(s.nav(file, `${ORIGIN}/`, "other"), s.context).allow, false, `G10 ${label}`);
    // G24: another aiden-design: host.
    assert.equal(decideFrameNavigation(s.nav(file, "aiden-design://grant-b/design/b.html", "other"), s.context).allow, false, `G24 ${label}`);
    // G11: a fresh unnamed direct child with no record.
    assert.equal(decideFrameNavigation(s.nav(child(32), "http://127.0.0.1:2375/"), s.context).allow, false, `G11 ${label}`);
    // G14: an unknown non-main frame.
    assert.equal(decideFrameNavigation(s.nav(child(33, "about:blank", "x"), "http://localhost:5173/"), s.context).allow, false, `G14 ${label}`);
    // G12 / G13: frame null toward loopback or the web.
    assert.equal(decideFrameNavigation(s.nav(null, "http://127.0.0.1:5173/"), s.context).allow, false, `G12 ${label}`);
    assert.equal(decideFrameNavigation(s.nav(null, "https://example.com/"), s.context).allow, false, `G13 ${label}`);
    assert.equal(decideFrameNavigation(s.nav(null, "vscode://x"), s.context).allow, false, `unknown scheme ${label}`);
    // frame null to a known in-app scheme keeps v1's handling.
    assert.equal(decideFrameNavigation(s.nav(null, "aiden-design://grant-a/design/a.html"), s.context).allow, true);
  }
});

test("G18, G19, G23: an app frame refuses Aiden's ports and external schemes, nested frames keep srcdoc and data", () => {
  const s = setup();
  const app = s.app();
  assert.equal(decideFrameNavigation(s.nav(app, "http://127.0.0.1:7777/"), s.context).allow, false); // G18
  const nested = child(12, "about:blank", "", app);
  for (const url of ["about:srcdoc", "data:text/html,x", `blob:${ORIGIN}/0b6c`]) {
    assert.equal(decideFrameNavigation(s.nav(nested, url, "other"), s.context).allow, true, `G19 ${url}`);
  }
  for (const url of ["mailto:x", "vscode://x", "slack://x"]) {
    assert.deepEqual(decideFrameNavigation(s.nav(app, url), s.context), { allow: false, blocked: url.split(":")[0], refusedUrl: undefined }, `G23 ${url}`);
  }
});

test("G20: a frame: null redirect is prevented and never opened", () => {
  const s = setup();
  assert.deepEqual(decideRedirect({ url: `${ORIGIN}/`, isMainFrame: false, frame: null }, s.context), { action: "prevent" });
  assert.deepEqual(decideRedirect({ url: "https://example.com/", isMainFrame: false, frame: null }, s.context), { action: "prevent" });
  // A non-app subframe's redirect is prevented, not opened.
  assert.deepEqual(decideRedirect({ url: "https://example.com/", isMainFrame: false, frame: child(40) as NamedFrameRef }, s.context), { action: "prevent" });
});

test("G21: with the flag off a direct child may load the renderer's own dev origin", () => {
  const s = setup({ designLive: false, rendererOrigin: "http://127.0.0.1:4143" });
  assert.equal(decideFrameNavigation(s.nav(child(50), "http://127.0.0.1:4143/visual-viewer.html"), s.context).allow, true);
  assert.equal(decideFrameNavigation(s.nav(child(51), "http://127.0.0.1:5173/"), s.context).allow, false);
});

test("G22: with the flag on but no bound registry, every loopback subframe is refused", () => {
  const s = setup({ bound: false, rendererOrigin: "http://127.0.0.1:4143" });
  assert.equal(decideFrameNavigation(s.nav(child(60), "http://127.0.0.1:4143/"), s.context).allow, false);
  assert.equal(decideFrameNavigation(s.nav(child(61, "about:blank", `aiden-app:f61:${TOKEN}`), `${ORIGIN}/`), s.context).allow, false);
});
