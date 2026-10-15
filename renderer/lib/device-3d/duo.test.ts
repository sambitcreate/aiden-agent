// Duo scene and snap tests adapted from t3code duoScene.test.ts and duoSnap.test.ts @ a6ec88f7 (MIT);
// the procedural-model tests are Aiden's own.
import assert from "node:assert/strict";
import test from "node:test";
import {
  Box3,
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Texture,
  Vector3,
  type Object3D,
} from "three";
import type { DeviceScreenSize } from "../device-stream.js";
import { buildDuoModel, DUO_COVER_PIXELS, DUO_INNER_PIXELS } from "./duo-model.js";
import { createDuoScene, duoDisplayKey, duoRawPoint } from "./duo-scene.js";
import { duoViewSnaps, nearestDuoView } from "./duo-snap.js";
import { disposeDeviceModel } from "./model-scene.js";

const close = (actual: number, expected: number, epsilon = 1e-6, label = "") =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label} ${actual} is not within ${epsilon} of ${expected}`);

const uvs = (mesh: Mesh, axis: "x" | "y") => {
  const uv = mesh.geometry.getAttribute("uv");
  return Array.from({ length: uv.count }, (_, i) => (axis === "x" ? uv.getX(i) : uv.getY(i)));
};

const worldNormal = (mesh: Mesh) =>
  new Vector3().fromBufferAttribute(mesh.geometry.getAttribute("normal"), 0).transformDirection(mesh.matrixWorld);

const worldBounds = (object: Object3D) => new Box3().setFromObject(object);

function camera() {
  const view = new PerspectiveCamera(36, 1, 0.1, 50);
  view.position.z = 6;
  view.updateMatrixWorld();
  return view;
}

/** Normalized viewport coordinates of a point in `mesh`'s geometry space. */
function project(mesh: Mesh, local: Vector3, view: PerspectiveCamera) {
  const world = mesh.localToWorld(local.clone()).project(view);
  return { x: (world.x + 1) / 2, y: (1 - world.y) / 2 };
}

function procedural() {
  const asset = buildDuoModel();
  const scene = createDuoScene(asset, { 1: new Texture(), 3: new Texture() });
  const part = <T extends Object3D>(name: string) => asset.getObjectByName(name) as T;
  return {
    asset,
    scene,
    left: part<Group>("left-half"),
    right: part<Group>("right-half"),
    cover: part<Mesh>("cover-display"),
    innerLeft: part<Mesh>("inner-display-left"),
    innerRight: part<Mesh>("inner-display-right"),
    barrel: part<Mesh>("hinge-barrel"),
  };
}

test("the procedural Duo has the hinge rig and the three displays, all with identity transforms", () => {
  const { asset, scene, left, right, cover, innerLeft, innerRight } = procedural();
  for (const object of [left, right, cover, innerLeft, innerRight]) {
    assert.ok(object, "rig part present");
    assert.ok(object.position.length() === 0 && object.quaternion.angleTo(new Quaternion()) === 0, object.name);
  }
  assert.equal(cover.parent, left, "the cover is on the left leaf's back");
  assert.equal(innerLeft.parent, left);
  assert.equal(innerRight.parent, right);
  scene.dispose();
  disposeDeviceModel(asset);
});

test("the inner display is one continuous surface across the hinge, shaped like the inner framebuffer", () => {
  const { asset, scene, innerLeft, innerRight, cover } = procedural();
  scene.setAngle(180);
  // Planar UVs meet at the crease with no gap or overlap.
  close(Math.max(...uvs(innerLeft, "x")), 0.5);
  close(Math.min(...uvs(innerRight, "x")), 0.5);
  const inner = new Box3().union(innerLeft.geometry.boundingBox!).union(innerRight.geometry.boundingBox!).getSize(new Vector3());
  close(inner.x / inner.y, DUO_INNER_PIXELS.width / DUO_INNER_PIXELS.height, 2e-3, "inner aspect");
  const outer = cover.geometry.boundingBox!.getSize(new Vector3());
  close(outer.x / outer.y, DUO_COVER_PIXELS.width / DUO_COVER_PIXELS.height, 2e-3, "cover aspect");
  // Both inner halves are coplanar on the hinge plane, so the fold pivots exactly at the crease.
  close(innerLeft.geometry.boundingBox!.max.x, 0, 1e-6);
  close(innerRight.geometry.boundingBox!.min.x, 0, 1e-6);
  close(innerLeft.geometry.boundingBox!.max.z, 0, 1e-6);
  scene.dispose();
  disposeDeviceModel(asset);
});

test("closing folds the inner displays face to face, turns the cover outward, and leaves no overlap", () => {
  const { asset, scene, left, right, cover, innerLeft, innerRight, barrel } = procedural();
  scene.setAngle(180);
  scene.root.updateMatrixWorld(true);
  const open = worldBounds(scene.root).getSize(new Vector3());
  assert.ok(worldNormal(innerLeft).z > 0.999 && worldNormal(innerRight).z > 0.999, "open displays face the viewer");
  assert.ok(worldNormal(cover).z < -0.999, "the cover faces away while open");
  // Open, the barrel hides inside the leaves' thickness instead of bulging from the back.
  const leafBack = Math.min(worldBounds(left).min.z, worldBounds(right).min.z);
  assert.ok(worldBounds(barrel).min.z >= worldBounds(innerLeft).min.z - 0.2 && worldBounds(barrel).min.z >= leafBack - 1e-6);

  scene.setAngle(0);
  scene.root.updateMatrixWorld(true);
  const closed = worldBounds(scene.root).getSize(new Vector3());
  assert.ok(closed.x < open.x * 0.1, `closed width ${closed.x} vs open ${open.x}`);
  close(closed.y, open.y, 1e-6, "height is unchanged by the fold");
  const a = worldNormal(innerLeft);
  const b = worldNormal(innerRight);
  assert.ok(a.dot(b) < -0.999, "inner displays face each other");
  // The leaves meet at the hinge plane without passing through each other.
  assert.ok(worldBounds(left).max.x <= worldBounds(right).min.x + 1e-4);
  // The cover now faces outward, opposite the camera plateau's leaf.
  assert.ok(Math.abs(worldNormal(cover).x) > 0.999);
  scene.dispose();
  disposeDeviceModel(asset);
});

test("touches on the real model reach the active display in raw framebuffer space", () => {
  const { asset, scene, innerLeft, cover } = procedural();
  const view = camera();
  scene.setAngle(180);
  const inner: DeviceScreenSize = { width: 1125, height: 1600, orientation: "landscape_left", screenId: 3 };
  scene.root.updateMatrixWorld(true);
  const leftBounds = innerLeft.geometry.boundingBox!;
  const centre = leftBounds.getCenter(new Vector3());
  const point = project(innerLeft, centre, view);
  const hit = scene.screenPoint(point.x, point.y, view, inner, duoDisplayKey(inner));
  assert.ok(hit, "the left inner half accepts a touch");
  // The left half's centre is a quarter across the inner surface, which is mounted a quarter turn.
  const expected = duoRawPoint(3, 0.25, 0.5);
  close(hit.x, expected.x, 0.01);
  close(hit.y, expected.y, 0.01);
  // The cover is behind the open device and cannot take a touch from the front.
  const coverScreen: DeviceScreenSize = { width: 1140, height: 784, orientation: "portrait", screenId: 1 };
  assert.equal(scene.screenPoint(point.x, point.y, view, coverScreen, duoDisplayKey(coverScreen)), null);
  // Turned around, the cover takes touches.
  scene.root.rotation.y = Math.PI;
  scene.root.updateMatrixWorld(true);
  const coverPoint = project(cover, cover.geometry.boundingBox!.getCenter(new Vector3()).add(new Vector3(0, 0.3, 0)), view);
  const coverHit = scene.screenPoint(coverPoint.x, coverPoint.y, view, coverScreen, duoDisplayKey(coverScreen));
  assert.ok(coverHit, "the cover accepts a touch when it faces the viewer");
  close(coverHit.x, 0.5, 0.02);
  assert.ok(coverHit.y < 0.5, "up the cover is up the framebuffer");
  scene.dispose();
  disposeDeviceModel(asset);
});

test("the cover's camera cutout lies over the hole in the simulator's cover display", () => {
  const { asset, scene, left } = procedural();
  const view = camera();
  scene.setAngle(180);
  scene.root.rotation.y = Math.PI;
  scene.root.updateMatrixWorld(true);
  const cutout = left.children.find(
    (child): child is Mesh => child instanceof Mesh && !Array.isArray(child.material) && child.material.name === "cutout",
  );
  assert.ok(cutout, "the left leaf carries the cover camera");
  const point = project(cutout, cutout.geometry.boundingBox!.getCenter(new Vector3()), view);
  // Read the display under the camera, not the opaque cutout drawn over it.
  left.remove(cutout);
  scene.root.updateMatrixWorld(true);
  const coverScreen: DeviceScreenSize = { width: 1398, height: 2034, orientation: "portrait", screenId: 1 };
  const hit = scene.screenPoint(point.x, point.y, view, coverScreen, duoDisplayKey(coverScreen));
  assert.ok(hit, "the camera sits on the cover display");
  // Measured on a real iPhone Duo simulator: the mask's hole is centred at (1255, 143) of 1398 × 2034,
  // in the top corner away from the hinge. The stream draws it too, so the model must not add a second one.
  close(hit.x, 1255 / 1398, 0.01, "camera x");
  close(hit.y, 143 / 2034, 0.01, "camera y");
  scene.dispose();
  disposeDeviceModel(asset);
});

test("a pinch finds the leaf under the fingers on the real model", () => {
  const { asset, scene, innerLeft, innerRight } = procedural();
  const view = camera();
  scene.setAngle(150);
  scene.root.updateMatrixWorld(true);
  const over = (mesh: Mesh) => project(mesh, mesh.geometry.boundingBox!.getCenter(new Vector3()), view);
  assert.equal(scene.hingeLeafAt(over(innerLeft).x, over(innerLeft).y, view), "left");
  assert.equal(scene.hingeLeafAt(over(innerRight).x, over(innerRight).y, view), "right");
  assert.equal(scene.hingeLeafAt(0.01, 0.01, view), null);
  scene.dispose();
  disposeDeviceModel(asset);
});

// ---- T3's minimal rig: the scene logic independent of any one body ----

function fixture() {
  const asset = new Group();
  const left = new Group();
  left.name = "left-half";
  const right = new Group();
  right.name = "right-half";
  const screen = (name: string, x: number, z: number, rear = false) => {
    const mesh = new Mesh(new PlaneGeometry(1, 2), new MeshBasicMaterial());
    if (rear) mesh.geometry.rotateY(Math.PI);
    mesh.geometry.translate(x, 0, z);
    mesh.name = name;
    return mesh;
  };
  const innerLeft = screen("inner-display-left", -0.5, 0.06);
  const innerRight = screen("inner-display-right", 0.5, 0.06);
  const cover = screen("cover-display", -0.5, -0.06, true);
  left.add(innerLeft, cover);
  right.add(innerRight);
  for (const [group, x] of [
    [left, -0.5],
    [right, 0.5],
  ] as const) {
    const body = new Mesh(new BoxGeometry(1, 2, 0.1), new MeshBasicMaterial());
    body.geometry.translate(x, 0, 0);
    group.add(body);
  }
  asset.add(left, right);
  const scene = createDuoScene(asset, { 1: new Texture(), 3: new Texture() });
  return { scene, camera: camera(), left, right, innerLeft, innerRight };
}

test("leaves fold opposite ways about the hinge and the inner UVs stay continuous", () => {
  const { scene, left, right, innerLeft, innerRight } = fixture();
  scene.setAngle(90);
  close(left.rotation.y, Math.PI / 4);
  close(right.rotation.y, -Math.PI / 4);
  assert.equal(Math.max(...uvs(innerLeft, "x")), 0.5);
  assert.equal(Math.min(...uvs(innerRight, "x")), 0.5);
  scene.dispose();
});

test("rest views come from the hinged display planes, independent of the inspection orbit", () => {
  const { scene } = fixture();
  scene.setAngle(90);
  const frames = scene.restFrames(3);
  assert.deepEqual(
    frames.map((frame) => frame.face),
    ["inside", "left", "right"],
  );
  assert.ok(frames[1]!.normal.x > 0.5);
  assert.ok(frames[2]!.normal.x < -0.5);
  scene.root.rotation.set(0.5, 1.2, -0.7);
  scene.root.position.set(3, -2, 1);
  const rotated = scene.restFrames(3);
  for (let index = 0; index < frames.length; index++) {
    assert.ok(rotated[index]!.normal.distanceTo(frames[index]!.normal) < 1e-6);
    assert.ok(rotated[index]!.center.distanceTo(frames[index]!.center) < 1e-6);
  }
  // Leaf views exist only for a useful open fold.
  scene.setAngle(180);
  assert.deepEqual(
    scene.restFrames(3).map((frame) => frame.face),
    ["inside"],
  );
  assert.deepEqual(
    scene.restFrames(1).map((frame) => frame.face),
    ["cover"],
  );
  scene.dispose();
});

test("input maps through hardware mounting, only on the active display, and a drag stays on its plane", () => {
  const { scene, camera: view, innerLeft } = fixture();
  scene.setAngle(180);
  const screen: DeviceScreenSize = { width: 2007, height: 2853, orientation: "portrait", screenId: 3 };
  const key = duoDisplayKey(screen);
  scene.root.updateMatrixWorld();
  const world = innerLeft.localToWorld(new Vector3(-0.5, -0.5, 0.06)).project(view);
  const x = (world.x + 1) / 2;
  const y = (1 - world.y) / 2;
  const hit = scene.screenPoint(x, y, view, screen, key);
  close(hit!.x, 0.75, 1e-6);
  close(hit!.y, 0.75, 1e-6);
  const cover = { ...screen, screenId: 1 };
  assert.equal(scene.screenPoint(x, y, view, cover, duoDisplayKey(cover)), null, "inactive display");
  assert.equal(scene.screenPoint(x, y, view, screen, "old"), null, "stale display");
  assert.notEqual(scene.screenPoint(x, y, view, screen, key), null);
  // A captured drag extends past the edge on the plane it started on.
  assert.ok(scene.screenPoint(x, 1.1, view, screen, key, true)!.x > 1);
  assert.deepEqual(duoRawPoint(1, 0.2, 0.7), { x: 0.2, y: 0.7 });
  scene.dispose();
});

const insideFrame = { face: "inside" as const, normal: new Vector3(0, 0, 1), up: new Vector3(0, 1, 0), center: new Vector3() };
const rotation = (x: number, y: number, z = 0) =>
  new Quaternion().setFromAxisAngle(new Vector3(x, y, z).normalize(), Math.hypot(x, y, z));

test("a leaf-focused seated view wins when it is closer than the middle of the fold", () => {
  const leaf = { face: "right" as const, normal: new Vector3(0.6, 0, 0.8), up: new Vector3(0, 1, 0), center: new Vector3(1, 0, 0) };
  const candidates = duoViewSnaps([insideFrame, leaf], 3);
  const seat = candidates.find((candidate) => candidate.face === "right" && candidate.orientation === "portrait")!;
  const released = seat.rotation.clone().premultiply(rotation(0.04, 0.05));
  const chosen = nearestDuoView(released, candidates)!;
  assert.equal(chosen.face, "right");
  assert.equal(chosen.orientation, "portrait");
  assert.equal(chosen.center.x, 1);
});

test("a seated view shows the base, and yaw never turns either inner display away", () => {
  const folded = [
    insideFrame,
    ...(["left", "right"] as const).map((face) => ({
      face,
      normal: new Vector3(face === "left" ? Math.SQRT1_2 : -Math.SQRT1_2, 0, Math.SQRT1_2),
      up: new Vector3(0, 1, 0),
      center: new Vector3(face === "left" ? -1 : 1, 0, 0),
    })),
  ];
  const candidates = duoViewSnaps(folded, 3);
  assert.equal(candidates.filter((candidate) => candidate.face === "right").length, 1);
  for (const candidate of candidates) {
    for (const frame of folded.slice(1)) assert.ok(frame.normal.clone().applyQuaternion(candidate.rotation).z > 0.2);
    const side = candidate.rotation.clone().premultiply(rotation(0, 1.5));
    const chosen = nearestDuoView(side, [candidate])!;
    for (const frame of folded.slice(1)) assert.ok(frame.normal.clone().applyQuaternion(chosen.rotation).z > 0.02);
  }
});
