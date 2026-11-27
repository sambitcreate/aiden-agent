// The design subscribers on the default session's dispatchers (design mode v2
// Phase 3a, D3–D8, S9, S76), over the real dispatchers and registry with fake
// Electron targets. Each verdict is written by hand.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { DesignAppFrameEvent } from "../../../../renderer/shared/design-canvas/app-frame-events.ts";
import { claimDefaultSessionPermissions, type PermissionTarget } from "../../default-session-permissions.ts";
import { claimDefaultSessionWebRequest } from "../../default-session-web-request.ts";
import {
  installGeminiLiveDisplayMediaGuards,
  type GeminiLiveDisplayMediaBinding,
} from "../../gemini-live/display-media-contract.ts";
import { installAppNetwork, type AppNetworkDeps, type MainContentsLike } from "./app-network-main.ts";
import type { AppServiceWorkerOrigins } from "./app-sw-origins.ts";

const ORIGIN = "http://127.0.0.1:5173";
const TOKEN = "abcdefghijklmnop";
type Callback<T> = (value: T) => void;

// ---- Fake Electron targets ----------------------------------------------------

type BeforeListener = ((details: unknown, callback: Callback<{ cancel?: boolean }>) => void) | null;
type HeadersListener = ((details: unknown, callback: Callback<{ responseHeaders?: Record<string, string[]> }>) => void) | null;

function fakeWebRequest() {
  const calls: string[] = [];
  const target: {
    before: BeforeListener;
    headers: HeadersListener;
    onBeforeRequest(listener: BeforeListener): void;
    onHeadersReceived(listener: HeadersListener): void;
  } = {
    before: null,
    headers: null,
    onBeforeRequest(listener) {
      calls.push(listener ? "before:set" : "before:null");
      target.before = listener;
    },
    onHeadersReceived(listener) {
      calls.push(listener ? "headers:set" : "headers:null");
      target.headers = listener;
    },
  };
  return { target, calls };
}

type Handler = ((...args: never[]) => unknown) | null;
function fakePermissions() {
  const emitter = new EventEmitter();
  const state = { check: null as Handler, request: null as Handler, display: null as Handler, device: null as Handler, calls: [] as string[] };
  const target = Object.assign(emitter, {
    setPermissionCheckHandler(handler: Handler) {
      state.calls.push("check");
      state.check = handler;
    },
    setPermissionRequestHandler(handler: Handler) {
      state.calls.push("request");
      state.request = handler;
    },
    setDisplayMediaRequestHandler(handler: Handler) {
      state.calls.push("display");
      state.display = handler;
    },
    setDevicePermissionHandler(handler: Handler) {
      state.calls.push("device");
      state.device = handler;
    },
  });
  return { target: target as unknown as PermissionTarget, emitter, state };
}

type Frame = { frameTreeNodeId: number; parent: Frame | null; url: string; origin: string; name: string; framesInSubtree?: Frame[] };

function frame(id: number, parent: Frame | null, url: string, name = ""): Frame {
  let origin = "null";
  try {
    origin = new URL(url).origin;
  } catch {
    // about:blank and friends stay opaque.
  }
  if (url.startsWith("file:")) origin = "file://";
  return { frameTreeNodeId: id, parent, url, origin, name };
}

function mainWindow(id: number) {
  const main = frame(id * 100, null, "file:///app/build/renderer/index.html");
  main.framesInSubtree = [main];
  const sent: DesignAppFrameEvent[] = [];
  const contents: MainContentsLike & { mainFrame: Frame } = {
    id,
    mainFrame: main,
    send: (channel: string, event: unknown) => {
      assert.equal(channel, "designCanvas:appFrame");
      sent.push(event as DesignAppFrameEvent);
    },
    isDestroyed: () => false,
  };
  const child = (childId: number, url: string, name = "", parent: Frame = main) => {
    const created = frame(childId, parent, url, name);
    main.framesInSubtree!.push(created);
    return created;
  };
  return { contents, main, sent, child };
}

function fakeServiceWorkers() {
  const calls: string[] = [];
  const service: AppServiceWorkerOrigins = {
    remember: async (origin) => {
      calls.push(`remember ${origin}`);
    },
    clear: async (origins) => {
      calls.push(origins ? `clear ${origins.join(",")}` : "clear all");
    },
    list: async () => [],
  };
  return { service, calls };
}

