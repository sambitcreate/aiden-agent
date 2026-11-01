// app:window:* against a small window double that keeps its own state: the
// window's resulting state is the oracle, not the calls made on it.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  registerWindowControlHandlers,
  trackWindowControlsState,
  WINDOW_CLOSE_CHANNEL,
  WINDOW_GET_STATE_CHANNEL,
  WINDOW_MINIMIZE_CHANNEL,
  WINDOW_SHOW_MENU_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
} from "./window-controls.js";

class FakeWindow extends EventEmitter {
  readonly webContents = { id: 7 };
  destroyed = false;
  maximized = false;
  minimized = false;
  fullScreen = false;
  closeRequests = 0;
  isDestroyed() { return this.destroyed; }
  isMaximized() { return this.maximized; }
  isFullScreen() { return this.fullScreen; }
  minimize() { this.minimized = true; this.emit("minimize"); }
  maximize() { this.maximized = true; this.emit("maximize"); }
  unmaximize() { this.maximized = false; this.emit("unmaximize"); }
  close() { this.closeRequests += 1; }
}

function setup(options: { menu?: boolean } = {}) {
  const window = new FakeWindow();
  const menus: Array<{ x: number; y: number }> = [];
  const handlers = new Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>();
  let current: FakeWindow | null = window;
  registerWindowControlHandlers<FakeWindow>({
    handle: (channel, handler) => handlers.set(channel, handler),
    mainWindow: () => current,
    popupMenu: (_window, point) => {
      if (options.menu === false) return false;
      menus.push(point);
      return true;
    },
  });
  const invoke = (senderId: number, channel: string, ...args: unknown[]) =>
    Promise.resolve(handlers.get(channel)!({ sender: { id: senderId } }, ...args));
  return { window, menus, invoke, closeWindow: () => { current = null; } };
}

test("the main window's document can minimize, maximize, restore and close it", async () => {
  const { window, invoke } = setup();
  assert.deepEqual(await invoke(7, WINDOW_GET_STATE_CHANNEL), { maximized: false, fullScreen: false });
  assert.deepEqual(await invoke(7, WINDOW_TOGGLE_MAXIMIZE_CHANNEL), { maximized: true, fullScreen: false });
  assert.equal(window.maximized, true);
  assert.deepEqual(await invoke(7, WINDOW_TOGGLE_MAXIMIZE_CHANNEL), { maximized: false, fullScreen: false });
  assert.equal(window.maximized, false);
  assert.equal(await invoke(7, WINDOW_MINIMIZE_CHANNEL), true);
  assert.equal(window.minimized, true);
  assert.equal(await invoke(7, WINDOW_CLOSE_CHANNEL), true);
  assert.equal(window.closeRequests, 1, "close is a request the window's guarded close handler can refuse");
});

test("other documents cannot drive the main window", async () => {
  const { window, invoke, menus } = setup();
  assert.equal(await invoke(99, WINDOW_GET_STATE_CHANNEL), null);
  assert.equal(await invoke(99, WINDOW_TOGGLE_MAXIMIZE_CHANNEL), null);
  assert.equal(await invoke(99, WINDOW_MINIMIZE_CHANNEL), false);
  assert.equal(await invoke(99, WINDOW_CLOSE_CHANNEL), false);
  assert.equal(await invoke(99, WINDOW_SHOW_MENU_CHANNEL, { x: 10, y: 10 }), false);
  assert.deepEqual(
    { maximized: window.maximized, minimized: window.minimized, closeRequests: window.closeRequests, menus: menus.length },
    { maximized: false, minimized: false, closeRequests: 0, menus: 0 },
  );
});

test("a destroyed or missing main window ignores requests", async () => {
  const destroyed = setup();
  destroyed.window.destroyed = true;
  assert.equal(await destroyed.invoke(7, WINDOW_MINIMIZE_CHANNEL), false);
  assert.equal(destroyed.window.minimized, false);
  const missing = setup();
  missing.closeWindow();
  assert.equal(await missing.invoke(7, WINDOW_CLOSE_CHANNEL), false);
});

test("maximize does nothing in full screen", async () => {
  const { window, invoke } = setup();
  window.fullScreen = true;
  assert.equal(await invoke(7, WINDOW_TOGGLE_MAXIMIZE_CHANNEL), null);
  assert.equal(window.maximized, false);
});

test("the main menu opens at a whole-pixel point inside the window", async () => {
  const { invoke, menus } = setup();
  assert.equal(await invoke(7, WINDOW_SHOW_MENU_CHANNEL, { x: 12.4, y: 44.6 }), true);
  assert.deepEqual(menus, [{ x: 12, y: 45 }]);
  for (const bad of [null, { x: -1, y: 4 }, { x: Number.NaN, y: 4 }, { x: "1", y: 4 }, { x: 1 }, { x: 1, y: 1e9 }]) {
    assert.equal(await invoke(7, WINDOW_SHOW_MENU_CHANNEL, bad), false, JSON.stringify(bad));
  }
  assert.equal(menus.length, 1);
  assert.equal(await setup({ menu: false }).invoke(7, WINDOW_SHOW_MENU_CHANNEL, { x: 1, y: 1 }), false);
});

test("state changes reach the document once each, and stop when tracking stops", () => {
  const window = new FakeWindow();
  const sent: unknown[] = [];
  const stop = trackWindowControlsState(window, (state) => sent.push(state));
  window.maximize();
  window.emit("resize");
  window.fullScreen = true;
  window.emit("enter-full-screen");
  window.fullScreen = false;
  window.emit("leave-full-screen");
  window.unmaximize();
  assert.deepEqual(sent, [
    { maximized: true, fullScreen: false },
    { maximized: true, fullScreen: true },
    { maximized: true, fullScreen: false },
    { maximized: false, fullScreen: false },
  ]);
  stop();
  window.maximize();
  assert.equal(sent.length, 4);
});
