import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { EventEmitter } from "node:events";

import {
  DEFAULT_MAIN_WINDOW_SIZE,
  normalizeMainWindowState,
  restoredMainWindowBounds,
  trackMainWindowState,
} from "./main-window-state-core.js";

test("fresh windows use the larger default and center in the primary work area", () => {
  assert.deepEqual(
    restoredMainWindowBounds(undefined, [{ x: 0, y: 25, width: 1_440, height: 875 }]),
    { x: 80, y: 63, ...DEFAULT_MAIN_WINDOW_SIZE },
  );
});

test("saved normal bounds and presentation state survive normalization", () => {
  assert.deepEqual(
    normalizeMainWindowState({
      version: 1,
      bounds: { x: 100.4, y: 80.6, width: 1_200.2, height: 760.8 },
      maximized: true,
      fullScreen: false,
    }),
    {
      version: 1,
      bounds: { x: 100, y: 81, width: 1_200, height: 761 },
      maximized: true,
      fullScreen: false,
    },
  );
});

test("restoration clamps a removed-monitor window onto the primary display", () => {
  assert.deepEqual(
    restoredMainWindowBounds({ x: 3_000, y: 200, width: 1_600, height: 1_000 }, [
      { x: 0, y: 25, width: 1_440, height: 875 },
    ]),
    { x: 0, y: 25, width: 1_440, height: 875 },
  );
});

test("restoration keeps a saved window on the display where it overlaps most", () => {
  assert.deepEqual(
    restoredMainWindowBounds({ x: 1_700, y: 120, width: 1_100, height: 700 }, [
      { x: 0, y: 25, width: 1_440, height: 875 },
      { x: 1_440, y: 0, width: 1_920, height: 1_080 },
    ]),
    { x: 1_700, y: 120, width: 1_100, height: 700 },
  );
});

test("window creation rechecks the singleton after asynchronous state restoration", async () => {
  const source = await fs.readFile(new URL("../index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function createMainWindow");
  const end = source.indexOf("app.whenReady()", start);
  const create = source.slice(start, end);
  const restore = create.indexOf("await mainWindowState.restore");
  const construct = create.indexOf("new BrowserWindow");
  const guards = [...create.matchAll(/if \(mainWindow && !mainWindow\.isDestroyed\(\)\)/gu)].map(
    (match) => match.index,
  );

  assert.ok(restore >= 0 && construct > restore);
  assert.ok(create.indexOf("mainWindowState.track(createdWindow)") > construct);
  assert.ok(
    create.indexOf("mainWindowState.track(createdWindow)") <
      create.indexOf('createdWindow.once("ready-to-show"'),
  );
  assert.ok(guards.some((index) => index < restore));
  assert.ok(guards.some((index) => index > restore && index < construct));
  assert.match(
    create.slice(construct),
    /if \(restoredWindowState\.maximized\)[\s\S]*if \(restoredWindowState\.fullScreen\)/u,
  );
});

class NativeWindowState extends EventEmitter {
  bounds = { x: -1_200, y: 80, width: 900, height: 650 };
  minimized = false;
  maximized = false;
  fullScreen = false;
  getNormalBounds() {
    return { ...this.bounds };
  }
  isMinimized() {
    return this.minimized;
  }
  isMaximized() {
    return this.maximized;
  }
  isFullScreen() {
    return this.fullScreen;
  }
}

test("minimized maximized windows retain normal bounds even after native restore", () => {
  const window = new NativeWindowState();
  const snapshot = trackMainWindowState(window);
  const normal = { ...window.bounds };
  // macOS emits intermediate normal rectangles during the maximize animation.
  window.bounds = { x: -1_300, y: 50, width: 1_100, height: 750 };
  window.emit("resize");
  window.bounds = normal;
  window.maximized = true;
  window.emit("maximize");
  window.minimized = true;
  window.maximized = false;
  window.bounds = { x: -1_440, y: 25, width: 1_440, height: 875 };
  window.emit("resize");
  window.emit("minimize");
  assert.deepEqual(snapshot(), { version: 1, bounds: normal, maximized: true, fullScreen: false });
  window.minimized = false;
  window.maximized = true;
  window.emit("restore");
  assert.deepEqual(snapshot().bounds, normal);
  assert.equal(snapshot().maximized, true);
  window.maximized = false;
  window.bounds = normal;
  window.emit("unmaximize");
  window.bounds = { x: 140, y: 120, width: 950, height: 700 };
  window.emit("move");
  window.emit("resize");
  assert.deepEqual(snapshot(), {
    version: 1,
    bounds: window.bounds,
    maximized: false,
    fullScreen: false,
  });
});

test("normal and fullscreen minimize snapshots are isolated to each window", () => {
  const first = new NativeWindowState();
  const firstSnapshot = trackMainWindowState(first);
  first.bounds = { x: -900, y: 120, width: 800, height: 600 };
  first.emit("move");
  const normal = firstSnapshot();
  first.minimized = true;
  first.bounds = { x: 0, y: 0, width: 1_920, height: 1_080 };
  assert.deepEqual(firstSnapshot(), normal);
  first.minimized = false;
  first.bounds = normal.bounds!;
  first.fullScreen = true;
  first.emit("enter-full-screen");
  first.minimized = true;
  first.fullScreen = false;
  assert.deepEqual(firstSnapshot(), { ...normal, fullScreen: true });
  first.minimized = false;
  first.emit("leave-full-screen");
  assert.equal(firstSnapshot().fullScreen, false);
  first.emit("closed");
  assert.equal(first.eventNames().length, 0);
  const replacement = new NativeWindowState();
  assert.deepEqual(trackMainWindowState(replacement)(), {
    version: 1,
    bounds: replacement.bounds,
    maximized: false,
    fullScreen: false,
  });
});

test("tracked negative monitor coordinates retain existing disconnected-display clamping", () => {
  const window = new NativeWindowState();
  const snapshot = trackMainWindowState(window);
  window.maximized = true;
  window.emit("maximize");
  window.minimized = true;
  window.maximized = false;
  const state = normalizeMainWindowState(JSON.parse(JSON.stringify(snapshot())));
  assert.deepEqual(
    restoredMainWindowBounds(state.bounds, [{ x: 0, y: 25, width: 1_440, height: 875 }]),
    { x: 0, y: 80, width: 900, height: 650 },
  );
  assert.equal(state.maximized, true);
});

test("fullscreen restore keeps normal bounds after the native minimized flag clears", () => {
  const window = new NativeWindowState();
  const snapshot = trackMainWindowState(window);
  const normal = { ...window.bounds };
  window.fullScreen = true;
  window.emit("enter-full-screen");
  window.minimized = true;
  window.bounds = { x: 0, y: 0, width: 1_920, height: 1_080 };
  window.emit("minimize");
  window.minimized = false;
  // A restore event can clear minimized while fullscreen remains active.
  // Preserve the cached normal bounds if the getter reports presentation bounds.
  window.emit("restore");
  assert.deepEqual(snapshot(), {
    version: 1,
    bounds: normal,
    maximized: false,
    fullScreen: true,
  });
  window.fullScreen = false;
  window.bounds = normal;
  window.emit("leave-full-screen");
  window.bounds = { x: 140, y: 120, width: 950, height: 700 };
  window.emit("resize");
  assert.deepEqual(snapshot(), {
    version: 1,
    bounds: window.bounds,
    maximized: false,
    fullScreen: false,
  });
});
