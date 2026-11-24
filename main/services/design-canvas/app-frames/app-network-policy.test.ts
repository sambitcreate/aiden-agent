import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { AppFrameRegistry } from "./app-frame-registry.ts";
import {
  APP_CONNECT_SRC,
  AppCancelCache,
  appRequestVerdict,
  appResponseHeaders,
  appSetCookie,
  isAppLoopback,
  type AppFrameRef,
  type AppPolicyContext,
  type AppRequest,
} from "./app-network-policy.ts";

// Aiden's own ports in these tests: the debugging floor, an actual debugging
// port, the renderer dev server, the Remote server, the local device host and
// the device daemon's httpPort.
const OWN = new Set([9222, 9229, 9333, 4143, 7777, 6001, 6002]);
const APP = "http://127.0.0.1:5173";

type Frame = { frameTreeNodeId: number; parent: Frame | null; url: string; origin: string; isMainFrame: boolean };

function frame(id: number, parent: Frame | null, url: string, origin = new URL(url).origin): Frame {
  return { frameTreeNodeId: id, parent, url, origin, isMainFrame: false };
}

function world(rendererOrigin = "file://") {
  const main: Frame = { frameTreeNodeId: 1, parent: null, url: "file:///app/main-window.html", origin: "file://", isMainFrame: true };
  let clock = 0;
  const registry = new AppFrameRegistry({
    mainContents: () => ({}),
    liveIds: () => null,
    rendererOrigin,
    now: () => clock,
    schedule: () => undefined,
  });
  const admit = (f: Frame, token = "t".repeat(16)) => {
    registry.expectPlacement({ frameId: `f${f.frameTreeNodeId}`, mountToken: token, expectedOrigin: APP });
    const result = registry.admit({
      frame: { frameTreeNodeId: f.frameTreeNodeId, name: `aiden-app:f${f.frameTreeNodeId}:${token}`, url: "about:blank" },
      targetUrl: `${APP}/`,
      isDirectChild: true,
      initiator: "main-frame",
      designFrame: false,
    });
    assert.equal(result, "app");
  };
  const app = frame(10, main, `${APP}/`);
  admit(app);
  const exported = new Set<number>([501]);
  let walks = 0;
  const context: AppPolicyContext = {
    appContext: (f, inMain) => {
      walks += 1;
      return registry.appContext(f, inMain);
    },
    isAppOrigin: (origin) => origin === APP || origin === "http://localhost:5173" || origin === "http://[::1]:5173",
    isExportContents: (id) => exported.has(id),
    rendererOrigin,
    ownPorts: OWN,
    frameless: ["https://allowed.example/updates/"],
  };
  return {
    main,
    app,
    registry,
    context,
    walks: () => walks,
    tick: (ms: number) => {
      clock += ms;
    },
    fromApp: (url: string, f: Frame = app): AppRequest => ({ url, frame: f, inMainWindow: true, webContentsId: 2 }),
    frameless: (url: string, initiatorOrigin?: string): AppRequest => ({ url, frame: null, initiatorOrigin, inMainWindow: false }),
  };
}

test("D3 rows A1–A10: an app frame may reach loopback, data:, about: and loopback blobs", () => {
  const w = world();
  const v = (url: string) => appRequestVerdict(w.fromApp(url), w.context);
  assert.equal(v("http://127.0.0.1:5173/src/main.tsx"), "allow"); // A1
  assert.equal(v("http://localhost:5173/"), "allow"); // A2
  assert.equal(v("http://[::1]:5173/"), "allow"); // A3
  assert.equal(v("ws://127.0.0.1:5173/"), "allow"); // A4
  assert.equal(v("ws://localhost:24678/"), "allow"); // A5
  assert.equal(v("data:image/png;base64,iVBORw0KGgo="), "allow"); // A6
  assert.equal(v("blob:http://127.0.0.1:5173/0b6c1e2a-0000-4000-8000-000000000000"), "allow"); // A7
  assert.equal(v("http://127.0.0.1:4321/api"), "allow"); // A8
  assert.equal(v("http://2130706433:5173/"), "allow"); // A9
  assert.equal(v("about:srcdoc"), "allow"); // A10
});

