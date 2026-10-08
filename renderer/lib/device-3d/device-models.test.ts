// Name matching and model-slot tests adapted from t3code packages/client-runtime/src/device/model.test.ts
// @ a6ec88f7 (MIT); the GLB loading, fallback and accessory tests are Aiden's own.
import assert from "node:assert/strict";
import test from "node:test";
import { BoxGeometry, Mesh, PlaneGeometry, type Object3D } from "three";
import { createDuoViewer } from "./duo-viewer.js";
import { loadDeviceModel, parseDeviceModel, type LoadedDeviceModel } from "./model-scene.js";
import {
  createDeviceModelSlot,
  deviceHasKeyboardAccessory,
  resolveDeviceAssetModelId,
  type DeviceAccessorySource,
  type DeviceAssetSource,
  type DeviceModelSource,
} from "./model-source.js";
import { createPhoneViewer } from "./phone-viewer.js";
import { createTestRuntime, minimalGlb, testCanvas } from "./viewer-test-support.js";

const settle = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
};
const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

const PRO: DeviceModelSource = { id: "iphone-18-pro", url: "/pro.glb" };
const MAX: DeviceModelSource = { id: "iphone-18-pro-max", url: "/max.glb" };
const IPAD: DeviceModelSource = { id: "ipad-pro-13-m5", url: "/ipad.glb" };
const DUO: DeviceModelSource = { id: "iphone-duo", url: "/duo.glb" };
const KEYBOARD: DeviceAccessorySource = { id: "ipad-pro-13-m5-magic-keyboard", modelId: "ipad-pro-13-m5", url: "/keyboard.glb" };

test("only exact supported hardware gets a bundled model, including the iPad's size and generation", () => {
  assert.equal(resolveDeviceAssetModelId("ios", "iPhone 18 Pro"), "iphone-18-pro");
  assert.equal(resolveDeviceAssetModelId("ios", "iPhone 18 Pro Max"), "iphone-18-pro-max");
  assert.equal(resolveDeviceAssetModelId("ios", "iPhone Duo"), "iphone-duo");
  assert.equal(resolveDeviceAssetModelId("ios", "iPad Pro 13-inch (M5)"), "ipad-pro-13-m5");
  for (const name of ["iPhone 17 Pro", "iPhone 18", "iPad Pro 11-inch (M5)", "iPad Pro 13-inch (M4)", "Pixel_10_Pro", "My iPhone 18 Pro"]) {
    assert.equal(resolveDeviceAssetModelId("ios", name), null, name);
  }
  assert.equal(resolveDeviceAssetModelId("android", "iPhone 18 Pro"), null);
  assert.equal(deviceHasKeyboardAccessory("ipad-pro-13-m5"), true);
  assert.equal(deviceHasKeyboardAccessory("iphone-18-pro"), false);
  assert.equal(deviceHasKeyboardAccessory(null), false);
});

function deferredLoads<T>() {
  const pending: Array<{ source: DeviceAssetSource; signal: AbortSignal; resolve(model: T): void; reject(error: Error): void }> = [];
  const load = (source: DeviceAssetSource, signal: AbortSignal) =>
    new Promise<T>((resolve, reject) => pending.push({ source, signal, resolve, reject }));
  return { pending, load };
}

function slotFixture() {
  const loads = deferredLoads<{ dispose: () => void }>();
  const installs: unknown[] = [];
  let installError: Error | null = null;
  const slot = createDeviceModelSlot<{ dispose: () => void }>({
    load: loads.load,
    install: (model) => {
      if (model && installError) {
        const error = installError;
        installError = null;
        throw error;
      }
      installs.push(model);
    },
  });
  return { slot, pending: loads.pending, installs, failNextInstall: (error: Error) => (installError = error) };
}

const disposable = () => {
  let disposed = 0;
  return { dispose: () => void disposed++, disposed: () => disposed };
};

