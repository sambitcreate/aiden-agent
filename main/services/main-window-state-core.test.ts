import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_MAIN_WINDOW_SIZE,
  normalizeMainWindowState,
  restoredMainWindowBounds,
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
  const guards = [...create.matchAll(/if \(mainWindow && !mainWindow\.isDestroyed\(\)\)/gu)]
    .map((match) => match.index);

  assert.ok(restore >= 0 && construct > restore);
  assert.ok(guards.some((index) => index < restore));
  assert.ok(guards.some((index) => index > restore && index < construct));
  assert.match(
    create.slice(construct),
    /if \(restoredWindowState\.maximized\)[\s\S]*if \(restoredWindowState\.fullScreen\)/u,
  );
});
