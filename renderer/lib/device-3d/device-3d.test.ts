import assert from "node:assert/strict";
import test from "node:test";
import { Box3, BoxGeometry, PerspectiveCamera, Texture, Vector3 } from "three";
import {
  DEVICE_FRAME_PREFERENCE_KEY,
  frameBlocker,
  frameBlockerLabel,
  readFramePreference,
  writeFramePreference,
} from "./frame-mode.js";
import { createPhoneInteraction, createRenderScheduler, wheelOrbit } from "./interaction.js";
import { createDeviceMotion, ORBIT_GAIN, PITCH_LIMIT, REST_YAW_LIMIT } from "./motion.js";
import { createPhoneScene, phoneDisplayLayout, SCREEN_HEIGHT, updateDisplayUv } from "./phone-scene.js";
import { fitCamera } from "./phone-viewer.js";
import { IOS_PHONE_SHAPE, IOS_TABLET_SHAPE, resolveDeviceShape } from "./shape-profile.js";

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

test("the camera fits the posed device with a margin", () => {
  const bounds = new Box3(new Vector3(-0.6, -1.2, -0.05), new Vector3(0.6, 1.2, 0.05));
  const tall = fitCamera(bounds, 32, 0.3);
  const wide = fitCamera(bounds, 32, 2);
  assert.equal(tall.x, 0);
  assert.equal(tall.y, 0);
  // A narrow viewport is width-bound and must back away further.
  assert.ok(tall.distance > wide.distance);
  const halfHeight = Math.tan((32 * Math.PI) / 360) * (wide.distance - bounds.max.z);
  assert.ok(halfHeight > 1.2, "the device's full height is visible");
  assert.ok(fitCamera(new Box3(new Vector3(), new Vector3()), 32, 1).distance >= 1);
});

test("dragging turns the device, and release settles it facing the viewer", () => {
  const motion = createDeviceMotion();
  assert.equal(motion.needsFrame(), false);
  motion.orbit(100, 50, 0);
  assert.ok(motion.needsFrame());
  let now = 0;
  for (let frame = 0; frame < 120; frame += 1) motion.advance((now += 16), false);
  close(motion.yaw(), 100 * ORBIT_GAIN, 1e-3);
  close(motion.pitch(), 50 * ORBIT_GAIN, 1e-3);
  assert.equal(motion.needsFrame(), false);

  motion.orbit(0, 10_000, now);
  for (let frame = 0; frame < 120; frame += 1) motion.advance((now += 16), false);
  close(motion.pitch(), PITCH_LIMIT);

  motion.orbit(2_000, 0, now);
  motion.release(now);
  for (let frame = 0; frame < 200; frame += 1) motion.advance((now += 16), false);
  assert.ok(Math.abs(motion.yaw()) <= REST_YAW_LIMIT + 1e-9);
  assert.equal(motion.pitch(), 0);
  assert.equal(motion.needsFrame(), false);
});

test("a long spin settles the short way, reset faces front, and reduced motion jumps", () => {
  const motion = createDeviceMotion();
  motion.orbit((2 * Math.PI * 3 + 0.2) / ORBIT_GAIN, 0, 0);
  motion.advance(0, true);
  motion.release(0);
  motion.advance(16, true);
  close(motion.yaw(), 0.2);

  motion.reset(16);
  // Reduced motion reaches the target in one frame.
  assert.equal(motion.advance(32, true), true);
  assert.equal(motion.yaw(), 0);
  assert.equal(motion.needsFrame(), false);
  assert.equal(motion.advance(48, true), false);

  motion.orbit(Number.NaN, 1, 48);
  assert.equal(motion.needsFrame(), false);
});