test("a superseded download is cancelled and a late decoded model is released without being installed", async () => {
  const { slot, pending, installs } = slotFixture();
  slot.set(PRO);
  slot.set({ ...PRO });
  assert.equal(pending.length, 1);
  slot.set(MAX);
  assert.equal(pending[0]!.signal.aborted, true);
  const latest = disposable();
  const stale = disposable();
  pending[1]!.resolve(latest);
  await settle();
  pending[0]!.resolve(stale);
  await settle();
  assert.deepEqual(installs, [latest]);
  assert.equal(stale.disposed(), 1);
  slot.set(null);
  assert.equal(last(installs), null);
  assert.equal(latest.disposed(), 1);
  slot.dispose();
  assert.equal(latest.disposed(), 1);
});

test("a failed request keeps the fallback, and results that finish after teardown are released", async () => {
  const { slot, pending, installs } = slotFixture();
  slot.set(PRO);
  pending[0]!.reject(new Error("offline"));
  await settle();
  assert.deepEqual(installs, []);
  slot.set(MAX);
  slot.dispose();
  assert.equal(pending[1]!.signal.aborted, true);
  const late = disposable();
  pending[1]!.resolve(late);
  await settle();
  assert.equal(late.disposed(), 1);
  assert.deepEqual(installs, []);
});

test("a failed source can be retried, and a model the scene rejects is released and the fallback restored", async () => {
  const { slot, pending, installs, failNextInstall } = slotFixture();
  slot.set(PRO);
  pending[0]!.reject(new Error("offline"));
  await settle();
  slot.set({ ...PRO });
  assert.equal(pending.length, 2);
  failNextInstall(new Error("invalid display"));
  const rejected = disposable();
  pending[1]!.resolve(rejected);
  await settle();
  assert.equal(rejected.disposed(), 1);
  assert.equal(last(installs), null);
  slot.set({ ...PRO });
  const recovered = disposable();
  pending[2]!.resolve(recovered);
  await settle();
  assert.equal(last(installs), recovered);
  slot.dispose();
  assert.equal(recovered.disposed(), 1);
});

/** A normalized phone body: a display exactly 2.2 tall, centred, facing +Z. */
function phoneGlb() {
  const screen = new PlaneGeometry(1, 2.2);
  screen.translate(0, 0, 0.043);
  const body = new BoxGeometry(1.15, 2.3, 0.1);
  body.translate(0, 0, -0.02);
  return minimalGlb([
    { name: "body", geometry: body },
    { name: "device-screen", geometry: screen },
  ]);
}

