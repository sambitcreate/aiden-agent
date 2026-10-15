import assert from "node:assert/strict";
import test from "node:test";
import { BoxGeometry, PerspectiveCamera, Texture } from "three";
import {
  DEVICE_FRAME_PREFERENCE_KEY,
  frameBlocker,
  frameBlockerLabel,
  readFramePreference,
  writeFramePreference,
} from "./frame-mode.js";
import { createPhoneInteraction, createRenderScheduler, phoneWheelNavigation } from "./interaction.js";
import { createPhoneScene, phoneDisplayLayout, SCREEN_HEIGHT, updateDisplayUv } from "./phone-scene.js";
import {
  ANDROID_PHONE_SHAPE,
  ANDROID_TABLET_SHAPE,
  IOS_PHONE_SHAPE,
  IOS_TABLET_SHAPE,
  resolveDeviceShape,
} from "./shape-profile.js";
import {
  bindPhoneTrackpad,
  TRACKPAD_ORBIT_FALLBACK_MS,
  TRACKPAD_PINCH_IDLE_MS,
  type TrackpadTimers,
} from "./trackpad.js";

/** The newest entry. Equivalent to `.at(-1)`, which the ES2021 lib lacks. */
const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

const close = (actual: number, expected: number, epsilon = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);

test("the display layout keeps a portrait aspect and maps each orientation to a rotation", () => {
  const portrait = phoneDisplayLayout({ width: 1179, height: 2556, orientation: "portrait" }, 1179, 2556);
  close(portrait.aspect, 1179 / 2556);
  assert.equal(portrait.rotation, 0);
  assert.equal(portrait.landscape, false);
  assert.equal(portrait.rawLandscape, false);

  const left = phoneDisplayLayout({ width: 2556, height: 1179, orientation: "landscape_left" }, 2556, 1179);
  close(left.aspect, 1179 / 2556);
  assert.equal(left.rotation, -Math.PI / 2);
  assert.equal(left.landscape, true);
  assert.equal(left.rawLandscape, true);
  assert.equal(phoneDisplayLayout({ width: 1, height: 2, orientation: "landscape_right" }, 0, 0).rotation, Math.PI / 2);
  assert.equal(
    phoneDisplayLayout({ width: 1, height: 2, orientation: "portrait_upside_down" }, 0, 0).rotation,
    Math.PI,
  );
  // Before the first frame, a missing screen still yields a phone-shaped display.
  const fallback = phoneDisplayLayout(null, 0, 0);
  assert.ok(fallback.aspect > 0.4 && fallback.aspect < 0.5);
});

test("texture coordinates follow the raw framebuffer in every orientation", () => {
  const uvAt = (layout: ReturnType<typeof phoneDisplayLayout>) => {
    const geometry = new BoxGeometry(1, 2, 0);
    updateDisplayUv(geometry, 1, 2, layout);
    const position = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    for (let index = 0; index < position.count; index += 1) {
      if (position.getX(index) === -0.5 && position.getY(index) === 1) return [uv.getX(index), uv.getY(index)];
    }
    throw new Error("no top-left vertex");
  };
  assert.deepEqual(uvAt(phoneDisplayLayout({ width: 1, height: 2, orientation: "portrait" }, 1, 2)), [0, 1]);
  // Raw landscape buffers are rotated into the portrait body.
  assert.deepEqual(uvAt(phoneDisplayLayout({ width: 2, height: 1, orientation: "landscape_left" }, 2, 1)), [1, 1]);
  assert.deepEqual(uvAt(phoneDisplayLayout({ width: 2, height: 1, orientation: "landscape_right" }, 2, 1)), [0, 0]);
});

function sceneAndCamera(orientation: "portrait" | "landscape_left" | "landscape_right" | "portrait_upside_down") {
  const raw = orientation.startsWith("landscape") ? [2556, 1179] : [1179, 2556];
  const layout = phoneDisplayLayout({ width: raw[0], height: raw[1], orientation }, raw[0], raw[1]);
  const phone = createPhoneScene(new Texture(), layout, IOS_PHONE_SHAPE);
  phone.orientation.rotation.z = layout.rotation;
  const camera = new PerspectiveCamera(32, 1, 0.1, 30);
  camera.position.set(0, 0, 8);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  phone.root.updateMatrixWorld(true);
  return { phone, camera };
}

test("a touch on the display maps to the device point, and the bezel and background miss", () => {
  const { phone, camera } = sceneAndCamera("portrait");
  const centre = phone.screenPoint(0.5, 0.5, camera);
  assert.ok(centre);
  close(centre.x, 0.5, 1e-3);
  close(centre.y, 0.5, 1e-3);
  // Up the viewport is up the device.
  const upper = phone.screenPoint(0.5, 0.4, camera);
  assert.ok(upper && upper.y < 0.5);
  assert.equal(phone.screenPoint(0.02, 0.02, camera), null);
  // A captured drag that leaves the display clamps to its edge instead of ending.
  const captured = phone.screenPoint(0.02, 0.5, camera, true);
  assert.ok(captured);
  assert.equal(captured.x, 0);
  phone.dispose();
});

