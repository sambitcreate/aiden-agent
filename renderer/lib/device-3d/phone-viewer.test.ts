// Adapted from t3code packages/client-runtime/src/device/phoneViewer.test.ts @ a6ec88f7 (MIT).
// The hardware-model, zoom, capture and failure tests are Aiden's own.
import assert from "node:assert/strict";
import test from "node:test";
import { Box3, Mesh, Quaternion, Vector3 } from "three";
import { createPhoneViewer, PHONE_ZOOM_LIMITS } from "./phone-viewer.js";
import {
  ANDROID_PHONE_SHAPE,
  IOS_TABLET_SHAPE,
  resolveDeviceShape,
  type DeviceShapeProfile,
} from "./shape-profile.js";
import type { DeviceModelId } from "./model-registry.js";
import { createTestRuntime, testCanvas } from "./viewer-test-support.js";

/** The newest entry. Equivalent to `.at(-1)`, which the ES2021 lib lacks. */
const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

const close = (actual: number, expected: number, epsilon = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);

function fixture(options: { profile?: DeviceShapeProfile; model?: DeviceModelId; reduced?: boolean } = {}) {
  const test = createTestRuntime({ reduced: options.reduced ?? false });
  const canvas = testCanvas();
  const source = { width: 1206, height: 2622 } as HTMLCanvasElement;
  let unavailable = 0;
  const viewer = createPhoneViewer({
    canvas,
    source,
    onUnavailable: () => void unavailable++,
    runtime: test.runtime,
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.model ? { model: options.model } : {}),
  });
  viewer.resize(400, 700, 2);
  // The stream's first decoded frame, as the viewport delivers it on mount.
  viewer.frameUpdated();
  test.draw();
  return { ...test, viewer, canvas, source, state: test.renderers[0]!, unavailable: () => unavailable };
}

test("resize and redraw commit together, keeping the scene, the body and the pose", () => {
  const { viewer, draw, pendingFrames, source, state, unavailable, renderers } = fixture();
  viewer.orbit(0.08, 0.04);
  draw();
  const previous = last(state.frames)!;
  const allocations = state.allocations;
  viewer.resize(500, 700, 2);
  viewer.resize(450, 700, 2);
  viewer.frameUpdated();
  // ResizeObserver runs after rAF. A cleared buffer here would reach the browser's next paint.
  assert.equal(state.blank, false);
  assert.equal(state.allocations, allocations);
  assert.equal(pendingFrames(), 1);
  draw();
  assert.deepEqual(state.size, { width: 450, height: 700, pixelRatio: 2 });
  assert.equal(state.allocations, allocations + 1);
  assert.equal(last(state.frames)!.scene, previous.scene);
  assert.equal(last(state.frames)!.root, previous.root);
  assert.equal(last(state.frames)!.yaw, previous.yaw);
  viewer.resize(400, 700, 2);
  draw();
  close(last(state.frames)!.camera.position.z, previous.camera.position.z, 1e-6);
  assert.deepEqual({ width: source.width, height: source.height }, { width: 1206, height: 2622 });
  assert.equal(renderers.length, 1);
  assert.equal(unavailable(), 0);
  viewer.dispose();
});

test("redundant and invalid sizes are ignored, a pixel-ratio change is one allocation, and dispose stops drawing", () => {
  const { viewer, draw, pendingFrames, state, environmentsDisposed } = fixture();
  const allocations = state.allocations;
  viewer.resize(400, 700, 2);
  viewer.resize(400, 700, 5);
  viewer.resize(0, 700, 2);
  viewer.resize(Number.NaN, 700, 2);
  assert.equal(pendingFrames(), 0);
  viewer.resize(400, 700, 1);
  draw();
  assert.equal(state.size.pixelRatio, 1);
  assert.equal(state.allocations, allocations + 1);
  viewer.resize(450, 700, 1);
  viewer.dispose();
  draw();
  assert.equal(state.allocations, allocations + 1);
  assert.equal(state.disposed, true);
  assert.equal(environmentsDisposed(), 1);
});