test("a bundled GLB is fetched, parsed by three's loader, and its named display survives the round trip", async () => {
  const fetched: string[] = [];
  const model = await loadDeviceModel(PRO, new AbortController().signal, async (url) => {
    fetched.push(url);
    return new Response(phoneGlb());
  });
  assert.deepEqual(fetched, ["/pro.glb"]);
  const screen = model.asset.getObjectByName("device-screen") as Mesh | undefined;
  assert.ok(screen instanceof Mesh);
  screen.geometry.computeBoundingBox();
  assert.ok(Math.abs(screen.geometry.boundingBox!.max.y - 1.1) < 1e-6);
  let released = 0;
  model.asset.traverse((object) => {
    if (object instanceof Mesh) object.geometry.addEventListener("dispose", () => void released++);
  });
  model.dispose();
  assert.equal(released, 2);
  await assert.rejects(
    loadDeviceModel(PRO, new AbortController().signal, async () => new Response("missing", { status: 404 })),
    /404/u,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(parseDeviceModel(phoneGlb(), "/pro.glb", aborted.signal));
});

function phoneFixture(options: { asset?: DeviceModelSource | null; accessory?: DeviceAccessorySource | null } = {}) {
  const harness = createTestRuntime();
  const loads = deferredLoads<LoadedDeviceModel>();
  const errors: unknown[] = [];
  let unavailable = 0;
  const viewer = createPhoneViewer({
    canvas: testCanvas(),
    source: { width: 1206, height: 2622 } as HTMLCanvasElement,
    onUnavailable: () => void unavailable++,
    model: "iphone-pro",
    asset: options.asset ?? null,
    accessory: options.accessory ?? null,
    loadModel: loads.load,
    onModelError: (cause) => void errors.push(cause),
    runtime: harness.runtime,
  });
  viewer.resize(400, 700, 2);
  viewer.frameUpdated();
  harness.draw();
  const root = () => last(harness.renderers[0]!.frames)!.root!;
  return { ...harness, viewer, pending: loads.pending, errors, unavailable: () => unavailable, root };
}

/** Parses a minimal GLB as the real loader would hand it over. */
const parsed = async (data: ArrayBuffer) => parseDeviceModel(data, "/model.glb");
const contains = (root: Object3D, asset: Object3D) => {
  let found = false;
  root.traverse((object) => (found ||= object === asset));
  return found;
};

test("the procedural body shows at once, and the bundled GLB replaces it in place once it loads", async () => {
  const { viewer, draw, pending, root, renderers, errors } = phoneFixture({ asset: PRO });
  const procedural = root();
  assert.ok(procedural.getObjectByName("device-screen"), "the procedural body has its own live display");
  assert.equal(pending[0]!.source, PRO);
  const glb = await parsed(phoneGlb());
  pending[0]!.resolve(glb);
  await settle();
  draw();
  assert.ok(root() !== procedural, "a new body is drawn");
  assert.ok(contains(root(), glb.asset), "the GLB body is drawn");
  // T3's bodies are lit by its lights alone; room reflections would grey their glossy black parts.
  assert.equal(last(renderers[0]!.frames)!.scene.environment, null);
  viewer.setAsset(null);
  draw();
  assert.ok(last(renderers[0]!.frames)!.scene.environment, "the procedural body gets its reflections back");
  assert.equal(renderers.length, 1);
  assert.deepEqual(errors, []);
  viewer.dispose();
});

test("a GLB that fails to load or validate leaves the procedural body, not the flat screen", async () => {
  const failed = phoneFixture({ asset: PRO });
  const procedural = failed.root();
  failed.pending[0]!.reject(new Error("offline"));
  await settle();
  failed.draw();
  assert.ok(failed.root() === procedural, "the procedural body stays");
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.unavailable(), 0);
  failed.viewer.dispose();

  // A body without a normalized display is refused before the visible one is released.
  const invalid = phoneFixture({ asset: PRO });
  const before = invalid.root();
  const unnormalized = new PlaneGeometry(1, 4);
  invalid.pending[0]!.resolve(await parsed(minimalGlb([{ name: "device-screen", geometry: unnormalized }])));
  await settle();
  invalid.draw();
  assert.ok(invalid.root() === before, "the visible body stays");
  assert.match(String(invalid.errors[0]), /not normalized/u);
  assert.equal(invalid.unavailable(), 0);
  invalid.viewer.dispose();
});

test("the Magic Keyboard attaches only to its own model, follows the GLB body, and detaches cleanly", async () => {
  const { viewer, draw, pending, root } = phoneFixture({ asset: IPAD, accessory: KEYBOARD });
  assert.equal(pending.length, 2);
  const ipad = await parsed(phoneGlb());
  const keyboardBody = new BoxGeometry(2, 0.1, 1.4);
  const keyboard = await parsed(minimalGlb([{ name: "keyboard", geometry: keyboardBody }]));
  pending[1]!.resolve(keyboard);
  await settle();
  draw();
  // The accessory waits for the body it belongs to.
  assert.equal(contains(root(), keyboard.asset), false);
  pending[0]!.resolve(ipad);
  await settle();
  draw();
  assert.ok(contains(root(), ipad.asset) && contains(root(), keyboard.asset));
  let released = 0;
  keyboard.asset.traverse((object) => {
    if (object instanceof Mesh) object.geometry.addEventListener("dispose", () => void released++);
  });
  viewer.setAccessory(null);
  draw();
  assert.equal(contains(root(), keyboard.asset), false);
  assert.equal(released, 1);
  // Another model's accessory is ignored.
  viewer.setAsset(PRO);
  viewer.setAccessory(KEYBOARD);
  assert.equal(pending.length, 3);
  assert.equal(last(pending)!.source, PRO);
  viewer.dispose();
});