test("a long frame gap never overshoots the spring", () => {
  const motion = createDeviceMotion();
  motion.orbit(100, 0, 0);
  motion.advance(10_000, false);
  assert.ok(motion.yaw() <= 100 * ORBIT_GAIN + 1e-9);
  assert.ok(motion.yaw() > 0);
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

test("trackpad swipes orbit in bounded viewport fractions; pinch and junk are ignored", () => {
  const base = { deltaX: 40, deltaY: -20, deltaMode: 0, ctrlKey: false, width: 400, height: 800 };
  assert.deepEqual(wheelOrbit(base), { x: -0.1, y: 0.025 });
  assert.equal(wheelOrbit({ ...base, ctrlKey: true }), null);
  assert.equal(wheelOrbit({ ...base, deltaX: 0, deltaY: 0 }), null);
  assert.equal(wheelOrbit({ ...base, deltaX: Number.NaN }), null);
  assert.equal(wheelOrbit({ ...base, width: 0 }), null);
  assert.equal(wheelOrbit({ ...base, deltaMode: 7 }), null);
  assert.deepEqual(wheelOrbit({ ...base, deltaMode: 1, deltaX: 100, deltaY: 0 }), { x: -0.25, y: -0 });
});

test("one pointer owns either a touch or an orbit until it ends", () => {
  const events: string[] = [];
  const interaction = createPhoneInteraction({
    screenPoint: (point) => (point.x > 0.25 && point.x < 0.75 ? { x: point.x, y: point.y } : null),
    touch: (phase, point) => events.push(`${phase}:${point.x}`),
    orbit: (dx) => events.push(`orbit:${dx}`),
    release: () => events.push("release"),
  });
  assert.equal(interaction.begin(1, { x: 0.5, y: 0.5 }), true);
  assert.equal(interaction.begin(2, { x: 0.1, y: 0.5 }), false);
  assert.equal(interaction.wheel({ x: 0.1, y: 0 }), false);
  interaction.move(2, { x: 0.6, y: 0.5 });
  interaction.move(1, { x: 0.6, y: 0.5 });
  // Off the display during a captured touch: no move is sent, and the last point ends it.
  interaction.move(1, { x: 0.9, y: 0.5 });
  interaction.end(2);
  interaction.end(1);
  assert.deepEqual(events, ["begin:0.5", "move:0.6", "end:0.6"]);

  events.length = 0;
  interaction.begin(3, { x: 0.1, y: 0.5 });
  interaction.move(3, { x: 0.2, y: 0.5 });
  interaction.end();
  assert.equal(events[0], `orbit:${0.2 - 0.1}`);
  assert.equal(events[1], "release");

  events.length = 0;
  // Alt-drag orbits even over the display.
  interaction.begin(4, { x: 0.5, y: 0.5 }, true);
  interaction.end(4);
  assert.deepEqual(events, ["release"]);
  assert.equal(interaction.active(), false);
  assert.equal(interaction.wheel({ x: 0.1, y: 0 }), true);
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

test("MJPEG, hinged simulators, and missing WebGL keep the flat screen", () => {
  assert.equal(frameBlocker({ mjpeg: false, hinged: false, webglUnavailable: false }), null);
  assert.equal(frameBlocker({ mjpeg: true, hinged: true, webglUnavailable: true }), "webgl");
  assert.equal(frameBlocker({ mjpeg: true, hinged: true, webglUnavailable: false }), "mjpeg");
  assert.equal(frameBlocker({ mjpeg: false, hinged: true, webglUnavailable: false }), "hinged");
  assert.equal(frameBlockerLabel(null), "3D frame");
  for (const blocker of ["webgl", "mjpeg", "hinged"] as const) assert.match(frameBlockerLabel(blocker), /unavailable/u);
});

test("the simulator kind picks the body, and unknown devices fall back on aspect", () => {
  assert.equal(resolveDeviceShape("iphone", 0.75), IOS_PHONE_SHAPE);
  assert.equal(resolveDeviceShape("ipad", 0.46), IOS_TABLET_SHAPE);
  assert.equal(resolveDeviceShape("other", 0.75), IOS_TABLET_SHAPE);
  assert.equal(resolveDeviceShape("other", 0.46), IOS_PHONE_SHAPE);
  assert.equal(resolveDeviceShape("other", Number.NaN), IOS_PHONE_SHAPE);
  assert.ok(SCREEN_HEIGHT > 0);
});