function setup(overrides: Partial<AppNetworkDeps> & { rendererOrigin?: string } = {}) {
  const webRequest = fakeWebRequest();
  const permissions = fakePermissions();
  const requestDispatcher = claimDefaultSessionWebRequest(webRequest.target as never);
  const permissionDispatcher = claimDefaultSessionPermissions(permissions.target);
  let window: ReturnType<typeof mainWindow> | null = mainWindow(1);
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const timers: Array<() => void> = [];
  let clock = 10_000;
  const workers = fakeServiceWorkers();
  const deps: AppNetworkDeps = {
    enabled: true,
    webRequest: requestDispatcher,
    permissions: permissionDispatcher,
    isAppOrigin: (origin) => origin === ORIGIN,
    mainContents: () => window?.contents ?? null,
    rendererOrigin: "file://",
    loopbackPorts: { snapshot: () => new Set([47_000]) },
    commandLine: { getSwitchValue: () => "" },
    inspectorUrl: () => undefined,
    serviceWorkers: workers.service,
    log: (event, fields) => logs.push({ event, fields }),
    now: () => clock,
    schedule: (callback) => {
      timers.push(callback);
    },
    ...overrides,
  };
  const network = installAppNetwork(deps);
  const admit = (childId = 7, frameId = "f1", origin = ORIGIN) => {
    const win = window!;
    const name = `aiden-app:${frameId}:${TOKEN}`;
    const created = win.child(childId, "about:blank", name);
    assert.equal(network!.registry.expectPlacement({ frameId, mountToken: TOKEN, expectedOrigin: origin }), "ok");
    assert.equal(
      network!.registry.admit({ frame: created, targetUrl: `${origin}/`, isDirectChild: true, initiator: "main-frame", designFrame: false }),
      "app",
    );
    created.url = `${origin}/`;
    created.origin = origin;
    return created;
  };
  const request = (details: { url: string; frame?: Frame | null; initiatorOrigin?: string; webContentsId?: number; resourceType?: string }) => {
    let response: { cancel?: boolean } | undefined;
    webRequest.target.before!({ resourceType: "xhr", ...details, frame: details.frame ?? null }, (value) => (response = value));
    return response?.cancel === true ? "cancel" : "pass";
  };
  const respond = (details: { url: string; frame?: Frame | null; webContentsId?: number; resourceType?: string; initiatorOrigin?: string }, responseHeaders: Record<string, string[]>) => {
    let response: { responseHeaders?: Record<string, string[]> } | undefined;
    webRequest.target.headers!({ resourceType: "subFrame", ...details, frame: details.frame ?? null, responseHeaders }, (value) => (response = value));
    return response?.responseHeaders ?? responseHeaders;
  };
  const check = (contents: { id: number } | null, permission: string, details: Record<string, unknown>) =>
    (permissions.state.check as unknown as (...args: unknown[]) => boolean)(contents, permission, details.requestingUrl ?? "", details);
  const ask = (contents: { id: number }, permission: string, details: Record<string, unknown>) => {
    let granted: boolean | undefined;
    (permissions.state.request as unknown as (...args: unknown[]) => void)(contents, permission, (value: boolean) => (granted = value), details);
    return granted;
  };
  return {
    deps,
    network,
    webRequest,
    permissions,
    permissionDispatcher,
    window: () => window!,
    replaceWindow: (next: ReturnType<typeof mainWindow> | null) => {
      window = next;
    },
    logs,
    workers,
    flush: () => {
      for (const timer of timers.splice(0)) timer();
    },
    tick: (ms: number) => {
      clock += ms;
    },
    admit,
    request,
    respond,
    check,
    ask,
  };
}

// ---- Flag off ------------------------------------------------------------------

