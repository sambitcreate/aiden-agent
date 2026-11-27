// The main window's console listener (design mode v2 Phase 3a, D10, S61):
// Gemini Live markers only from the main frame, and sandboxed-dialog notices
// from app frames counted for the canvas, display-only.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { DesignAppFrameEvent } from "../../renderer/shared/design-canvas/app-frame-events.ts";
import { AppFrameRegistry } from "../services/design-canvas/app-frames/app-frame-registry.ts";
import { installMainWindowConsole } from "./main-window-console.ts";

const ORIGIN = "http://127.0.0.1:5173";
const TOKEN = "abcdefghijklmnop";
const DIALOG = "Ignored call to 'alert()'. The document is sandboxed, and the 'allow-modals' keyword is not set.";

type Frame = { frameTreeNodeId: number; parent: Frame | null; url: string; origin: string; name: string };

function setup(options: { designLive?: boolean } = {}) {
  const main: Frame = { frameTreeNodeId: 1, parent: null, url: "file:///app/index.html", origin: "file://", name: "" };
  const emitter = new EventEmitter();
  const contents = Object.assign(emitter, { mainFrame: main });
  let clock = 1_000;
  const registry = new AppFrameRegistry({ mainContents: () => contents, liveIds: () => new Set([1, 7, 8, 9]), now: () => clock });
  const events: DesignAppFrameEvent[] = [];
  registry.onEvent((event) => events.push(event));
  const app: Frame = { frameTreeNodeId: 7, parent: main, url: "about:blank", origin: "null", name: `aiden-app:f1:${TOKEN}` };
  registry.expectPlacement({ frameId: "f1", mountToken: TOKEN, expectedOrigin: ORIGIN });
  assert.equal(registry.admit({ frame: app, targetUrl: `${ORIGIN}/`, isDirectChild: true, initiator: "main-frame", designFrame: false }), "app");
  app.url = `${ORIGIN}/`;
  app.origin = ORIGIN;
  const markers: string[] = [];
  const remove = installMainWindowConsole(contents, {
    liveMarker: (message) => markers.push(message),
    designLive: options.designLive ?? true,
    registry: () => registry,
    now: () => clock,
  });
  const log = (message: string, frame: Frame | null) => emitter.emit("console-message", { message, frame });
  const nested: Frame = { frameTreeNodeId: 8, parent: app, url: `${ORIGIN}/inner`, origin: ORIGIN, name: "" };
  const genui: Frame = { frameTreeNodeId: 9, parent: main, url: "aiden-genui://card/", origin: "null", name: "" };
  return { main, app, nested, genui, log, markers, events, remove, emitter, tick: (ms: number) => (clock += ms) };
}

test("a Live marker from the main frame is forwarded; the same text from a subframe isn't and doesn't spend the budget", () => {
  const s = setup();
  for (let index = 0; index < 250; index++) s.log("[aiden-live] microphone-ready", s.app);
  assert.deepEqual(s.markers, []);
  s.log("[aiden-live] microphone-ready", s.main);
  s.log("[aiden-live] something-else", s.main);
  s.log("hello from the renderer", s.main);
  assert.deepEqual(s.markers, ["[aiden-live] microphone-ready"]);
  for (let index = 0; index < 250; index++) s.log("[aiden-live] playback-started", s.main);
  assert.equal(s.markers.length, 200, "at most 200 per window");
});

test("a sandboxed-dialog notice from an app frame sends one dialog-suppressed per kind per 5 s", () => {
  const s = setup();
  s.log(DIALOG, s.app);
  s.log(DIALOG, s.nested);
  s.log("Ignored call to 'print()'. The document is sandboxed, and the 'allow-modals' keyword is not set.", s.app);
  assert.deepEqual(s.events, [
    { kind: "dialog-suppressed", frameId: "f1", mountToken: TOKEN, dialog: "alert" },
    { kind: "dialog-suppressed", frameId: "f1", mountToken: TOKEN, dialog: "print" },
  ]);
  s.tick(5_001);
  s.log(DIALOG, s.nested);
  assert.equal(s.events.length, 3);
});

test("the same notice from a non-app frame, or with live apps off, sends nothing", () => {
  const s = setup();
  s.log(DIALOG, s.genui);
  s.log(DIALOG, s.main);
  assert.deepEqual(s.events, []);
  const off = setup({ designLive: false });
  off.log(DIALOG, off.app);
  assert.deepEqual(off.events, []);
});

test("removing the listener stops forwarding", () => {
  const s = setup();
  s.remove();
  s.log("[aiden-live] microphone-ready", s.main);
  assert.deepEqual(s.markers, []);
  assert.equal(s.emitter.listenerCount("console-message"), 0);
});