test("a new device shape replaces only the body, never the renderer, source or pose", () => {
  const { viewer, draw, source, state, renderers } = fixture();
  viewer.orbit(0.1, 0.05);
  draw();
  const previous = last(state.frames)!;
  const allocations = state.allocations;
  viewer.setScreen(null, IOS_TABLET_SHAPE);
  draw();
  assert.notEqual(last(state.frames)!.root, previous.root);
  assert.equal(last(state.frames)!.yaw, previous.yaw);
  assert.equal(last(state.frames)!.scene, previous.scene);
  assert.equal(state.allocations, allocations);
  assert.equal(source.width, 1206);
  assert.equal(renderers.length, 1);
  const tablet = last(state.frames)!.root;
  viewer.frameUpdated();
  draw();
  assert.equal(last(state.frames)!.root, tablet);
  viewer.dispose();
});

test("an Android phone turns its display smoothly between orientations on one viewer", () => {
  const open = resolveDeviceShape({ platform: "android", portraitAspect: 0.96 });
  const { viewer, draw, source, state, renderers } = fixture({ profile: open });
  const scene = last(state.frames)!.scene;
  source.width = 2076;
  source.height = 2152;
  viewer.setScreen({ width: 2076, height: 2152, orientation: "landscape_left" });
  viewer.frameUpdated();
  draw(0);
  close(last(state.frames)!.displayAngle!, 0);
  draw(225);
  close(last(state.frames)!.displayAngle!, -Math.PI / 4);
  draw(450);
  close(last(state.frames)!.displayAngle!, -Math.PI / 2);
  assert.equal(last(state.frames)!.scene, scene);
  source.width = 1080;
  source.height = 2424;
  viewer.setScreen({ width: 1080, height: 2424, orientation: "portrait" }, ANDROID_PHONE_SHAPE);
  viewer.frameUpdated();
  draw(450);
  close(last(state.frames)!.displayAngle!, -Math.PI / 2);
  draw(675);
  close(last(state.frames)!.displayAngle!, -Math.PI / 4);
  draw(900);
  close(last(state.frames)!.displayAngle!, 0);
  assert.equal(renderers.length, 1);
  viewer.dispose();
});

test("an Android fold animates its hinge on one scene, through an encoder resize", () => {
  const open = resolveDeviceShape({ platform: "android", portraitAspect: 0.96 });
  const { viewer, draw, source, state, renderers } = fixture({ profile: open });
  viewer.setFoldAngle(180);
  draw(0);
  const shell = last(state.frames)!.root!;
  const moving = shell.children[0]!.children[0]!;
  viewer.setFoldAngle(0);
  draw(425);
  close(moving.rotation.y, Math.PI / 2);
  source.width = 1080;
  source.height = 2424;
  viewer.setScreen({ width: 1080, height: 2424, orientation: "portrait" }, ANDROID_PHONE_SHAPE);
  viewer.frameUpdated();
  draw(850);
  close(moving.rotation.y, Math.PI);
  assert.equal(last(state.frames)!.root, shell);
  assert.equal(renderers.length, 1);
  viewer.dispose();
});

test("the fold body takes a landscape inner display's width and keeps it through the cover frame", () => {
  const open = resolveDeviceShape({ platform: "android", portraitAspect: 0.83 });
  const { viewer, draw, source, state } = fixture({ profile: open });
  viewer.setFoldAngle(180);
  draw(0);
  const portraitWidth = new Box3().setFromObject(last(state.frames)!.root!).getSize(new Vector3()).x;
  source.width = 2208;
  source.height = 1840;
  viewer.setScreen({ width: 2208, height: 1840, orientation: "portrait" });
  viewer.frameUpdated();
  draw(10);
  const landscape = last(state.frames)!.root!;
  const landscapeWidth = new Box3().setFromObject(landscape).getSize(new Vector3()).x;
  assert.ok(landscapeWidth / portraitWidth > 1.15);
  source.width = 1080;
  source.height = 2092;
  viewer.setScreen({ width: 1080, height: 2092, orientation: "portrait" }, ANDROID_PHONE_SHAPE);
  viewer.frameUpdated();
  draw(20);
  assert.equal(last(state.frames)!.root, landscape);
  viewer.dispose();
});