test("D3 rows A11–A34: everything else from an app frame is cancelled", () => {
  const w = world();
  const v = (url: string) => appRequestVerdict(w.fromApp(url), w.context);
  assert.equal(v("https://example.com/"), "cancel"); // A11
  assert.equal(v("http://192.168.1.10/"), "cancel"); // A12
  assert.equal(v("http://localhost.evil.com:5173/"), "cancel"); // A13
  assert.equal(v("http://localhost.:5173/"), "cancel"); // A14
  assert.equal(v("http://app.localhost:5173/"), "cancel"); // A15
  assert.equal(v("http://0.0.0.0:5173/"), "cancel"); // A16
  assert.equal(v("http://127.0.0.2:5173/"), "cancel"); // A17
  assert.equal(v("http://[::ffff:127.0.0.1]:5173/"), "cancel"); // A18
  assert.equal(v("https://127.0.0.1:5173/"), "cancel"); // A19
  assert.equal(v("wss://localhost:5173/"), "cancel"); // A20
  assert.equal(v("ws://example.com/"), "cancel"); // A21
  assert.equal(v("aiden-design://grant/design/a.html"), "cancel"); // A22
  assert.equal(v("aiden-genui://preview/x"), "cancel"); // A23
  assert.equal(v("aiden-asset://asset/x.png"), "cancel"); // A24
  assert.equal(v("aiden-attachment://chat/x.png"), "cancel"); // A24
  assert.equal(v("file:///etc/hosts"), "cancel"); // A25
  assert.equal(v("blob:https://example.com/0b6c1e2a-0000-4000-8000-000000000000"), "cancel"); // A26
  assert.equal(v("http://127.0.0.1:9222/json"), "cancel"); // A27
  assert.equal(v("http://127.0.0.1:4143/"), "cancel"); // A28
  assert.equal(v("http://127.0.0.1:7777/"), "cancel"); // A29
  assert.equal(v("chrome-extension://abc/x.js"), "cancel"); // A30
  assert.equal(v("http://127.0.0.1:6001/"), "cancel"); // A31
  assert.equal(v("http://127.0.0.1:6002/health"), "cancel"); // A32
  assert.equal(v("ws://[::1]:7777/"), "cancel"); // A33
  assert.equal(v("http://127.0.0.1:9333/json"), "cancel"); // A34
  assert.equal(v("devtools://devtools/bundled/x"), "cancel");
  assert.equal(v("not a url"), "cancel");
});

test("D3 rows A35–A47 and R1–R5", () => {
  const w = world();
  const v = (url: string, f?: Frame) => appRequestVerdict(w.fromApp(url, f), w.context);
  assert.equal(v("aiden-design://grant/design/x.js"), "cancel"); // A35
  assert.equal(v("https://127.0.0.1:41000/p"), "cancel"); // A36 ping
  assert.equal(v("https://example.com/events"), "cancel"); // A37
  assert.equal(v("https://example.com/font.woff2"), "cancel"); // A38
  assert.equal(v("https://127.0.0.1:41000/prefetch.js"), "cancel"); // A39
  assert.equal(v("http://127.0.0.1:7777/"), "cancel"); // A41 hop 2
  assert.equal(v("http://localhost.evil.test/"), "cancel"); // A42 hop 2
  assert.equal(appRequestVerdict(w.frameless("https://example.com/", APP), w.context), "cancel"); // A43 worker
  assert.equal(v("https://example.com/beacon"), "cancel"); // A44
  // A45: a main-window frame whose chain never reaches the main frame.
  const orphanRoot = frame(40, null, "about:blank", "null");
  assert.equal(v("https://example.com/", frame(41, orphanRoot, "about:blank", "null")), "cancel");
  assert.equal(v("https://example.com/", w.app), "cancel"); // A46 (own navigation, external target)
  // A47: not registered, but committed on another loopback origin (backstop).
  assert.equal(v("https://example.com/", frame(47, w.main, "http://127.0.0.1:4321/")), "cancel");
  assert.equal(v("https://example.com/"), "cancel"); // R1 hop 2
  assert.equal(v("http://127.0.0.1:5173/login"), "allow"); // R3
  const nested = frame(11, w.app, "https://www.youtube.com/embed/x");
  assert.equal(v("https://www.youtube.com/embed/x", nested), "cancel"); // R4
  const deep = frame(13, frame(12, nested, "about:srcdoc", "null"), "data:text/html,x", "null");
  assert.equal(v("https://example.com/", deep), "cancel"); // a registered ancestor three levels up
  // R5: the app frame later navigated to another loopback origin; still sticky.
  const moved = { ...w.app, url: "http://127.0.0.1:4321/", origin: "http://127.0.0.1:4321" };
  assert.equal(v("https://example.com/", moved), "cancel");
});

