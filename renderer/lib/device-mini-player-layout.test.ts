import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DEVICE_MINI_PLAYER_GEOMETRY,
  DEVICE_MINI_PLAYER_CHROME_HEIGHT,
  DEVICE_MINI_PLAYER_GAP,
  deviceMiniPlayerFrame,
  deviceMiniPlayerGeometry,
  deviceMiniPlayerSource,
  keyboardDeviceMiniPlayer,
  moveDeviceMiniPlayer,
  parseDeviceMiniPlayerGeometry,
  resizeDeviceMiniPlayer,
  serializeDeviceMiniPlayerGeometry,
  snapDeviceMiniPlayer,
  type DeviceMiniPlayerFrame,
} from "./device-mini-player-layout.js";
import { createDeviceWorkspaceStore } from "./device-workspace-store.js";

const CHAT = { width: 1200, height: 1000 };
const PHONE = deviceMiniPlayerSource("iphone", { width: 1206, height: 2622 });
const GAP = DEVICE_MINI_PLAYER_GAP;

function inside(frame: DeviceMiniPlayerFrame, container: { width: number; height: number }) {
  assert.ok(frame.x >= GAP && frame.y >= GAP, `frame ${JSON.stringify(frame)} starts inside the gap`);
  assert.ok(frame.x + frame.width <= container.width - GAP + 0.5, "right edge stays inside");
  assert.ok(frame.y + frame.height <= container.height - GAP + 0.5, "bottom edge stays inside");
}

const screenAspect = (frame: DeviceMiniPlayerFrame) => frame.width / (frame.height - DEVICE_MINI_PLAYER_CHROME_HEIGHT);

test("a fresh player sits in the top-right of the chat at the screen's shape", () => {
  const frame = deviceMiniPlayerFrame({ source: PHONE, container: CHAT, geometry: DEFAULT_DEVICE_MINI_PLAYER_GEOMETRY });
  inside(frame, CHAT);
  assert.equal(frame.y, GAP);
  assert.equal(frame.x + frame.width, CHAT.width - GAP);
  assert.ok(Math.abs(screenAspect(frame) - 1206 / 2622) < 0.02);
});

test("before the first frame an iPad floats as an iPad and a phone as a phone", () => {
  const ipad = deviceMiniPlayerSource("ipad", null);
  const phone = deviceMiniPlayerSource("iphone", null);
  assert.ok(ipad.width / ipad.height > phone.width / phone.height);
  // A rotated stream reports a landscape screen, so the player turns with it.
  const landscape = deviceMiniPlayerSource("iphone", { width: 2622, height: 1206 });
  assert.ok(landscape.width > landscape.height);
});

test("dragging clamps to the chat area, and a release near an edge snaps to the corner", () => {
  const start = deviceMiniPlayerFrame({ source: PHONE, container: CHAT, geometry: DEFAULT_DEVICE_MINI_PLAYER_GEOMETRY });
  const dragged = moveDeviceMiniPlayer({ start, delta: { x: -5_000, y: 5_000 }, source: PHONE, container: CHAT });
  inside(dragged, CHAT);
  assert.equal(dragged.x, GAP);
  assert.equal(dragged.y, CHAT.height - dragged.height - GAP);

  // Released 30px from the left and 20px above the bottom corner: it lands in the corner.
  const near = { ...dragged, x: GAP + 30, y: CHAT.height - dragged.height - GAP - 20 };
  const snapped = snapDeviceMiniPlayer(near, CHAT);
  assert.deepEqual({ x: snapped.x, y: snapped.y }, { x: GAP, y: CHAT.height - dragged.height - GAP });

  // Released mid-chat it stays exactly where it was dropped.
  const middle = { ...dragged, x: 300, y: 120 };
  assert.deepEqual(snapDeviceMiniPlayer(middle, CHAT), middle);

  // Near only the top edge, it slides flush to that edge and keeps its column.
  const top = snapDeviceMiniPlayer({ ...dragged, x: 300, y: GAP + 10 }, CHAT);
  assert.deepEqual({ x: top.x, y: top.y }, { x: 300, y: GAP });
});

test("resizing keeps the screen's aspect ratio, anchors the opposite corner, and stops at the chat", () => {
  const start = deviceMiniPlayerFrame({ source: PHONE, container: CHAT, geometry: { width: 240, position: { x: 400, y: 40 } } });
  const grown = resizeDeviceMiniPlayer({ start, edge: "southwest", delta: { x: -60, y: 0 }, source: PHONE, container: CHAT });
  assert.ok(grown.width > start.width);
  assert.equal(grown.x + grown.width, start.x + start.width);
  assert.equal(grown.y, start.y);
  assert.ok(Math.abs(screenAspect(grown) - screenAspect(start)) < 0.02);
  const huge = resizeDeviceMiniPlayer({ start, edge: "southeast", delta: { x: 5_000, y: 5_000 }, source: PHONE, container: CHAT });
  inside(huge, CHAT);
});

test("a stored size and position are re-fitted to a smaller window without being lost", () => {
  const geometry = { width: 320, position: { x: 560, y: 300 } };
  const small = { width: 420, height: 380 };
  const fitted = deviceMiniPlayerFrame({ source: PHONE, container: small, geometry });
  inside(fitted, small);
  assert.ok(fitted.width < 320);
  // Back in the full chat area the original choice applies again.
  const restored = deviceMiniPlayerFrame({ source: PHONE, container: { width: 1400, height: 1400 }, geometry });
  assert.equal(restored.width, 320);
  assert.deepEqual({ x: restored.x, y: restored.y }, geometry.position);
});

test("keyboard: arrows move, Shift moves further, plus and minus resize, other keys pass through", () => {
  const frame = deviceMiniPlayerFrame({ source: PHONE, container: CHAT, geometry: { width: 260, position: { x: 300, y: 100 } } });
  const key = (name: string, shiftKey = false) =>
    keyboardDeviceMiniPlayer({ key: name, shiftKey, frame, source: PHONE, container: CHAT });
  assert.equal(key("ArrowLeft")!.x, frame.x - 16);
  assert.equal(key("ArrowDown", true)!.y, frame.y + 48);
  assert.ok(key("+")!.width > frame.width);
  assert.ok(key("-")!.width < frame.width);
  assert.equal(key("a"), null);
  assert.equal(key("Escape"), null);
});

test("size and position persist for the window and reject damaged values", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  const store = createDeviceWorkspaceStore(storage);
  assert.deepEqual(store.geometry(), DEFAULT_DEVICE_MINI_PLAYER_GEOMETRY);
  const frame = deviceMiniPlayerFrame({ source: PHONE, container: CHAT, geometry: { width: 250.4, position: { x: 33.6, y: 20.2 } } });
  store.setGeometry(deviceMiniPlayerGeometry(frame));
  assert.deepEqual(createDeviceWorkspaceStore(storage).geometry(), { width: 250, position: { x: 34, y: 20 } });

  assert.deepEqual(parseDeviceMiniPlayerGeometry("{"), DEFAULT_DEVICE_MINI_PLAYER_GEOMETRY);
  assert.deepEqual(
    parseDeviceMiniPlayerGeometry(JSON.stringify({ version: 1, width: -4, position: { x: "1", y: 2 } })),
    DEFAULT_DEVICE_MINI_PLAYER_GEOMETRY,
  );
  assert.deepEqual(
    parseDeviceMiniPlayerGeometry(serializeDeviceMiniPlayerGeometry({ width: 300, position: null })),
    { width: 300, position: null },
  );
});
