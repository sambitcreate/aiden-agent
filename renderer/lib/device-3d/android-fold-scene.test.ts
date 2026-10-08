// Adapted from t3code packages/client-runtime/src/device/androidFoldScene.test.ts @ a6ec88f7 (MIT).
import assert from "node:assert/strict";
import test from "node:test";
import { Box3, Mesh, PerspectiveCamera, Texture, Vector3 } from "three";
import { createAndroidFoldScene, DEFAULT_FOLD_INNER_ASPECT, isFoldInnerAspect } from "./android-fold-scene.js";
import { phoneDisplayLayout } from "./phone-scene.js";

const close = (actual: number, expected: number, epsilon: number) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);

test("one half turns about the hinge while both screen halves stay joined at the crease", () => {
  const texture = new Texture();
  const scene = createAndroidFoldScene(
    texture,
    phoneDisplayLayout({ width: 2200, height: 1840, orientation: "landscape_left" }, 2200, 1840),
    180,
  );
  const moving = scene.orientation.children[0]!;
  const fixed = scene.orientation.children[1]!;
  const openWidth = new Box3().setFromObject(scene.root).getSize(new Vector3()).x;
  const leftScreen = scene.root.getObjectByName("left-inner-screen") as Mesh;
  const rightScreen = scene.root.getObjectByName("right-inner-screen") as Mesh;
  leftScreen.geometry.computeBoundingBox();
  rightScreen.geometry.computeBoundingBox();
  assert.ok(rightScreen.geometry.boundingBox!.min.x - leftScreen.geometry.boundingBox!.max.x < 0.01);
  const continuous = scene.root.getObjectByName("continuous-inner-screen") as Mesh;
  const positions = continuous.geometry.getAttribute("position");
  assert.notEqual(continuous.geometry.index, null);
  assert.ok(Array.from({ length: positions.count }, (_, i) => positions.getX(i)).includes(0));
  scene.setAngle(90);
  close(moving.rotation.y, Math.PI / 2, 1e-6);
  assert.equal(fixed.rotation.y, 0);
  scene.setAngle(0);
  const closedWidth = new Box3().setFromObject(scene.root).getSize(new Vector3()).x;
  assert.ok(closedWidth < openWidth * 0.7);
  assert.equal(scene.root.getObjectByName("cover-screen")?.visible, true);
  scene.dispose();
  texture.dispose();
});

test("touches on each open half and on the closed cover map to the live frame", () => {
  const texture = new Texture();
  const scene = createAndroidFoldScene(texture, phoneDisplayLayout(null, 2200, 1840), 180);
  const camera = new PerspectiveCamera(32, 1, 0.1, 30);
  camera.position.z = 6;
  camera.updateMatrixWorld(true);
  const project = (x: number) => {
    const point = new Vector3(x, 0, 0.041).project(camera);
    return scene.screenPoint((point.x + 1) / 2, (1 - point.y) / 2, camera);
  };
  close(project(-0.52)!.x, 0.25, 0.05);
  close(project(0.52)!.x, 0.75, 0.05);
  assert.equal(scene.screenPoint(0.99, 0.5, camera, true)!.x, 1);
  scene.setAngle(0);
  close(project(0.52)!.x, 0.5, 0.05);
  scene.dispose();
  texture.dispose();
});

test("the inner display takes the raw frame's shape, portrait or landscape; cover frames never retune it", () => {
  const texture = new Texture();
  for (const [width, height] of [
    [2076, 2152],
    [2208, 1840],
  ] as const) {
    const scene = createAndroidFoldScene(texture, phoneDisplayLayout(null, width, height), 180, width / height);
    const screen = scene.root.getObjectByName("continuous-inner-screen") as Mesh;
    screen.geometry.computeBoundingBox();
    const size = screen.geometry.boundingBox!.getSize(new Vector3());
    close(size.x / size.y, width / height, 0.01);
    scene.dispose();
  }
  assert.equal(isFoldInnerAspect(DEFAULT_FOLD_INNER_ASPECT), true);
  // Phone-shaped cover frames, upright or rotated, are not inner displays.
  assert.equal(isFoldInnerAspect(1080 / 2424), false);
  assert.equal(isFoldInnerAspect(2424 / 1080), false);
  assert.equal(isFoldInnerAspect(Number.NaN), false);
  texture.dispose();
});