test("a destroyed frame (throwing reads) in the main window is cancelled", () => {
  const w = world();
  const destroyed = {
    get frameTreeNodeId(): number {
      throw new Error("destroyed");
    },
    get parent(): AppFrameRef | null {
      throw new Error("destroyed");
    },
    url: "",
    origin: "",
    isMainFrame: false,
  } as AppFrameRef;
  assert.equal(appRequestVerdict({ url: "https://example.com/", frame: destroyed, inMainWindow: true }, w.context), "cancel");
  assert.equal(appRequestVerdict({ url: "https://example.com/", frame: destroyed, inMainWindow: false }, w.context), "untouched");
});

test("D3 rows N1–N11: frameless requests by initiator", () => {
  for (const renderer of ["file://", "http://127.0.0.1:4143"]) {
    const w = world(renderer);
    const v = (url: string, initiator?: string) => appRequestVerdict(w.frameless(url, initiator), w.context);
    assert.equal(v("https://example.com/", APP), "cancel"); // N1
    assert.equal(v("https://example.com/b", "http://localhost:5173"), "cancel"); // N2
    assert.equal(v("https://example.com/k", "http://[::1]:5173"), "cancel"); // N3
    assert.equal(v("wss://example.com/", APP), "cancel"); // N4
    assert.equal(v("http://127.0.0.1:5173/sw.js", APP), "allow"); // N5
    assert.equal(v("https://example.com/", "null"), "cancel"); // N6
    assert.equal(v("https://example.com/", "http://127.0.0.1:9999"), "cancel"); // N7
    assert.equal(v("https://example.com/"), "cancel"); // N8
    assert.equal(v("https://allowed.example/updates/latest.yml"), "untouched"); // N9
    assert.equal(v("https://api.example.com/", renderer), "untouched"); // N10
    assert.equal(v("aiden-design://grant/x", APP), "untouched"); // N11
    assert.equal(v("data:text/plain,x", APP), "untouched"); // N11
    assert.equal(v("blob:http://127.0.0.1:5173/x", APP), "untouched"); // N11
  }
});

test("D3 rows E1, E2 and M1–M4", () => {
  const w = world();
  const exp = (url: string): AppRequest => ({ url, frame: null, webContentsId: 501, inMainWindow: false });
  assert.equal(appRequestVerdict(exp("http://127.0.0.1:5173/pricing"), w.context), "allow"); // E1
  assert.equal(appRequestVerdict(exp("https://fonts.googleapis.com/css2?family=Inter"), w.context), "cancel"); // E2
  assert.equal(appRequestVerdict({ url: "https://api.openai.com/v1/x", frame: w.main, inMainWindow: true }, w.context), "untouched"); // M1
  assert.equal(appRequestVerdict({ url: "http://127.0.0.1:5173/", frame: w.main, inMainWindow: true }, w.context), "untouched"); // M2
  const fileFrame = frame(30, w.main, "aiden-design://grant/design/a.html");
  assert.equal(appRequestVerdict({ url: "https://example.com/", frame: fileFrame, inMainWindow: true }, w.context), "untouched"); // M3
  const quickChatMain = { frameTreeNodeId: 90, parent: null, url: "file:///q.html", origin: "file://", isMainFrame: false };
  assert.equal(appRequestVerdict({ url: "https://example.com/", frame: quickChatMain, inMainWindow: false }, w.context), "untouched"); // M4
});

test("isAppLoopback normalizes before it compares", () => {
  assert.equal(isAppLoopback("http://2130706433:5173/", OWN), true);
  assert.equal(isAppLoopback("http://[0:0:0:0:0:0:0:1]:5173/", OWN), true);
  assert.equal(isAppLoopback("http://LOCALHOST:5173/", OWN), true);
  assert.equal(isAppLoopback("http://127.0.0.1/", OWN), true);
  assert.equal(isAppLoopback("http://127.0.0.1:9222/", OWN), false);
  assert.equal(isAppLoopback("http://127.0.0.1:80/", new Set([80])), false);
  assert.equal(isAppLoopback("https://127.0.0.1:5173/", OWN), false);
  assert.equal(isAppLoopback("http://localhost.:5173/", OWN), false);
});

