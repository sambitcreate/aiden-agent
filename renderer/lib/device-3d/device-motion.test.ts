// Adapted from t3code packages/client-runtime/src/device/deviceMotion.test.ts and
// deviceFraming.test.ts @ a6ec88f7 (MIT).
import assert from "node:assert/strict";
import test from "node:test";
import { Box3, Quaternion, Vector3 } from "three";
import { createDeviceMotion, rotationVector } from "./device-motion.js";
import { createDeviceFraming } from "./framing.js";
import { nearestDeviceView } from "./view-snap.js";

const snaps = ["portrait", "landscape_left", "portrait_upside_down", "landscape_right"].map((orientation, index) => ({
  orientation,
  rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (-index * Math.PI) / 2),
  yawLimit: Math.PI / 3,
}));
const rotation = (x: number, y: number, z = 0) =>
  new Quaternion().setFromAxisAngle(new Vector3(x, y, z).normalize(), Math.hypot(x, y, z));

/** A `choose` that records how often release picked a view. */
function chooser(pick: (q: Quaternion) => Quaternion = (q) => q) {
  const calls: Quaternion[] = [];
  return {
    calls,
    choose: (q: Quaternion) => {
      calls.push(q.clone());
      return pick(q);
    },
  };
}

test("the nearest view keeps a nearby yaw, clamps a far one, and ignores the quaternion's sign", () => {
  const side = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2);
  const released = side.clone().premultiply(rotation(0, 0.4));
  const nearest = nearestDeviceView(released, snaps)!;
  assert.equal(nearest.orientation, "landscape_left");
  assert.ok(nearest.rotation.angleTo(released) < 1e-6);
  const negative = released.clone().set(-released.x, -released.y, -released.z, -released.w);
  assert.ok(nearestDeviceView(negative, snaps)!.rotation.angleTo(nearest.rotation) < 1e-6);
  assert.ok(nearestDeviceView(rotation(0, 3), snaps)!.rotation.angleTo(new Quaternion()) <= Math.PI / 3 + 1e-6);
});

test("a drag springs toward its cumulative target and lands the same however events are partitioned", () => {
  const run = (parts: number) => {
    const pick = chooser();
    const motion = createDeviceMotion({ choose: pick.choose });
    motion.dragActive(true, 0);
    for (let part = 0; part < parts; part++) motion.orbit(160 / parts, 80 / parts, 0);
    // The device follows a spring; it never teleports to the pointer.
    assert.ok(motion.rotation.angleTo(new Quaternion()) < 1e-6);
    for (let time = 8; time <= 400; time += 8) motion.advance(time);
    assert.ok(motion.rotation.angleTo(new Quaternion()) > 0.5);
    motion.dragActive(false, 400);
    for (let time = 408; time <= 2400; time += 8) motion.advance(time);
    assert.equal(pick.calls.length, 1);
    assert.equal(motion.needsFrame(), false);
    return motion.rotation;
  };
  assert.ok(run(1).angleTo(run(20)) < 1e-6);
});

test("release picks the predicted view once, and a new drag takes over at the displayed pose", () => {
  const pick = chooser((q) => nearestDeviceView(q, snaps)!.rotation);
  const motion = createDeviceMotion({ choose: pick.choose });
  motion.dragActive(true, 0);
  motion.orbit(0, 240, 0);
  motion.orbit(0, 20, 20);
  motion.advance(40);
  motion.dragActive(false, 40);
  const before = motion.rotation.clone();
  motion.advance(80);
  assert.ok(motion.rotation.angleTo(before) > 0.01);
  const interrupted = motion.rotation.clone();
  motion.dragActive(true, 80);
  assert.ok(motion.rotation.angleTo(interrupted) < 1e-6);
  motion.orbit(30, -30, 80);
  motion.advance(96);
  motion.dragActive(false, 100);
  for (let time = 116; time <= 2500; time += 16) motion.advance(time);
  assert.equal(pick.calls.length, 2);
  assert.equal(motion.needsFrame(), false);
});

test("a hard flick coasts through several turns, then settles on its chosen view", () => {
  const pick = chooser(() => new Quaternion());
  const motion = createDeviceMotion({ choose: pick.choose });
  motion.dragActive(true, 0);
  motion.orbit(0, 80, 16);
  motion.advance(16);
  motion.orbit(0, 80, 32);
  motion.advance(32);
  motion.dragActive(false, 32);
  let previous = motion.rotation.clone();
  let travel = 0;
  let lateSpeed = 0;
  for (let time = 40; time <= 8500; time += 8) {
    motion.advance(time);
    const distance = motion.rotation.angleTo(previous);
    travel += distance;
    if (time >= 2500) lateSpeed = Math.max(lateSpeed, distance / 0.008);
    previous = motion.rotation.clone();
  }
  assert.ok(travel > 4 * Math.PI);
  assert.ok(lateSpeed < 2.5);
  assert.equal(pick.calls.length, 1);
  assert.ok(motion.rotation.angleTo(new Quaternion()) < 1e-6);
  assert.equal(motion.needsFrame(), false);
});

