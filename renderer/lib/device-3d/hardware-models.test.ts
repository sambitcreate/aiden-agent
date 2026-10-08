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
  Texture,
  Vector3,
} from "three";
import { buildDuoModel } from "./duo-model.js";
import { buildHandsetModel, DISPLAY_HEIGHT, displaySize, HANDSET_SPECS, modelGeometries } from "./hardware-models.js";
import { isDuoDevice, resolveDeviceModelId } from "./model-registry.js";
import { createModelPhoneScene, disposeDeviceModel } from "./model-scene.js";
import { phoneDisplayLayout } from "./phone-scene.js";

const close = (actual: number, expected: number, epsilon: number, label = "") =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label} ${actual} is not within ${epsilon} of ${expected}`);

// Adapted from t3code model.test.ts @ a6ec88f7 (MIT).
test("only exact simulator names that share a modelled chassis get a hardware model", () => {
  assert.equal(resolveDeviceModelId("ios", "iPhone 17 Pro"), "iphone-pro");
  assert.equal(resolveDeviceModelId("ios", "iPhone 18 Pro"), "iphone-pro");
  assert.equal(resolveDeviceModelId("ios", "iPhone 18 Pro Max"), "iphone-pro-max");
  assert.equal(resolveDeviceModelId("ios", "iPad Pro 13-inch (M5)"), "ipad-pro-13");
  assert.equal(resolveDeviceModelId("ios", "iPad Pro 13-inch (M4)"), "ipad-pro-13");
  assert.equal(resolveDeviceModelId("ios", "iPhone Duo"), "iphone-duo");
  for (const name of ["iPhone 16 Pro", "iPhone 18", "iPhone Air", "iPad Pro 11-inch (M5)", "Pixel_10_Pro", "My iPhone 17 Pro"]) {
    assert.equal(resolveDeviceModelId("ios", name), null, name);
  }
  assert.equal(resolveDeviceModelId("android", "iPhone 18 Pro"), null);
  // A renamed hinged simulator is still a Duo; a hinge is never inferred on Android.
  assert.equal(isDuoDevice("ios", "Julius", { supportsHingeAngle: true }), true);
  assert.equal(isDuoDevice("ios", "iPhone Duo", null), true);
  assert.equal(isDuoDevice("ios", "iPhone 17 Pro", { supportsHingeAngle: false }), false);
  assert.equal(isDuoDevice("android", "Pixel Fold", { supportsHingeAngle: true }), false);
});

for (const id of ["iphone-pro", "iphone-pro-max", "ipad-pro-13"] as const) {
  test(`${id} meets the normalized model contract with its spec-sheet proportions`, () => {
    const spec = HANDSET_SPECS[id];
    const asset = buildHandsetModel(id);
    const texture = new Texture();
    const layout = phoneDisplayLayout(null, spec.pixels.width, spec.pixels.height);
    const phone = createModelPhoneScene(asset, texture, layout);
    const screen = asset.getObjectByName("device-screen") as Mesh;
    const screenBounds = new Box3().setFromObject(screen);
    const screenSize = screenBounds.getSize(new Vector3());
    close(screenSize.y, DISPLAY_HEIGHT, 1e-3, "display height");
    // The display has the framebuffer's aspect, so live pixels are never stretched.
    close(screenSize.x / screenSize.y, spec.pixels.width / spec.pixels.height, 2e-3, "display aspect");
    // The body has the published width, height and depth, at the display's scale.
    const scale = DISPLAY_HEIGHT / displaySize(spec).height;
    const front = new Box3();
    asset.traverse((object) => {
      if (object instanceof Mesh && object.name.endsWith("-frame")) front.expandByObject(object);
    });
    const body = front.getSize(new Vector3());
    close(body.x, spec.body.width * scale, 0.01, "body width");
    close(body.y, spec.body.height * scale, 0.01, "body height");
    close(body.z, spec.body.depth * scale, 0.01, "body depth");
    // Keys protrude past the frame on the sides that carry them.
    const all = new Box3().setFromObject(asset);
    const sides = new Set(spec.buttons.map((button) => button.side));
    if (sides.has("right")) assert.ok(all.max.x > front.max.x + 1e-3, "right keys");
    if (sides.has("left")) assert.ok(all.min.x < front.min.x - 1e-3, "left keys");
    // The camera stands proud of the back; nothing stands proud of the display.
    assert.ok(all.min.z < front.min.z - 1e-3, "rear camera");
    assert.ok(screenBounds.max.z > front.max.z, "display above the frame");
    assert.ok(all.max.z - screenBounds.max.z < 0.005, "only thin cut-outs sit above the display");
    phone.dispose();
    disposeDeviceModel(asset);
    texture.dispose();
  });
}

test("a touch through the Dynamic Island still reaches the framebuffer under it", () => {
  const asset = buildHandsetModel("iphone-pro");
  const texture = new Texture();
  const phone = createModelPhoneScene(asset, texture, phoneDisplayLayout({ width: 1206, height: 2622, orientation: "portrait" }, 1206, 2622));
  const camera = new PerspectiveCamera(32, 1, 0.1, 30);
  camera.position.z = 6;
  camera.updateMatrixWorld(true);
  phone.root.updateMatrixWorld(true);
  const islandTop = 2.2 / 2 - (1.9 / displaySize(HANDSET_SPECS["iphone-pro"]).height) * 2.2;
  const point = new Vector3(0, islandTop - 0.03, 0.08).project(camera);
  const hit = phone.screenPoint((point.x + 1) / 2, (1 - point.y) / 2, camera);
  assert.ok(hit, "the island does not swallow the touch");
  close(hit.x, 0.5, 0.01);
  assert.ok(hit.y < 0.05 && hit.y > 0);
  phone.dispose();
  disposeDeviceModel(asset);
});

test("models stay light: a few draw calls each, a bounded vertex budget, and full release", () => {
  for (const build of [() => buildHandsetModel("iphone-pro"), () => buildHandsetModel("iphone-pro-max"), () => buildHandsetModel("ipad-pro-13"), buildDuoModel]) {
    const asset = build();
    let meshes = 0;
    let vertices = 0;
    asset.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      meshes++;
      vertices += object.geometry.getAttribute("position").count;
    });
    assert.ok(meshes <= 24, `${asset.name}: ${meshes} meshes`);
    assert.ok(vertices < 60_000, `${asset.name}: ${vertices} vertices`);
    let released = 0;
    const geometries = modelGeometries(asset);
    for (const geometry of geometries) geometry.addEventListener("dispose", () => void released++);
    disposeDeviceModel(asset);
    assert.equal(released, geometries.length);
  }
});

// Adapted from t3code modelScene.test.ts @ a6ec88f7 (MIT).
function fixtureAsset() {
  const root = new Group();
  const body = new Mesh(new BoxGeometry(1.15, 2.3, 0.1), new MeshBasicMaterial());
  body.position.z = -0.02;
  const screen = new Mesh(new PlaneGeometry(1, 2.2), new MeshBasicMaterial());
  screen.geometry.translate(0, 0, 0.043);
  screen.name = "device-screen";
  root.add(body, screen);
  return { root, screen, body };
}

for (const orientation of ["portrait", "landscape_left", "landscape_right", "portrait_upside_down"] as const) {
  test(`a model keeps its geometry while mapping input and framebuffer UVs in ${orientation}`, () => {
    const { root, screen } = fixtureAsset();
    const texture = new Texture();
    const original = screen.material;
    screen.geometry.deleteAttribute("uv");
    const phone = createModelPhoneScene(root, texture, phoneDisplayLayout(null, 1206, 2622));
    const layout = phoneDisplayLayout({ width: 1206, height: 2622, orientation }, 1206, 2622);
    phone.setDisplay(texture, layout);
    phone.root.rotation.set(0.2, -0.3, 0, "YXZ");
    phone.orientation.rotation.z = layout.rotation;
    phone.root.updateMatrixWorld(true);
    const camera = new PerspectiveCamera(32, 1, 0.1, 30);
    camera.position.z = 6;
    camera.updateMatrixWorld(true);
    const point = phone.orientation.localToWorld(new Vector3(-0.25, -0.55, 0.043)).project(camera);
    const hit = phone.screenPoint((point.x + 1) / 2, (1 - point.y) / 2, camera);
    const expected =
      orientation === "landscape_left"
        ? [0.25, 0.25]
        : orientation === "landscape_right"
          ? [0.75, 0.75]
          : orientation === "portrait_upside_down"
            ? [0.75, 0.25]
            : [0.25, 0.75];
    assert.ok(hit);
    close(hit.x, expected[0]!, 1e-3);
    close(hit.y, expected[1]!, 1e-3);
    const geometry = screen.geometry;
    phone.setDisplay(texture, phoneDisplayLayout({ width: 2622, height: 1206, orientation: "landscape_left" }, 2622, 1206));
    assert.equal(screen.geometry, geometry);
    const position = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    for (let i = 0; i < position.count; i++) {
      close(uv.getX(i), position.getY(i) / 2.2 + 0.5, 1e-6);
      close(uv.getY(i), 0.5 - position.getX(i), 1e-6);
    }
    phone.dispose();
    assert.equal(screen.material, original);
    disposeDeviceModel(root);
  });
}

test("a model rejects rear touches and leaves the borrowed stream texture alone", () => {
  const { root, screen } = fixtureAsset();
  const texture = new Texture();
  let borrowedDisposed = false;
  texture.addEventListener("dispose", () => (borrowedDisposed = true));
  const phone = createModelPhoneScene(root, texture, phoneDisplayLayout(null, 1206, 2622));
  const camera = new PerspectiveCamera(32, 1, 0.1, 30);
  camera.position.z = 6;
  phone.root.rotation.y = Math.PI;
  assert.equal(phone.screenPoint(0.5, 0.5, camera), null);
  phone.dispose();
  assert.equal((screen.material as MeshBasicMaterial).map, null);
  disposeDeviceModel(root);
  assert.equal(borrowedDisposed, false);
});

test("a model with a missing or unnormalized display is refused before its materials change", () => {
  const { root, screen } = fixtureAsset();
  const original = screen.material;
  const texture = new Texture();
  screen.geometry.scale(1, 2, 1);
  assert.throws(() => createModelPhoneScene(root, texture, phoneDisplayLayout(null, 1206, 2622)), /not normalized/u);
  assert.equal(screen.material, original);
  screen.geometry.scale(1, 0.5, 1);
  root.rotation.y = Math.PI;
  assert.throws(() => createModelPhoneScene(root, texture, phoneDisplayLayout(null, 1206, 2622)), /not normalized/u);
  screen.name = "wrong-screen";
  assert.throws(() => createModelPhoneScene(root, texture, phoneDisplayLayout(null, 1206, 2622)), /one device-screen/u);
  disposeDeviceModel(root);
});