test("the inner display shape is learned before fold mode and survives a rotated cover frame", () => {
  const { viewer, draw, source, state } = fixture({ profile: ANDROID_PHONE_SHAPE });
  source.width = 2208;
  source.height = 1840;
  viewer.setScreen({ width: 2208, height: 1840, orientation: "portrait" });
  viewer.frameUpdated();
  draw(0);
  viewer.setFoldAngle(180);
  draw(10);
  const landscape = last(state.frames)!.root!;
  const size = new Box3().setFromObject(landscape).getSize(new Vector3());
  assert.ok(size.x / size.y > 1.1);
  source.width = 2092;
  source.height = 1080;
  viewer.setScreen({ width: 2092, height: 1080, orientation: "landscape_left" });
  viewer.frameUpdated();
  draw(20);
  assert.equal(last(state.frames)!.root, landscape);
  viewer.dispose();
});

test("an unfinished hinge turn retargets from the angle on screen", () => {
  const { viewer, draw, state } = fixture({ profile: ANDROID_PHONE_SHAPE });
  viewer.setFoldAngle(180);
  draw(0);
  const moving = last(state.frames)!.root!.children[0]!.children[0]!;
  viewer.setFoldAngle(0);
  draw(200);
  const visible = moving.rotation.y;
  viewer.setFoldAngle(180);
  draw(200);
  close(moving.rotation.y, visible);
  draw(1050);
  close(moving.rotation.y, 0);
  viewer.dispose();
});

test("with Reduce Motion a fold lands at once", () => {
  const { viewer, draw, state, pendingFrames } = fixture({ profile: ANDROID_PHONE_SHAPE, reduced: true });
  viewer.setFoldAngle(180);
  draw(0);
  const moving = last(state.frames)!.root!.children[0]!.children[0]!;
  viewer.setFoldAngle(0);
  draw(16);
  close(moving.rotation.y, Math.PI);
  assert.equal(pendingFrames(), 0);
  viewer.dispose();
});

test("an orbit springs back toward the screen, a captured touch freezes it, and rendering stops at rest", () => {
  const { viewer, draw, pendingFrames, state, settle } = fixture();
  const initialYaw = last(state.frames)!.yaw!;
  viewer.setInteractionActive(true, "orbit");
  viewer.orbit(0.8, 0.4);
  draw(80);
  const dragged = last(state.frames)!;
  assert.ok(Math.abs(dragged.yaw! - initialYaw) > 0.05);
  viewer.setInteractionActive(false, "orbit");
  draw(160);
  viewer.setInteractionActive(true, "touch");
  draw(180);
  const captured = last(state.frames)!;
  viewer.orbit(1, 1);
  viewer.frameUpdated();
  draw(1000);
  assert.equal(last(state.frames)!.yaw, captured.yaw);
  assert.equal(last(state.frames)!.camera.position.z, captured.camera.position.z);
  assert.equal(pendingFrames(), 0);
  viewer.setInteractionActive(false, "touch");
  settle();
  assert.equal(pendingFrames(), 0);
  assert.ok(Math.abs(last(state.frames)!.yaw!) <= Math.PI / 3 + 1e-6);
  assert.equal(last(state.frames)!.root, dragged.root);
  viewer.dispose();
});

