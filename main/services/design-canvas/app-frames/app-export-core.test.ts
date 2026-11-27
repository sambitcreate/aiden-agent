// What a live app frame's Download decides (design mode v2 Phase 3a, D18,
// S73): the export window's options and navigation rules, its registration
// as an export window, and when the app has settled.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Window } from "happy-dom";

import {
  APP_EXPORT_DARK_SCRIPT,
  appExportPixels,
  appExportWindowOptions,
  guardAppExportContents,
  waitForQuietNetwork,
  withAppExportRegistration,
} from "./app-export-core.ts";
import { AppFrameRegistry } from "./app-frame-registry.ts";

const ORIGIN = "http://127.0.0.1:5173";

test("the export window is hidden, sandboxed, dialog-free, preload-free, at zoom 1, on the default session", () => {
  const options = appExportWindowOptions({ width: 1280, height: 800 });
  assert.equal(options.show, false);
  assert.deepEqual({ width: options.width, height: options.height }, { width: 1280, height: 800 });
  const web = options.webPreferences as Record<string, unknown>;
  assert.equal(web.sandbox, true);
  assert.equal(web.contextIsolation, true);
  assert.equal(web.nodeIntegration, false);
  assert.equal(web.disableDialogs, true);
  assert.equal(web.zoomFactor, 1);
  for (const key of ["preload", "session", "partition"]) assert.equal(key in web, false, `no ${key}: the default session, nothing injected`);
});

test("a PNG is the viewport's width by the page's height, at 1×, never shorter than the viewport", () => {
  assert.deepEqual(appExportPixels({ width: 1280, height: 800 }, 2400.2, 16_000), { width: 1280, height: 2401 });
  assert.deepEqual(appExportPixels({ width: 1280, height: 800 }, 300, 16_000), { width: 1280, height: 800 });
  assert.deepEqual(appExportPixels({ width: 390, height: 844 }, 90_000, 16_000), { width: 390, height: 16_000 });
  assert.deepEqual(appExportPixels({ width: 390, height: 844 }, Number.NaN, 16_000), { width: 390, height: 844 });
});

function fakeContents() {
  const emitter = new EventEmitter();
  const zooms: number[] = [];
  let openHandler: (() => unknown) | undefined;
  let policy: string | undefined;
  const contents = Object.assign(emitter, {
    setZoomFactor: (factor: number) => zooms.push(factor),
    setWindowOpenHandler: (handler: () => unknown) => (openHandler = handler),
    setWebRTCIPHandlingPolicy: (value: string) => (policy = value),
  });
  const navigate = (event: string, url: string, isMainFrame = true) => {
    let prevented = false;
    emitter.emit(event, { url, isMainFrame, preventDefault: () => (prevented = true) });
    return prevented ? "prevented" : "allowed";
  };
  return { contents, zooms, navigate, openHandler: () => openHandler?.(), policy: () => policy };
}

test("the export window sets zoom 1 on each commit, opens nothing and goes nowhere but its app", () => {
  const f = fakeContents();
  const guard = guardAppExportContents(f.contents as never, ORIGIN);
  assert.equal(f.policy(), "disable_non_proxied_udp");
  assert.deepEqual(f.openHandler(), { action: "deny" });
  f.contents.emit("did-navigate");
  f.contents.emit("did-navigate");
  assert.deepEqual(f.zooms, [1, 1]);

  assert.equal(f.navigate("will-frame-navigate", `${ORIGIN}/pricing`), "allowed", "the first load of the app");
  assert.equal(f.navigate("will-frame-navigate", "https://example.com/"), "prevented");
  assert.equal(f.navigate("will-frame-navigate", `${ORIGIN}/embed`, false), "prevented", "frames inside the app draw empty");
  assert.equal(f.navigate("will-redirect", `${ORIGIN}/pricing/`), "allowed", "a redirect within the app");
  assert.equal(f.navigate("will-redirect", "http://127.0.0.1:6006/"), "prevented");
  assert.equal(f.navigate("will-redirect", `${ORIGIN}/x`, false), "prevented");
  assert.equal(f.navigate("will-navigate", `${ORIGIN}/other`), "prevented", "the page navigates nowhere itself");
  guard.markLoaded();
  assert.equal(f.navigate("will-frame-navigate", `${ORIGIN}/again`), "prevented", "after the load, nothing more");
});

