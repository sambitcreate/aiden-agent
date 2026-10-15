// Parses the bundled T3 device models with three's real GLTFLoader, so a
// replaced or broken file fails here rather than in the Simulator tab.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Box3, Mesh, Texture, Vector3 } from "three";
import { createDuoScene } from "./duo-scene.js";
import { createModelPhoneScene, parseDeviceModel } from "./model-scene.js";
import type { DeviceAssetModelId } from "./model-source.js";
import { phoneDisplayLayout } from "./phone-scene.js";

const MODELS = new URL("../../assets/devices/models/", import.meta.url);
const read = (file: string) => {
  const bytes = readFileSync(new URL(file, MODELS));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

interface Sources {
  author: string;
  assetLicense: string;
  models: Array<{ id: string; file: string; sourceUrl: string; sourceSha256: string }>;
}

/**
 * Node has no image decoder: GLTFLoader reports each texture it cannot decode
 * and carries on with the geometry, which is what these tests check. It reads
 * `self.URL` for embedded images, so `self` is aliased for the parse.
 */
async function parseQuietly(file: string) {
  const scope = globalThis as { self?: unknown };
  const hadSelf = "self" in scope;
  const error = console.error;
  const warn = console.warn;
  console.error = () => undefined;
  console.warn = () => undefined;
  if (!hadSelf) scope.self = globalThis;
  try {
    return await parseDeviceModel(read(file), file);
  } finally {
    if (!hadSelf) delete scope.self;
    console.error = error;
    console.warn = warn;
  }
}

test("every bundled model is recorded with its source and provenance", () => {
  const sources = JSON.parse(readFileSync(new URL("sources.json", MODELS), "utf8")) as Sources;
  assert.equal(sources.author, "Apple Inc.");
  assert.match(sources.assetLicense, /No .*redistribution license/u);
  const ids: Array<DeviceAssetModelId | "ipad-pro-13-m5-magic-keyboard"> = [
    "iphone-18-pro",
    "iphone-18-pro-max",
    "ipad-pro-13-m5",
    "ipad-pro-13-m5-magic-keyboard",
    "iphone-duo",
  ];
  assert.deepEqual(
    sources.models.map((model) => model.id).sort(),
    [...ids].sort(),
  );
  for (const model of sources.models) {
    assert.equal(model.file, `${model.id}.glb`);
    assert.match(model.sourceUrl, /^https:\/\/www\.apple\.com\//u);
    assert.match(model.sourceSha256, /^[0-9a-f]{64}$/u);
    assert.ok(read(model.file).byteLength > 1024, model.file);
  }
});

for (const id of ["iphone-18-pro", "iphone-18-pro-max", "ipad-pro-13-m5"] as const) {
  test(`${id}.glb parses and meets the normalized display contract`, async () => {
    const model = await parseQuietly(`${id}.glb`);
    const texture = new Texture();
    const phone = createModelPhoneScene(model.asset, texture, phoneDisplayLayout(null, 1206, 2622));
    const display = new Box3().setFromObject(model.asset.getObjectByName("device-screen")!).getSize(new Vector3());
    assert.ok(Math.abs(display.y - 2.2) < 1e-3, `display height ${display.y}`);
    // The body surrounds the display.
    assert.ok(phone.width > display.x && phone.height > display.y);
    phone.dispose();
    model.dispose();
  });
}

test("the Magic Keyboard accessory parses with finite, non-empty bounds", async () => {
  const model = await parseQuietly("ipad-pro-13-m5-magic-keyboard.glb");
  const bounds = new Box3().setFromObject(model.asset);
  assert.equal(bounds.isEmpty(), false);
  assert.ok([...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite));
  model.dispose();
});

test("iphone-duo.glb exposes the hinge rig and three displays, and folds them face to face", async () => {
  const model = await parseQuietly("iphone-duo.glb");
  for (const name of ["left-half", "right-half"]) assert.ok(model.asset.getObjectByName(name), name);
  const left = model.asset.getObjectByName("left-half")!;
  const right = model.asset.getObjectByName("right-half")!;
  const display = (name: string) => {
    const mesh = model.asset.getObjectByName(name);
    assert.ok(mesh instanceof Mesh, name);
    return mesh;
  };
  const cover = display("cover-display");
  const innerLeft = display("inner-display-left");
  const innerRight = display("inner-display-right");
  const under = (mesh: Mesh, group: typeof left) => {
    let parent = mesh.parent;
    while (parent && parent !== group) parent = parent.parent;
    return parent === group;
  };
  assert.ok(under(innerLeft, left) && under(cover, left) && under(innerRight, right));
  const scene = createDuoScene(model.asset, { 1: new Texture(), 3: new Texture() });
  const normal = (mesh: Mesh) =>
    new Vector3().fromBufferAttribute(mesh.geometry.getAttribute("normal"), 0).transformDirection(mesh.matrixWorld);
  scene.setAngle(180);
  scene.root.updateMatrixWorld(true);
  assert.ok(normal(innerLeft).dot(normal(innerRight)) > 0.99, "open: both inner halves face the same way");
  scene.setAngle(0);
  scene.root.updateMatrixWorld(true);
  assert.ok(normal(innerLeft).dot(normal(innerRight)) < -0.99, "closed: the inner halves face each other");
  assert.equal(scene.restFrames(1)[0]?.face, "cover");
  scene.dispose();
  model.dispose();
});