test("Restore 3D view returns to a square front view at the fitted distance", () => {
  const { viewer, draw, state, settle } = fixture();
  const front = last(state.frames)!;
  assert.ok(front.rotation!.angleTo(new Quaternion()) < 1e-6);
  viewer.orbit(0.8, 0.4);
  viewer.zoomBy(0.5);
  draw(80);
  assert.ok(last(state.frames)!.rotation!.angleTo(front.rotation!) > 0.05);
  viewer.resetPose();
  settle();
  assert.ok(last(state.frames)!.rotation!.angleTo(new Quaternion()) < 1e-6);
  close(last(state.frames)!.camera.position.z, front.camera.position.z, 1e-6);
  viewer.dispose();
});

test("pinch zoom moves the camera logarithmically within its limits", () => {
  const { viewer, draw, state } = fixture();
  const fitted = last(state.frames)!.camera.position.z;
  viewer.zoomBy(0.4);
  draw();
  close(last(state.frames)!.camera.position.z, fitted * Math.exp(-0.4), 1e-6);
  viewer.zoomBy(10);
  draw();
  close(last(state.frames)!.camera.position.z, fitted * Math.exp(-PHONE_ZOOM_LIMITS.closer), 1e-6);
  viewer.zoomBy(-10);
  draw();
  close(last(state.frames)!.camera.position.z, fitted * Math.exp(PHONE_ZOOM_LIMITS.farther), 1e-6);
  viewer.zoomBy(Number.NaN);
  draw();
  close(last(state.frames)!.camera.position.z, fitted * Math.exp(PHONE_ZOOM_LIMITS.farther), 1e-6);
  viewer.dispose();
});

test("a hardware model replaces the family body in place and survives rotation and resolution changes", () => {
  const { viewer, draw, source, state, renderers } = fixture();
  viewer.orbit(0.05, 0);
  draw(40);
  const familyRoot = last(state.frames)!.root;
  const allocations = state.allocations;
  viewer.setModel("iphone-pro");
  draw(60);
  const modelRoot = last(state.frames)!.root!;
  assert.notEqual(modelRoot, familyRoot);
  assert.ok(modelRoot.getObjectByName("device-screen"), "the model's display is live");
  assert.equal(state.allocations, allocations);
  const geometries: Mesh["geometry"][] = [];
  modelRoot.traverse((object) => {
    if (object instanceof Mesh) geometries.push(object.geometry);
  });
  let released = 0;
  for (const geometry of new Set(geometries)) geometry.addEventListener("dispose", () => void released++);
  // A framebuffer turn and a native resolution change keep the model.
  source.width = 2622;
  source.height = 1206;
  viewer.setScreen({ width: 2622, height: 1206, orientation: "landscape_left" });
  viewer.frameUpdated();
  draw(80);
  source.width = 2412;
  source.height = 1110;
  viewer.frameUpdated();
  draw(100);
  assert.equal(last(state.frames)!.root, modelRoot);
  assert.equal(released, 0);
  // The Duo has its own viewer; asking this one for it keeps a family body.
  viewer.setModel("iphone-duo");
  draw(120);
  assert.ok(!last(state.frames)!.root!.getObjectByName("device-screen"));
  assert.equal(released, new Set(geometries).size, "the replaced model is released once");
  assert.equal(renderers.length, 1);
  viewer.dispose();
});

test("a lost context or a failed render falls back once and stops drawing", () => {
  const { viewer, draw, canvas, state, unavailable, pendingFrames } = fixture();
  state.failNextRender = true;
  viewer.orbit(0.1, 0);
  draw(20);
  assert.equal(unavailable(), 1);
  canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  viewer.frameUpdated();
  draw(40);
  assert.equal(unavailable(), 1);
  assert.equal(pendingFrames(), 0);
  viewer.dispose();
});

test("capturing the framed device draws the current pose and returns an image", async () => {
  const { viewer, state } = fixture({ model: "iphone-pro" });
  const frames = state.frames.length;
  const image = await viewer.capture();
  assert.ok(image && image.type === "image/png");
  assert.equal(state.frames.length, frames + 1);
  viewer.dispose();
  assert.equal(await viewer.capture(), null);
});