test("touches land in the frame the viewer sees, whichever way the display is turned", () => {
  for (const orientation of ["portrait", "portrait_upside_down", "landscape_left", "landscape_right"] as const) {
    const { phone, camera } = sceneAndCamera(orientation);
    const up = phone.screenPoint(0.5, 0.45, camera);
    const right = phone.screenPoint(0.55, 0.5, camera);
    assert.ok(up && up.y < 0.5 && Math.abs(up.x - 0.5) < 1e-3, `${orientation} up: ${JSON.stringify(up)}`);
    assert.ok(right && right.x > 0.5 && Math.abs(right.y - 0.5) < 1e-3, `${orientation} right: ${JSON.stringify(right)}`);
    phone.dispose();
  }
});

test("the render scheduler coalesces invalidations and stops when disposed", () => {
  const callbacks: FrameRequestCallback[] = [];
  const cancelled: number[] = [];
  let renders = 0;
  const scheduler = createRenderScheduler(
    () => (renders += 1),
    (callback) => callbacks.push(callback),
    (id) => cancelled.push(id),
  );
  scheduler.invalidate();
  scheduler.invalidate();
  assert.equal(callbacks.length, 1);
  callbacks[0]!(0);
  assert.equal(renders, 1);
  scheduler.invalidate();
  assert.equal(callbacks.length, 2);
  scheduler.dispose();
  assert.deepEqual(cancelled, [2]);
  callbacks[1]!(0);
  scheduler.invalidate();
  assert.equal(renders, 1);
  assert.equal(callbacks.length, 2);
});

// Adapted from t3code phoneInteraction.test.ts @ a6ec88f7 (MIT).
test("wheel navigation normalizes units, bounds coarse jumps, and turns Ctrl-wheel into a log zoom", () => {
  const wheelInput = { width: 400, height: 800, deltaX: 16, deltaY: 32, deltaMode: 0, ctrlKey: false };
  assert.deepEqual(phoneWheelNavigation(wheelInput), { type: "orbit", x: -0.04, y: -0.04 });
  // Line mode is 16 px per line, so the same swipe in lines turns the same amount.
  assert.deepEqual(
    phoneWheelNavigation({ ...wheelInput, deltaX: 1, deltaY: 2, deltaMode: 1 }),
    phoneWheelNavigation(wheelInput),
  );
  assert.deepEqual(phoneWheelNavigation({ ...wheelInput, deltaX: 1, deltaY: 1, deltaMode: 2 }), {
    type: "orbit",
    x: -0.25,
    y: -0.25,
  });
  assert.deepEqual(phoneWheelNavigation({ ...wheelInput, ctrlKey: true }), { type: "zoom", delta: -0.32 });
  assert.deepEqual(phoneWheelNavigation({ ...wheelInput, deltaY: -10_000, ctrlKey: true }), { type: "zoom", delta: 1 });
  assert.equal(phoneWheelNavigation({ ...wheelInput, width: 0 }), null);
  assert.equal(phoneWheelNavigation({ ...wheelInput, deltaY: Number.NaN }), null);
  assert.equal(phoneWheelNavigation({ ...wheelInput, deltaMode: 9 }), null);
});

test("one pointer owns either a touch or an orbit until it ends, and navigation waits for it", () => {
  const events: string[] = [];
  const interaction = createPhoneInteraction({
    screenPoint: (point) => (point.x > 0.25 && point.x < 0.75 ? { x: point.x, y: point.y } : null),
    touch: (phase, point) => events.push(`${phase}:${point.x}`),
    orbit: (dx) => events.push(`orbit:${dx}`),
    zoomBy: (delta) => events.push(`zoom:${delta}`),
    onInteractionActive: (active, mode) => events.push(`${active ? "hold" : "free"}:${mode}`),
  });
  assert.equal(interaction.begin(1, { x: 0.5, y: 0.5 }), true);
  assert.equal(interaction.begin(2, { x: 0.1, y: 0.5 }), false);
  // Moving the camera under a captured touch would move its projected point.
  assert.equal(interaction.navigate({ type: "orbit", x: 0.1, y: 0 }), false);
  assert.equal(interaction.navigate({ type: "zoom", delta: 0.2 }), false);
  interaction.move(2, { x: 0.6, y: 0.5 });
  interaction.move(1, { x: 0.6, y: 0.5 });
  // Off the display during a captured touch: no move is sent, and the last point ends it.
  interaction.move(1, { x: 0.9, y: 0.5 });
  // A trackpad release cannot end a captured touch.
  interaction.endWheel();
  interaction.end(2);
  interaction.end(1);
  assert.deepEqual(events, ["hold:touch", "begin:0.5", "move:0.6", "end:0.6", "free:touch"]);

  events.length = 0;
  interaction.begin(3, { x: 0.1, y: 0.5 });
  interaction.move(3, { x: 0.2, y: 0.5 });
  interaction.end();
  assert.deepEqual(events, ["hold:orbit", `orbit:${0.2 - 0.1}`, "free:orbit"]);

  events.length = 0;
  // Alt-drag orbits even over the display.
  interaction.begin(4, { x: 0.5, y: 0.5 }, true);
  interaction.end(4);
  assert.equal(interaction.active(), false);
  assert.equal(interaction.navigate({ type: "zoom", delta: 0.2 }), true);
  assert.equal(interaction.navigate({ type: "orbit", x: 0.1, y: 0.2 }), true);
  interaction.endWheel();
  assert.deepEqual(events, ["hold:orbit", "free:orbit", "zoom:0.2", "orbit:0.1", "free:orbit"]);
});