test("the cancel cache skips the walk for a repeated cancel and never caches an allow", () => {
  let clock = 0;
  const w = world();
  w.context.cache = new AppCancelCache({ now: () => clock });
  appRequestVerdict(w.fromApp("https://example.com/a"), w.context);
  const after = w.walks();
  assert.equal(appRequestVerdict(w.fromApp("https://example.com/b"), w.context), "cancel");
  assert.equal(w.walks(), after, "the second cancel came from the cache");
  appRequestVerdict(w.fromApp("http://127.0.0.1:5173/x"), w.context);
  appRequestVerdict(w.fromApp("http://127.0.0.1:5173/x"), w.context);
  assert.equal(w.walks(), after + 2, "allows walk every time");
  clock += 1000;
  appRequestVerdict(w.fromApp("https://example.com/c"), w.context);
  assert.equal(w.walks(), after + 3, "after a second the walk runs again");
});

test("10 000 cancels from one frame stay cheap, and another request is still decided quickly", () => {
  const w = world();
  w.context.cache = new AppCancelCache();
  let worst = 0;
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) {
    appRequestVerdict(w.fromApp(`https://example.com/${i}`), w.context);
    if (i % 1000 === 0) {
      const t = performance.now();
      assert.equal(appRequestVerdict({ url: "https://api.example.com/", frame: w.main, inMainWindow: true }, w.context), "untouched");
      worst = Math.max(worst, performance.now() - t);
    }
  }
  assert.ok(performance.now() - start < 250, `took ${performance.now() - start} ms`);
  assert.ok(worst < 5, `an unrelated request took ${worst} ms`);
});

test("appSetCookie makes app cookies SameSite=None and Secure, keeping the rest", () => {
  assert.equal(appSetCookie("sid=1"), "sid=1; SameSite=None; Secure");
  assert.equal(appSetCookie("sid=1; SameSite=Lax"), "sid=1; SameSite=None; Secure");
  assert.equal(appSetCookie("sid=1; samesite=STRICT; Path=/"), "sid=1; Path=/; SameSite=None; Secure");
  assert.equal(appSetCookie("sid=1; Secure; SameSite=Lax"), "sid=1; Secure; SameSite=None");
  assert.equal(
    appSetCookie("sid=1; Max-Age=60; Path=/; HttpOnly; Domain=localhost"),
    "sid=1; Max-Age=60; Path=/; HttpOnly; Domain=localhost; SameSite=None; Secure",
  );
  assert.equal(appSetCookie("sid=1; Partitioned; Secure"), "sid=1; Partitioned; Secure; SameSite=None");
});

test("appResponseHeaders strips frame-blocking and reporting headers and narrows connect-src", () => {
  const doc = appResponseHeaders(
    {
      "x-frame-options": ["DENY"],
      "Content-Security-Policy": ["frame-ancestors 'none'; script-src 'self'", "frame-ancestors 'self'"],
      "Report-To": ["{}"],
      nel: ["{}"],
      "Reporting-Endpoints": ['e="https://x/r"'],
      "Set-Cookie": ["sid=1"],
      "Content-Type": ["text/html"],
    },
    { appOrigin: true, resourceType: "subFrame", exportMainFrame: false },
  );
  assert.equal(doc["x-frame-options"], undefined);
  assert.equal(doc["Report-To"], undefined);
  assert.equal(doc.nel, undefined);
  assert.equal(doc["Reporting-Endpoints"], undefined);
  assert.deepEqual(doc["Content-Security-Policy"], ["script-src 'self'", APP_CONNECT_SRC]);
  assert.deepEqual(doc["Set-Cookie"], ["sid=1; SameSite=None; Secure"]);
  assert.deepEqual(doc["X-DNS-Prefetch-Control"], ["off"]);
  assert.deepEqual(doc["Content-Type"], ["text/html"]);

  const image = appResponseHeaders({ "Content-Type": ["image/png"], NEL: ["{}"] }, { appOrigin: true, resourceType: "image", exportMainFrame: false });
  assert.deepEqual(image, { "Content-Type": ["image/png"] });

  const otherLoopback = appResponseHeaders(
    { "X-Frame-Options": ["DENY"], "Set-Cookie": ["a=1"], "Report-To": ["{}"] },
    { appOrigin: false, resourceType: "subFrame", exportMainFrame: false },
  );
  assert.deepEqual(otherLoopback["X-Frame-Options"], ["DENY"]);
  assert.deepEqual(otherLoopback["Set-Cookie"], ["a=1"]);
  assert.equal(otherLoopback["Report-To"], undefined);

  const exported = appResponseHeaders({}, { appOrigin: true, resourceType: "mainFrame", exportMainFrame: true });
  assert.ok(exported["Content-Security-Policy"]!.includes("sandbox allow-scripts allow-same-origin allow-forms"));
});