test("a GLB that loads after the viewer closed is released without being drawn", async () => {
  const { viewer, pending, renderers } = phoneFixture({ asset: MAX });
  const frames = renderers[0]!.frames.length;
  viewer.dispose();
  assert.equal(pending[0]!.signal.aborted, true);
  const late = await parsed(phoneGlb());
  let released = 0;
  late.asset.traverse((object) => {
    if (object instanceof Mesh) object.geometry.addEventListener("dispose", () => void released++);
  });
  pending[0]!.resolve(late);
  await settle();
  assert.equal(released, 2);
  assert.equal(renderers[0]!.frames.length, frames);
});

/** T3's minimal Duo rig, as a GLB: two hinge groups and three displays. */
function duoGlb() {
  const display = (x: number, z: number, rear = false) => {
    const geometry = new PlaneGeometry(1, 2);
    if (rear) geometry.rotateY(Math.PI);
    geometry.translate(x, 0, z);
    return geometry;
  };
  return minimalGlb([
    { name: "cover-display", geometry: display(-0.5, -0.05, true), group: "left-half" },
    { name: "inner-display-left", geometry: display(-0.5, 0.05), group: "left-half" },
    { name: "inner-display-right", geometry: display(0.5, 0.05), group: "right-half" },
  ]);
}

function duoFixture() {
  const harness = createTestRuntime({ reduced: true });
  const loads = deferredLoads<LoadedDeviceModel>();
  const errors: unknown[] = [];
  let unavailable = 0;
  const viewer = createDuoViewer({
    canvas: testCanvas(),
    sources: { 1: { width: 1398, height: 2034 } as HTMLCanvasElement, 3: { width: 2007, height: 2853 } as HTMLCanvasElement },
    onUnavailable: () => void unavailable++,
    asset: DUO,
    loadModel: loads.load,
    onModelError: (cause) => void errors.push(cause),
    runtime: harness.runtime,
  });
  viewer.resize(500, 700, 2);
  viewer.setScreen({ width: 2007, height: 2853, orientation: "portrait", screenId: 3, hingeAngle: 90 });
  harness.draw();
  const root = () => last(harness.renderers[0]!.frames)!.root!;
  return { ...harness, viewer, pending: loads.pending, errors, unavailable: () => unavailable, root };
}

test("the bundled Duo GLB takes over the hinge from the procedural body at the same fold", async () => {
  const { viewer, draw, pending, root, errors } = duoFixture();
  assert.ok(root().getObjectByName("hinge-barrel"), "the procedural Duo shows first");
  const glb = await parsed(duoGlb());
  pending[0]!.resolve(glb);
  await settle();
  draw();
  assert.ok(contains(root(), glb.asset));
  assert.ok(root().getObjectByName("hinge-barrel") === undefined, "the procedural body is gone");
  // The GLB's leaves are posed at the reported 90° fold.
  const left = glb.asset.getObjectByName("left-half")!;
  assert.ok(Math.abs(left.rotation.y - Math.PI / 4) < 1e-6);
  assert.deepEqual(errors, []);
  viewer.dispose();
});

test("a Duo GLB without the hinge rig keeps the procedural Duo, and the 3D view stays up", async () => {
  const { viewer, draw, pending, root, errors, unavailable } = duoFixture();
  const plane = new PlaneGeometry(1, 2);
  pending[0]!.resolve(await parsed(minimalGlb([{ name: "body", geometry: plane }])));
  await settle();
  draw();
  assert.ok(root().getObjectByName("hinge-barrel"));
  assert.match(String(errors[0]), /hinge groups/u);
  assert.equal(unavailable(), 0);
  viewer.dispose();
});