class FakeCanvas extends EventTarget {
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 400, height: 800 } as DOMRect;
  }
}

function manualTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  const timers: TrackpadTimers = {
    setTimeout: (run, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, run });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => void pending.delete(timer as unknown as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...pending]) {
      if (timer.at <= now) {
        pending.delete(id);
        timer.run();
      }
    }
  };
  return { timers, advance };
}

const wheel = (ctrlKey = false, extra: Record<string, unknown> = {}) =>
  Object.assign(new Event("wheel", { cancelable: true }), { deltaX: 16, deltaY: -20, deltaMode: 0, ctrlKey, ...extra });
const gesture = (type: string, scale: number) => Object.assign(new Event(type, { cancelable: true }), { scale });

// Adapted from t3code phoneTrackpad.test.ts @ a6ec88f7 (MIT).
test("the trackpad consumes scrolling and page zoom only on the bound canvas, and pinch zooms the device", () => {
  const canvas = new FakeCanvas();
  const navigations: unknown[] = [];
  const { timers } = manualTimers();
  const binding = bindPhoneTrackpad(
    canvas,
    { navigate: (next) => (navigations.push(next), true), endWheel: () => undefined },
    undefined,
    timers,
  );
  const swipe = wheel();
  canvas.dispatchEvent(swipe);
  const pinch = wheel(true);
  canvas.dispatchEvent(pinch);
  assert.equal(swipe.defaultPrevented, true);
  assert.equal(pinch.defaultPrevented, true);
  assert.deepEqual(navigations, [
    { type: "orbit", x: -0.04, y: 0.025 },
    { type: "zoom", delta: 0.2 },
  ]);
  // Safari reports cumulative scale; each change zooms by its log ratio.
  canvas.dispatchEvent(gesture("gesturestart", 1));
  canvas.dispatchEvent(gesture("gesturechange", 1.2));
  assert.deepEqual(last(navigations), { type: "zoom", delta: Math.log(1.2) });
  canvas.dispatchEvent(gesture("gestureend", 1.2));
  binding.dispose();
  const detached = wheel(true);
  canvas.dispatchEvent(detached);
  assert.equal(detached.defaultPrevented, false);
  assert.equal(navigations.length, 3);
});

test("a hinge pinch takes Ctrl-wheel and Safari scale, expires idle sequences, and ends on detach", () => {
  const canvas = new FakeCanvas();
  const calls: string[] = [];
  const pinch = {
    begin: () => (calls.push("begin"), true),
    move: (step: number) => void calls.push(`move:${step.toFixed(3)}`),
    end: () => void calls.push("end"),
  };
  const navigations: unknown[] = [];
  const { timers, advance } = manualTimers();
  const binding = bindPhoneTrackpad(
    canvas,
    { navigate: (next) => (navigations.push(next), true), endWheel: () => undefined },
    pinch,
    timers,
  );
  canvas.dispatchEvent(wheel(true));
  canvas.dispatchEvent(wheel(true));
  assert.deepEqual(calls, ["begin", "move:0.200", "move:0.200"]);
  advance(TRACKPAD_PINCH_IDLE_MS);
  assert.equal(last(calls), "end");
  canvas.dispatchEvent(gesture("gesturestart", 1));
  canvas.dispatchEvent(gesture("gesturechange", 1.2));
  assert.equal(last(calls), `move:${Math.log(1.2).toFixed(3)}`);
  // A Ctrl-wheel echo during a Safari gesture is ignored.
  const moves = calls.filter((call) => call.startsWith("move")).length;
  canvas.dispatchEvent(wheel(true));
  assert.equal(calls.filter((call) => call.startsWith("move")).length, moves);
  binding.dispose();
  assert.equal(last(calls), "end");
  assert.deepEqual(navigations, []);
});