test("with live apps off nothing is subscribed, no handler is set, and app service workers are still cleared", async () => {
  const s = setup({ enabled: false });
  assert.equal(s.network, null);
  assert.deepEqual(s.webRequest.calls, [], "no webRequest listener");
  assert.deepEqual(s.permissions.state.calls, [], "no permission setter call");
  assert.equal(s.permissions.emitter.listenerCount("will-download"), 0);
  assert.equal(s.permissions.emitter.listenerCount("select-hid-device"), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(s.workers.calls, ["clear all"], "S76: the startup clear runs flag off too");
});

// ---- Requests ------------------------------------------------------------------

test("an app frame's request to the internet is cancelled and counted for its canvas frame; the main frame is untouched", () => {
  const s = setup();
  const app = s.admit();
  assert.equal(s.request({ url: "https://example.com/x.js", frame: app, webContentsId: 1 }), "cancel");
  assert.equal(s.request({ url: `${ORIGIN}/src/main.tsx`, frame: app, webContentsId: 1 }), "pass");
  assert.equal(s.request({ url: "https://example.com/", frame: s.window().main, webContentsId: 1 }), "pass", "M1");
  s.flush();
  assert.deepEqual(s.window().sent, [{ kind: "blocked", frameId: "f1", mountToken: TOKEN, count: 1, hosts: ["example.com"] }]);
});

test("a nested frame inside an app frame is app context too", () => {
  const s = setup();
  const app = s.admit();
  const nested = s.window().child(8, "https://www.youtube.com/embed/x", "", app);
  assert.equal(s.request({ url: "https://www.youtube.com/embed/x", frame: nested, webContentsId: 1, resourceType: "subFrame" }), "cancel");
});

test("Aiden's own ports are refused to app frames, other loopback ports aren't", () => {
  const s = setup();
  const app = s.admit();
  assert.equal(s.request({ url: "http://127.0.0.1:47000/api", frame: app, webContentsId: 1 }), "cancel");
  assert.equal(s.request({ url: "http://127.0.0.1:9222/json", frame: app, webContentsId: 1 }), "cancel");
  assert.equal(s.request({ url: "http://127.0.0.1:4321/api", frame: app, webContentsId: 1 }), "pass");
});

test("a frameless request with no initiator to an unlisted host is cancelled and logged by host, once a minute", () => {
  const s = setup();
  assert.equal(s.request({ url: "https://telemetry.example/v1?id=secret" }), "cancel");
  assert.equal(s.request({ url: "https://telemetry.example/v2" }), "cancel");
  assert.deepEqual(s.logs, [{ event: "design-live frameless-cancel", fields: { host: "telemetry.example" } }]);
  s.tick(61_000);
  s.request({ url: "https://telemetry.example/v3" });
  assert.equal(s.logs.length, 2);
  assert.equal(s.request({ url: "https://example.com/", initiatorOrigin: "file://" }), "pass", "the renderer's own frameless traffic");
  assert.equal(s.request({ url: "https://example.com/beacon", initiatorOrigin: ORIGIN }), "cancel", "an app's pagehide beacon");
});

test("a frameless request on the audited allowlist passes", () => {
  const s = setup({ frameless: ["https://updates.example.com/"] });
  assert.equal(s.request({ url: "https://updates.example.com/feed.yml" }), "pass");
  assert.equal(s.request({ url: "https://updates.example.com.evil.test/" }), "cancel");
});

// ---- Response headers ------------------------------------------------------------

test("app-frame responses from the app's origin get the cookie rewrite and lose frame blocking; other frames keep theirs", () => {
  const s = setup();
  const app = s.admit();
  const genui = s.window().child(9, "aiden-genui://card/index.html");
  const original = { "Set-Cookie": ["sid=1"], "X-Frame-Options": ["DENY"], "Report-To": ['{"group":"e"}'] };

  const appHeaders = s.respond({ url: `${ORIGIN}/`, frame: app, webContentsId: 1, resourceType: "subFrame" }, original);
  assert.match(appHeaders["Set-Cookie"]![0]!, /^sid=1;.*SameSite=None/iu);
  assert.match(appHeaders["Set-Cookie"]![0]!, /Secure/u);
  assert.equal(appHeaders["X-Frame-Options"], undefined);
  assert.equal(appHeaders["Report-To"], undefined);
  assert.ok(appHeaders["Content-Security-Policy"]!.some((value) => value.startsWith("connect-src")), "loopback-only connect-src");
  assert.deepEqual(appHeaders["X-DNS-Prefetch-Control"], ["off"]);

  const otherHeaders = s.respond({ url: "aiden-genui://card/index.html", frame: genui, webContentsId: 1 }, original);
  assert.deepEqual(otherHeaders, original, "a non-app frame's response is untouched");
});

test("an app-context response from another loopback origin loses reporting headers but keeps its own frame rules and cookies", () => {
  const s = setup();
  const app = s.admit();
  const headers = s.respond(
    { url: "http://127.0.0.1:4321/data.json", frame: app, webContentsId: 1, resourceType: "xhr" },
    { "Set-Cookie": ["other=1"], "X-Frame-Options": ["DENY"], NEL: ["{}"], "Reporting-Endpoints": ['e="x"'] },
  );
  assert.deepEqual(headers, { "Set-Cookie": ["other=1"], "X-Frame-Options": ["DENY"] });
});

// ---- Own ports ------------------------------------------------------------------

test("the debugging ports from the real switches, the floor and the registered services are Aiden's own", () => {
  const s = setup({
    commandLine: { getSwitchValue: (name) => (name === "remote-debugging-port" ? "9333" : "") },
    inspectorUrl: () => "ws://127.0.0.1:9339/2b0f2c2e",
    rendererOrigin: "http://127.0.0.1:4143",
  });
  const ports = s.network!.ownPorts();
  for (const port of [9333, 9339, 9222, 9229, 4143, 47_000]) assert.equal(ports.has(port), true, String(port));
  assert.equal(ports.has(5173), false);
});

// ---- Permissions (S9) ----------------------------------------------------------

function liveBinding(sender: { id: number }, requestingUrl: string): GeminiLiveDisplayMediaBinding {
  return {
    sourceId: null,
    allowsPermissionRequest: (webContents: { id: number }, permission: string, details: { isMainFrame: boolean; requestingUrl: string }) =>
      webContents.id === sender.id && permission === "media" && details.isMainFrame && details.requestingUrl === requestingUrl,
    allowsDisplayRequest: () => false,
  } as unknown as GeminiLiveDisplayMediaBinding;
}

for (const live of ["bound", "unbound"] as const) {
  for (const rendererOrigin of ["file://", "http://127.0.0.1:4143"]) {
    test(`permissions with Live ${live}, renderer ${rendererOrigin}: app context is denied, Aiden's own isn't`, () => {
      const s = setup({ rendererOrigin });
      const rendererUrl = rendererOrigin === "file://" ? "file:///app/build/renderer/index.html" : `${rendererOrigin}/`;
      const main = s.window().contents;
      if (live === "bound") {
        installGeminiLiveDisplayMediaGuards(s.permissionDispatcher.ownerSlot("gemini-live"), () => [liveBinding(main, rendererUrl)]);
      }
      s.admit();
      assert.equal(s.ask(main, "media", { requestingUrl: `${ORIGIN}/`, isMainFrame: false, mediaTypes: ["audio"] }), false);
      assert.equal(s.ask(main, "openExternal", { requestingUrl: `${ORIGIN}/`, isMainFrame: false }), false);
      assert.equal(s.check(main, "media", { requestingUrl: `${ORIGIN}/`, isMainFrame: false, securityOrigin: ORIGIN }), false);
      assert.equal(s.check(null, "background-sync", { requestingUrl: `${ORIGIN}/sw.js`, securityOrigin: ORIGIN, isMainFrame: false }), false, "a service worker's check");
      if (live === "bound") {
        assert.equal(s.ask(main, "media", { requestingUrl: rendererUrl, isMainFrame: true, mediaTypes: ["audio"] }), true, "Live's own microphone");
      } else {
        assert.equal(s.check(main, "clipboard-sanitized-write", { requestingUrl: rendererUrl, isMainFrame: true }), true, "Electron's default");
      }
    });
  }
}

test("an export window's requests are denied, and display and device requests from app context get nothing", () => {
  const s = setup();
  const app = s.admit();
  const exportContents = { id: 42 };
  const remove = s.network!.registry.addExportContents(42);
  assert.equal(s.ask(exportContents, "notifications", { requestingUrl: `${ORIGIN}/pricing`, isMainFrame: true }), false, "E6");
  assert.equal(s.ask(exportContents, "media", { requestingUrl: `${ORIGIN}/pricing`, isMainFrame: true }), false, "E6");
  remove();
  let streams: unknown = "unanswered";
  (s.permissions.state.display as unknown as (...args: unknown[]) => void)({ frame: app }, (value: unknown) => (streams = value));
  assert.deepEqual(streams, {});
  assert.equal((s.permissions.state.device as unknown as (details: unknown) => boolean)({ origin: ORIGIN, deviceType: "hid" }), false);
});

test("a request an export window starts is stamped on the registry, so its export can wait for quiet", () => {
  const s = setup();
  const remove = s.network!.registry.addExportContents(42);
  s.tick(250);
  s.request({ url: `${ORIGIN}/src/main.tsx`, webContentsId: 42, resourceType: "script" });
  assert.equal(s.network!.registry.lastExportRequest(42), 10_250);
  s.request({ url: `${ORIGIN}/x`, webContentsId: 43, resourceType: "script" });
  assert.equal(s.network!.registry.lastExportRequest(43), undefined, "another web contents isn't an export window");
  remove();
});

test("HID, serial and USB choosers cancel for app context and pass for the main frame", () => {
  const s = setup();
  const app = s.admit();
  for (const event of ["select-hid-device", "select-serial-port", "select-usb-device"]) {
    const outcome = (target: Frame) => {
      let prevented = false;
      let chosen: string | undefined;
      s.permissions.emitter.emit(event, { preventDefault: () => (prevented = true) }, { frame: target }, (id: string) => (chosen = id));
      return { prevented, chosen };
    };
    assert.deepEqual(outcome(app), { prevented: true, chosen: "" }, event);
    assert.deepEqual(outcome(s.window().main), { prevented: false, chosen: undefined }, event);
  }
});

// ---- Downloads (D8, E3) -------------------------------------------------------

test("downloads from an export window or an app-context frame are cancelled; the main frame's aren't", () => {
  const s = setup();
  const app = s.admit();
  s.network!.registry.addExportContents(42);
  const download = (contents: { id: number }, target: Frame | null) => {
    let prevented = false;
    let cancelled = false;
    s.permissions.emitter.emit("will-download", { preventDefault: () => (prevented = true) }, { cancel: () => (cancelled = true) }, contents, target);
    return prevented && cancelled;
  };
  assert.equal(download({ id: 42 }, null), true, "E3");
  assert.equal(download(s.window().contents, app), true);
  assert.equal(download(s.window().contents, s.window().main), false);
});

// ---- Window recreation (R7) and events ---------------------------------------------

test("after the main window is recreated, a frame admitted in the new window is filtered and denied, and events go to it", () => {
  const s = setup();
  s.admit(7, "f1");
  const first = s.window();
  s.replaceWindow(null);
  const second = mainWindow(2);
  s.replaceWindow(second);
  const app = s.admit(11, "f2");
  assert.equal(s.request({ url: "https://example.com/", frame: app, webContentsId: 2 }), "cancel");
  assert.equal(s.ask(second.contents, "media", { requestingUrl: `${ORIGIN}/`, isMainFrame: false }), false);
  s.flush();
  assert.equal(first.sent.length, 0, "the closed window gets nothing");
  assert.deepEqual(second.sent.map((event) => event.frameId), ["f2"]);
});

// ---- Service workers (S76) ---------------------------------------------------------

test("an admitted origin is remembered, forgetting a workspace clears its origins, and the startup clear runs first", async () => {
  const s = setup({ appForOrigin: (origin) => (origin === ORIGIN ? { workspaceId: "ws-1", appRoot: "." } : undefined) });
  s.admit();
  await s.network!.forgetWorkspace("ws-2");
  await s.network!.forgetWorkspace("ws-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(s.workers.calls, ["clear all", `remember ${ORIGIN}`, `clear ${ORIGIN}`]);
});

test("disposing removes every subscriber, so the session has no listener left", () => {
  const s = setup();
  s.network!.dispose();
  assert.equal(s.webRequest.target.before, null);
  assert.equal(s.webRequest.target.headers, null);
  assert.equal(s.permissions.state.check, null);
  assert.equal(s.permissions.emitter.listenerCount("will-download"), 0);
});