test("the export window answers a Bluetooth chooser with no device, so Electron never picks the first one", () => {
  const f = fakeContents();
  guardAppExportContents(f.contents as never, ORIGIN);
  let prevented = false;
  let chosen: string | undefined;
  f.contents.emit("select-bluetooth-device", { preventDefault: () => (prevented = true) }, [{ deviceId: "d1", deviceName: "Keyboard" }], (id: string) => (chosen = id));
  assert.equal(prevented, true);
  assert.equal(chosen, "");
});

test("the export window is registered for the render's life and unregistered on success, failure and timeout", async () => {
  const registry = new AppFrameRegistry({ mainContents: () => ({}), liveIds: () => new Set() });
  const seen: boolean[] = [];
  assert.equal(
    await withAppExportRegistration(registry, 9, async () => {
      seen.push(registry.isExportContents(9));
      return "drawn";
    }),
    "drawn",
  );
  assert.equal(registry.isExportContents(9), false);
  await assert.rejects(
    withAppExportRegistration(registry, 9, async () => {
      seen.push(registry.isExportContents(9));
      throw new Error("crashed");
    }),
    /crashed/u,
  );
  assert.equal(registry.isExportContents(9), false);
  let fire: (() => void) | undefined;
  let cancelled = 0;
  const pending = withAppExportRegistration(registry, 9, () => new Promise<never>(() => undefined), {
    schedule: (callback) => {
      fire = callback;
      return { cancel: () => (cancelled += 1) };
    },
  });
  seen.push(registry.isExportContents(9));
  fire!();
  await assert.rejects(pending, /too long/u);
  assert.equal(registry.isExportContents(9), false);
  assert.deepEqual(seen, [true, true, true]);
  assert.equal(cancelled, 1);
  await assert.rejects(withAppExportRegistration(null, 9, async () => "drawn"), /network policy/u);
});

test("the app has settled after 500 ms with no request started, or at the 15 s cap", async () => {
  let clock = 0;
  const sleep = async (ms: number) => {
    clock += ms;
  };
  let last: number | undefined;
  assert.equal(await waitForQuietNetwork({ lastRequestAt: () => last, now: () => clock, sleep }), "quiet");
  assert.equal(clock, 500, "no request at all: quiet after 500 ms");

  clock = 0;
  const requests = [100, 450, 900];
  const busy = async (ms: number) => {
    clock += ms;
    while (requests.length > 0 && requests[0]! <= clock) last = requests.shift();
  };
  last = undefined;
  assert.equal(await waitForQuietNetwork({ lastRequestAt: () => last, now: () => clock, sleep: busy, startedAt: 0 }), "quiet");
  assert.equal(clock, 1_400, "500 ms after the last request, at 900");

  clock = 0;
  const chatty = async (ms: number) => {
    clock += ms;
    last = clock;
  };
  assert.equal(await waitForQuietNetwork({ lastRequestAt: () => last, now: () => clock, sleep: chatty, startedAt: 0 }), "cap");
  assert.ok(clock >= 15_000 && clock < 15_600);
});

test("the dark script sets the same three things the bridge's Dark switch does", () => {
  const window = new Window({ url: `${ORIGIN}/` });
  new Function("document", APP_EXPORT_DARK_SCRIPT)(window.document);
  const root = window.document.documentElement;
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(root.getAttribute("data-theme"), "dark");
  assert.ok(root.classList.contains("dark"));
});