test("a paused trackpad orbit stays held until the native release or the browser fallback", () => {
  const canvas = new FakeCanvas();
  let ended = 0;
  const { timers, advance } = manualTimers();
  const binding = bindPhoneTrackpad(canvas, { navigate: () => true, endWheel: () => void ended++ }, undefined, timers);
  canvas.dispatchEvent(wheel());
  advance(500);
  assert.equal(ended, 0);
  binding.endOrbit();
  assert.equal(ended, 1);
  canvas.dispatchEvent(wheel());
  advance(TRACKPAD_ORBIT_FALLBACK_MS - 1);
  assert.equal(ended, 1);
  advance(1);
  assert.equal(ended, 2);
  // Momentum after the fingers lift ends the orbit instead of extending it.
  canvas.dispatchEvent(wheel());
  canvas.dispatchEvent(wheel(false, { momentum: true }));
  assert.equal(ended, 3);
  binding.dispose();
});

test("the frame preference defaults to 3D and survives unreadable storage", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  assert.equal(readFramePreference(storage), "3d");
  writeFramePreference("flat", storage);
  assert.equal(store.get(DEVICE_FRAME_PREFERENCE_KEY), "flat");
  assert.equal(readFramePreference(storage), "flat");
  store.set(DEVICE_FRAME_PREFERENCE_KEY, "sideways");
  assert.equal(readFramePreference(storage), "3d");
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readFramePreference(broken), "3d");
  assert.doesNotThrow(() => writeFramePreference("flat", broken));
  assert.equal(readFramePreference(null), "3d");
});

test("MJPEG, a failed 3D view, and a Duo without hinge readback keep the flat screen; hinged Duos are framed", () => {
  assert.equal(frameBlocker({ mjpeg: false, duoWithoutHinge: false, frameFailed: false }), null);
  assert.equal(frameBlocker({ mjpeg: true, duoWithoutHinge: true, frameFailed: true }), "failed");
  assert.equal(frameBlocker({ mjpeg: true, duoWithoutHinge: true, frameFailed: false }), "mjpeg");
  assert.equal(frameBlocker({ mjpeg: false, duoWithoutHinge: true, frameFailed: false }), "duo-hub");
  assert.equal(frameBlockerLabel(null), "3D view");
  assert.equal(frameBlockerLabel("duo-hub"), "iPhone Duo 3D requires Device Hub 0.11.0 or newer");
  for (const blocker of ["failed", "mjpeg"] as const) assert.match(frameBlockerLabel(blocker), /unavailable/u);
});

// Adapted from t3code shapeProfile.test.ts @ a6ec88f7 (MIT).
test("names and kinds pick a family without mistaking display rotation for device shape", () => {
  assert.equal(
    resolveDeviceShape({ platform: "ios", name: "iPad Pro 11-inch (M5)", portraitAspect: 0.75 }),
    IOS_TABLET_SHAPE,
  );
  assert.equal(resolveDeviceShape({ platform: "ios", name: "iPhone 18 Pro", portraitAspect: 0.46 }), IOS_PHONE_SHAPE);
  assert.equal(
    resolveDeviceShape({ platform: "ios", kind: "ipad", name: "Julius", portraitAspect: 0.46 }),
    IOS_TABLET_SHAPE,
  );
  assert.equal(resolveDeviceShape({ platform: "ios", kind: "iphone", portraitAspect: 0.75 }), IOS_PHONE_SHAPE);
  assert.equal(resolveDeviceShape({ platform: "android", name: "Pixel 9", portraitAspect: 0.45 }), ANDROID_PHONE_SHAPE);
  assert.equal(
    resolveDeviceShape({ platform: "android", name: "Pixel Tablet", portraitAspect: 0.625 }),
    ANDROID_TABLET_SHAPE,
  );
});

test("renamed devices use the screen shape, with a phone before metadata arrives", () => {
  assert.equal(
    resolveDeviceShape({ platform: "ios", kind: "other", name: "Julius", portraitAspect: 0.75 }),
    IOS_TABLET_SHAPE,
  );
  assert.equal(resolveDeviceShape({ platform: "ios", kind: "other", portraitAspect: 0.46 }), IOS_PHONE_SHAPE);
  assert.equal(resolveDeviceShape({ platform: "android", portraitAspect: 0.45 }), ANDROID_PHONE_SHAPE);
  assert.equal(resolveDeviceShape({ platform: "ios", portraitAspect: Number.NaN }), IOS_PHONE_SHAPE);
  assert.ok(SCREEN_HEIGHT > 0);
});