test("release is independent of frame rate, and a captured touch freezes the pose", () => {
  const run = (step: number) => {
    const motion = createDeviceMotion({ choose: () => new Quaternion() });
    motion.dragActive(true, 0);
    motion.orbit(160, 80, 0);
    motion.advance(50);
    motion.dragActive(false, 50);
    for (let time = 50; time < 450; time += step) motion.advance(time);
    motion.advance(450);
    return motion;
  };
  const fast = run(8);
  const slow = run(33);
  const throttled = run(1000);
  assert.ok(fast.rotation.angleTo(slow.rotation) < 1e-6);
  assert.ok(fast.rotation.angleTo(throttled.rotation) < 1e-6);
  fast.hold(true, 450);
  const contact = fast.rotation.clone();
  fast.orbit(100, 100, 500);
  fast.advance(10_000);
  assert.ok(fast.rotation.angleTo(contact) < 1e-6);
  fast.hold(false, 10_000);
  fast.advance(12_000);
  assert.equal(fast.needsFrame(), false);
});

test("a trackpad orbit holds through a pause and snaps only when the gesture ends", () => {
  const pick = chooser(() => new Quaternion());
  const motion = createDeviceMotion({ choose: pick.choose });
  motion.orbit(Number.NaN, 0, 0);
  assert.equal(motion.needsFrame(), false);
  motion.orbit(200, 100, 0);
  motion.advance(100);
  assert.equal(pick.calls.length, 0);
  assert.ok(motion.rotation.angleTo(new Quaternion()) > 0);
  // Reduced motion jumps to the target.
  motion.advance(140, true);
  const held = motion.rotation.clone();
  assert.ok(held.angleTo(new Quaternion()) > 0.5);
  assert.equal(motion.needsFrame(), false);
  motion.orbit(80, 0, 200);
  motion.advance(340, true);
  assert.ok(motion.rotation.angleTo(held) > 0.1);
  assert.equal(pick.calls.length, 0);
  motion.dragActive(false, 340);
  motion.advance(2500);
  assert.equal(pick.calls.length, 1);
  assert.ok(motion.rotation.angleTo(new Quaternion()) < 1e-6);
  assert.equal(motion.needsFrame(), false);
  assert.ok(Math.abs(rotationVector(rotation(0, Math.PI)).length() - Math.PI) < 1e-6);
});

test("release speed stays bounded even across a back-facing half turn", () => {
  const motion = createDeviceMotion({ choose: () => rotation(0, Math.PI) });
  motion.setPose(rotation(0, Math.PI), 0);
  let previous = motion.rotation.clone();
  for (let time = 8; time <= 1600; time += 8) {
    motion.advance(time);
    assert.ok(motion.rotation.angleTo(previous) <= 9 * 0.008 + 1e-5);
    previous = motion.rotation.clone();
  }
  assert.ok(motion.rotation.angleTo(rotation(0, Math.PI)) < 1e-6);
  assert.equal(motion.needsFrame(), false);
});

test("a click without dragging resumes the interrupted rest view instead of stranding the device", () => {
  const pick = chooser(() => new Quaternion());
  const motion = createDeviceMotion({ choose: pick.choose });
  const rest = rotation(0, 0.8);
  motion.setPose(rest, 0);
  motion.advance(50);
  motion.dragActive(true, 50);
  motion.advance(60);
  motion.dragActive(false, 60);
  motion.advance(2100);
  assert.ok(motion.rotation.angleTo(rest) < 1e-6);
  assert.equal(pick.calls.length, 0);
  assert.equal(motion.needsFrame(), false);
});

const box = (x: number, width: number) =>
  new Box3(new Vector3(x - width / 2, -1, -0.2), new Vector3(x + width / 2, 1, 0.2));

test("framing fits a moving assembly on both axes, freezes during contact, and stops once settled", () => {
  const framing = createDeviceFraming();
  framing.setBounds(box(0, 1), Math.PI / 8, 0.7, 0);
  const initialDistance = framing.distance();
  const next = box(1.5, 3);
  framing.setBounds(next, Math.PI / 8, 0.7, 10);
  framing.advance(50);
  assert.ok(framing.center.x > 0 && framing.center.x < 1.5);
  // Spring lag never clips the fitted assembly.
  for (const x of [next.min.x, next.max.x]) {
    assert.ok(Math.abs(x - framing.center.x) / ((framing.distance() - next.max.z) * Math.tan(Math.PI / 8) * 0.7) < 1);
  }
  framing.hold(true, 50);
  const center = framing.center.clone();
  const distance = framing.distance();
  framing.advance(10_000);
  assert.ok(framing.center.equals(center));
  assert.equal(framing.distance(), distance);
  assert.equal(framing.needsFrame(), false);
  framing.hold(false, 10_000);
  framing.advance(10_016);
  assert.ok(framing.center.x < 1.5);
  framing.advance(12_000);
  assert.equal(framing.center.x, 1.5);
  assert.ok(framing.distance() > initialDistance);
  assert.equal(framing.needsFrame(), false);
});

test("framing uses elapsed time, not frame count, and fits a changed viewport immediately", () => {
  const run = (step: number) => {
    const framing = createDeviceFraming();
    framing.setBounds(box(0, 1), Math.PI / 8, 1, 0);
    framing.setBounds(box(-1, 2), Math.PI / 8, 1, 0);
    for (let time = step; time < 400; time += step) framing.advance(time);
    framing.advance(400);
    return framing;
  };
  const fast = run(8);
  const slow = run(33);
  assert.ok(fast.center.distanceTo(slow.center) < 1e-8);
  assert.ok(Math.abs(fast.distance() - slow.distance()) < 1e-8);
  fast.setBounds(box(-1, 2), Math.PI / 8, 0.4, 400, true);
  assert.ok(fast.distance() > slow.distance());
  assert.equal(fast.needsFrame(), false);
});
