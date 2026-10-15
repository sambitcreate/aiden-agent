// Adapted from t3code packages/client-runtime/src/device/duoViewer.test.ts @ a6ec88f7 (MIT).
// T3 loads its body asynchronously; Aiden builds it synchronously, so the
// loading-order cases collapse into configuration-first cases.
import assert from "node:assert/strict";
import test from "node:test";
import { Euler, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, Vector3 } from "three";
import type { DeviceScreenSize } from "../device-stream.js";
import { createDuoViewer, DUO_BLANK_PROBE_MS, DUO_HANDOFF_TIMEOUT_MS } from "./duo-viewer.js";
import { createTestRuntime, testCanvas } from "./viewer-test-support.js";

/** The newest entry. Equivalent to `.at(-1)`, which the ES2021 lib lacks. */
const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

const close = (actual: number, expected: number, epsilon = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);

/** T3's minimal rig: two leaves, three displays, nothing else. */
function asset() {
  const group = new Group();
  for (const [name, names] of [
    ["left-half", ["cover-display", "inner-display-left"]],
    ["right-half", ["inner-display-right"]],
  ] as const) {
    const leaf = new Group();
    leaf.name = name;
    for (const display of names) {
      const mesh = new Mesh(new PlaneGeometry(1, 2), new MeshBasicMaterial());
      if (display === "cover-display") mesh.geometry.rotateY(Math.PI);
      mesh.geometry.translate(display === "inner-display-right" ? 0.5 : -0.5, 0, display === "cover-display" ? -0.05 : 0.05);
      mesh.name = display;
      leaf.add(mesh);
    }
    group.add(leaf);
  }
  return group;
}

function fixture(
  options: {
    reduced?: boolean;
    onPanelRequested?: (panel: 1 | 3) => void;
    blankProbe?: boolean;
    procedural?: boolean;
  } = {},
) {
  const harness = createTestRuntime({ reduced: options.reduced ?? true, blankProbe: options.blankProbe ?? false });
  const orientations: DeviceScreenSize["orientation"][] = [];
  let unavailable = 0;
  const loaded = asset();
  const viewer = createDuoViewer({
    canvas: testCanvas(),
    sources: {
      1: { width: 1398, height: 2034 } as HTMLCanvasElement,
      3: { width: 2007, height: 2853 } as HTMLCanvasElement,
    },
    onUnavailable: () => void unavailable++,
    onOrientationRequested: (orientation) => void orientations.push(orientation),
    ...(options.onPanelRequested ? { onPanelRequested: options.onPanelRequested } : {}),
    ...(options.procedural ? {} : { buildModel: () => loaded }),
    runtime: harness.runtime,
  });
  return {
    ...harness,
    viewer,
    loaded,
    orientations,
    unavailable: () => unavailable,
    state: harness.renderers[0]!,
    /** Advance the clock without drawing. */
    wait: (ms: number) => harness.setNow(harness.now() + ms),
  };
}

const cover = { width: 1398, height: 2034, screenId: 1 } as const;
const inner = { width: 2007, height: 2853, screenId: 3 } as const;
const normalOf = (mesh: Mesh) =>
  new Vector3().fromBufferAttribute(mesh.geometry.getAttribute("normal"), 0).transformDirection(mesh.matrixWorld);
const upright = new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0, "YXZ"));

test("resize coalesces with the redraw, the renderer and scene persist, and an idle view schedules nothing", () => {
  const { viewer, draw, pendingFrames, state, renderers, wait, loaded, environmentsDisposed } = fixture();
  viewer.setScreen({ ...cover, orientation: "portrait", hingeAngle: 0 });
  viewer.resize(500, 700, 2);
  draw();
  const scene = last(state.frames)!.scene;
  viewer.resize(450, 700, 2);
  viewer.resize(400, 700, 2);
  viewer.orbit(0.1, 0.04);
  assert.equal(state.blank, false);
  assert.equal(state.allocations, 1);
  assert.equal(pendingFrames(), 1);
  draw();
  assert.equal(state.allocations, 2);
  assert.equal(last(state.frames)!.scene, scene);
  assert.equal(renderers.length, 1);
  wait(1000);
  draw();
  draw();
  assert.equal(pendingFrames(), 0);
  let released = 0;
  loaded.traverse((object) => {
    if (object instanceof Mesh) object.geometry.addEventListener("dispose", () => void released++);
  });
  viewer.dispose();
  viewer.dispose();
  assert.equal(released, 3, "the body is released once");
  assert.equal(state.disposed, true);
  assert.equal(environmentsDisposed(), 1);
  assert.equal(pendingFrames(), 0);
});

test("a release view survives an app that locks orientation, freezes during contact, and stops drawing", () => {
  const { viewer, draw, state, pendingFrames, orientations, setNow } = fixture();
  const screen = { ...cover, orientation: "portrait" as const, hingeAngle: 0 };
  viewer.setScreen(screen);
  viewer.resize(500, 700, 2);
  draw();
  const initial = last(state.frames)!.rotation!.clone();
  viewer.setInteractionActive(true, "orbit");
  viewer.orbit(0, Math.PI / 3);
  draw();
  const held = last(state.frames)!.rotation!.clone();
  setNow(1000);
  viewer.frameUpdated(1);
  draw();
  assert.ok(last(state.frames)!.rotation!.angleTo(held) < 1e-6);
  assert.equal(orientations.length, 0);
  viewer.setInteractionActive(false, "orbit");
  draw();
  assert.equal(orientations.length, 1);
  const chosen = last(state.frames)!.rotation!.clone();
  assert.ok(chosen.angleTo(initial) > 1);
  // Native config confirms the sensor command, even if the app stays portrait.
  viewer.setScreen({ ...screen });
  draw();
  assert.ok(last(state.frames)!.rotation!.angleTo(chosen) < 1e-6);
  assert.equal(pendingFrames(), 0);
  viewer.resetPose();
  draw();
  assert.deepEqual(orientations, [orientations[0], "portrait"]);
  viewer.setScreen({ ...screen });
  draw();
  assert.equal(pendingFrames(), 0);
  viewer.dispose();
});

test("a hinge transition settles after a throttled frame instead of stretching time", () => {
  const { viewer, draw, pendingFrames, wait } = fixture({ reduced: false });
  viewer.resize(400, 700, 2);
  viewer.setScreen({ ...cover, orientation: "portrait", hingeAngle: 0 });
  draw();
  viewer.setScreen({ ...inner, orientation: "portrait", hingeAngle: 180 });
  wait(1000);
  draw();
  draw();
  assert.equal(pendingFrames(), 0);
  viewer.dispose();
});

test("a display handed off by native rotation is faced without another sensor rotation", () => {
  const { viewer, draw, pendingFrames, orientations, loaded, setNow } = fixture();
  viewer.resize(500, 700, 2);
  viewer.setScreen({ ...inner, orientation: "portrait", hingeAngle: 90 });
  draw();
  viewer.setInteractionActive(true, "orbit");
  viewer.orbit(0, Math.PI / 6);
  viewer.setInteractionActive(false, "orbit");
  setNow(1000);
  draw();
  assert.equal(orientations.length, 1);
  viewer.setScreen({ ...cover, orientation: "landscape_left", hingeAngle: 90 });
  draw();
  draw();
  assert.ok(normalOf(loaded.getObjectByName("cover-display") as Mesh).z > 0.45);
  assert.equal(orientations.length, 1);
  assert.equal(pendingFrames(), 0);
  viewer.dispose();
});

// Recorded from the iPhone Duo simulator by T3: a fold button across the closed
// position lets the cover report the inner display's orientation before handing off.
test("fold buttons present a book, a tablet and an upright closed phone, centred on the hinge", () => {
  const { viewer, draw, state, orientations, loaded, wait } = fixture({ reduced: false });
  viewer.resize(500, 700, 2);
  const press = (angle: number, configs: ReadonlyArray<{ orientation: "portrait" | "landscape_left"; screenId: 1 | 3 }>) => {
    viewer.setHingePreview(angle);
    configs.forEach((config, index) => {
      viewer.setScreen({ ...(config.screenId === 1 ? cover : inner), hingePose: null, ...config, hingeAngle: angle });
      // The command reply follows the first configuration.
      if (index === 0) viewer.setHingePreview(null);
      draw();
    });
    wait(5000);
    draw();
    draw();
  };
  const innerFacing = (minimum: number) => {
    for (const name of ["inner-display-left", "inner-display-right"]) {
      assert.ok(normalOf(loaded.getObjectByName(name) as Mesh).z > minimum, name);
    }
  };
  const closeUpright = () => {
    press(0, [
      { screenId: 3, orientation: "landscape_left" },
      { screenId: 1, orientation: "portrait" },
    ]);
    assert.ok(last(state.frames)!.rotation!.angleTo(upright) < 1e-5);
  };
  viewer.setScreen({ ...inner, orientation: "landscape_left", hingeAngle: 180 });
  draw();
  closeUpright();
  press(90, [
    { screenId: 1, orientation: "portrait" },
    { screenId: 1, orientation: "landscape_left" },
    { screenId: 3, orientation: "landscape_left" },
    // Election can flap back to the cover once before settling.
    { screenId: 1, orientation: "landscape_left" },
    { screenId: 3, orientation: "landscape_left" },
  ]);
  innerFacing(0.45);
  press(180, [{ screenId: 3, orientation: "landscape_left" }]);
  innerFacing(0.99);
  press(90, [{ screenId: 3, orientation: "landscape_left" }]);
  innerFacing(0.45);
  closeUpright();
  assert.equal(orientations.length, 0);
  viewer.dispose();
});

test("a fold button eases the hinge while a pinch follows the fingers", () => {
  const { viewer, draw, loaded, wait } = fixture({ reduced: false });
  viewer.resize(500, 700, 2);
  viewer.setScreen({ ...inner, orientation: "landscape_left", hingeAngle: 180 });
  draw();
  const leaf = loaded.getObjectByName("left-half")!;
  const half = ((180 - 90) * Math.PI) / 360;
  viewer.setHingePreview(90);
  wait(16);
  draw();
  assert.ok(leaf.rotation.y > 0 && leaf.rotation.y < half * 0.9);
  wait(1000);
  draw();
  close(leaf.rotation.y, half, 1e-4);
  viewer.setHingePreview(30, true);
  close(leaf.rotation.y, ((180 - 30) * Math.PI) / 360);
  viewer.dispose();
});

for (const hingePose of ["book", "laptop", "open"] as const) {
  test(`native cover readback for ${hingePose} faces the cover`, () => {
    const { viewer, draw, loaded } = fixture();
    viewer.resize(500, 700, 2);
    viewer.setScreen({ ...cover, orientation: "landscape_left", hingeAngle: hingePose === "open" ? 180 : 90, hingePose });
    draw();
    draw();
    assert.ok(normalOf(loaded.getObjectByName("cover-display") as Mesh).z > 0.45);
    viewer.dispose();
  });
}

test("orbits stay framed across folds and the fit follows the current assembly", () => {
  const { viewer, draw, state } = fixture();
  viewer.resize(380, 620, 2);
  viewer.resetPose();
  viewer.setInteractionActive(true, "orbit");
  let nearest = Infinity;
  let farthest = 0;
  for (const hingeAngle of [0, 30, 90, 127, 180]) {
    viewer.setScreen({ ...inner, orientation: "portrait", hingeAngle });
    for (let turn = 0; turn < 16; turn++) {
      viewer.orbit(0.1, turn % 2 ? -0.08 : 0.08);
      draw();
      const { camera, bounds, scene } = last(state.frames)!;
      const centre = bounds!.getCenter(new Vector3()).project(camera);
      assert.ok(Math.abs(centre.x) < 0.18 && Math.abs(centre.y) < 0.18);
      scene.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        const positions = object.geometry.getAttribute("position");
        for (let index = 0; index < positions.count; index++) {
          const point = new Vector3().fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld).project(camera);
          assert.ok(Math.abs(point.x) < 1 && Math.abs(point.y) < 1, "every vertex stays in view");
        }
      });
      nearest = Math.min(nearest, camera.position.z);
      farthest = Math.max(farthest, camera.position.z);
    }
  }
  assert.ok(farthest > nearest);
  viewer.dispose();
});

test("a pinch on a laptop keeps the lid still and blocks input until the device confirms", () => {
  const { viewer, draw, pendingFrames, loaded } = fixture();
  viewer.resize(500, 700, 2);
  viewer.setScreen({ width: 2853, height: 2007, orientation: "landscape_left", screenId: 3, hingeAngle: 90, hingePose: "laptop" });
  draw();
  const lid = loaded.getObjectByName("right-half")!;
  const presentation = lid.getWorldQuaternion(new Quaternion());
  for (const value of [127, 50, 170]) {
    viewer.setHingePreview(value, true);
    draw();
    close(loaded.getObjectByName("left-half")!.rotation.y, ((180 - value) * Math.PI) / 360);
    assert.ok(lid.getWorldQuaternion(new Quaternion()).angleTo(presentation) < 1e-5);
    assert.equal(viewer.screenPoint(0.5, 0.5), null);
    viewer.setScreen({ ...inner, orientation: "portrait", hingeAngle: value, hingePose: null });
    draw();
    assert.ok(lid.getWorldQuaternion(new Quaternion()).angleTo(presentation) < 1e-5);
  }
  viewer.setHingePreview(null, true);
  draw();
  assert.equal(pendingFrames(), 0);
  assert.ok(lid.getWorldQuaternion(new Quaternion()).angleTo(presentation) < 1e-5);
  viewer.dispose();
});

test("duplicate native configurations do not restart an animated preset", () => {
  const { viewer, draw, pendingFrames, wait } = fixture({ reduced: false });
  viewer.resize(400, 700, 2);
  viewer.setScreen({ ...cover, orientation: "portrait", hingeAngle: 0, hingePose: "closed" });
  draw();
  const next = { ...inner, orientation: "portrait" as const, hingeAngle: 180, hingePose: "open" as const };
  viewer.setScreen(next);
  wait(1000);
  viewer.setScreen(next);
  draw();
  wait(1000);
  draw();
  draw();
  assert.equal(pendingFrames(), 0);
  viewer.dispose();
});

test("Tent stands on both edges when the cover reads it back", () => {
  const { viewer, draw, loaded } = fixture();
  viewer.resize(500, 700, 2);
  viewer.setScreen({ ...cover, orientation: "portrait", hingeAngle: 80, hingePose: "tent" });
  draw();
  draw();
  // Each leaf runs from the hinge down to the surface it rests on.
  for (const [name, outward] of [
    ["left-half", -1],
    ["right-half", 1],
  ] as const) {
    const leaf = loaded.getObjectByName(name)!;
    const down = new Vector3(outward, 0, 0).applyQuaternion(leaf.getWorldQuaternion(new Quaternion()));
    assert.ok(down.y < -0.4, name);
  }
  viewer.dispose();
});

test("a separate rotation leaves Laptop and Tent and stands a closed device upright after hinge edits", () => {
  const { viewer, draw, state } = fixture();
  viewer.resize(500, 700, 2);
  viewer.resetPose();
  for (const hingePose of ["laptop", "tent"] as const) {
    viewer.setScreen({ ...cover, orientation: "landscape_left", hingeAngle: 90, hingePose });
    draw();
    viewer.setHingePreview(0);
    viewer.setScreen({ ...cover, orientation: "landscape_left", hingeAngle: 0, hingePose: null });
    viewer.setHingePreview(null);
    draw();
    // An explicit toolbar rotation ends folding ownership.
    viewer.cancelInput();
    viewer.setScreen({ ...cover, orientation: "portrait", hingeAngle: 0, hingePose: null });
    draw();
    assert.ok(last(state.frames)!.rotation!.angleTo(upright) < 1e-5);
    const bounds = last(state.frames)!.bounds!;
    assert.ok(bounds.max.y - bounds.min.y > bounds.max.x - bounds.min.x);
  }
  viewer.dispose();
});

test("snapping onto the other display asks the device to flip once and keeps the chosen view on readback", () => {
  const panels: Array<1 | 3> = [];
  const { viewer, draw, state, pendingFrames, orientations, advanceTimers } = fixture({ onPanelRequested: (panel) => void panels.push(panel) });
  viewer.resize(500, 700, 2);
  const open = { ...inner, orientation: "portrait" as const, hingeAngle: 90, supportsPhysicalOrientation: true };
  viewer.setScreen(open);
  draw();
  viewer.setInteractionActive(true, "orbit");
  viewer.orbit(Math.PI / 3, 0);
  draw();
  viewer.setInteractionActive(false, "orbit");
  draw();
  assert.deepEqual(panels, [1]);
  assert.equal(orientations.length, 0);
  // Input waits for the device to confirm the handoff.
  assert.equal(viewer.screenPoint(0.5, 0.5), null);
  const chosen = last(state.frames)!.rotation!.clone();
  // Command acknowledgement precedes sensor readback.
  viewer.setScreen({ ...open, hingePose: null });
  draw();
  assert.ok(last(state.frames)!.rotation!.angleTo(chosen) < 1e-6);
  viewer.setScreen({ ...open, width: 1398, height: 2034, screenId: 1 });
  draw();
  assert.ok(last(state.frames)!.rotation!.angleTo(chosen) < 1e-6);
  advanceTimers(DUO_HANDOFF_TIMEOUT_MS);
  assert.deepEqual(panels, [1]);
  assert.equal(pendingFrames(), 0);
  viewer.setInteractionActive(true, "orbit");
  viewer.orbit(-Math.PI / 3, 0);
  draw();
  viewer.setInteractionActive(false, "orbit");
  draw();
  assert.deepEqual(panels, [1, 3]);
  const reverse = last(state.frames)!.rotation!.clone();
  viewer.setScreen(open);
  draw();
  assert.ok(last(state.frames)!.rotation!.angleTo(reverse) < 1e-6);
  advanceTimers(DUO_HANDOFF_TIMEOUT_MS);
  draw();
  assert.equal(pendingFrames(), 0);
  assert.deepEqual(panels, [1, 3]);
  viewer.dispose();
});

test("an unconfirmed flip rolls back to the native active display after five seconds", () => {
  const panels: Array<1 | 3> = [];
  const { viewer, draw, settle, state, pendingFrames, advanceTimers } = fixture({
    onPanelRequested: (panel) => void panels.push(panel),
  });
  viewer.resize(500, 700, 2);
  viewer.setScreen({ ...inner, orientation: "portrait", hingeAngle: 90, supportsPhysicalOrientation: true });
  draw();
  viewer.setInteractionActive(true, "orbit");
  viewer.orbit(Math.PI / 3, 0);
  draw();
  viewer.setInteractionActive(false, "orbit");
  draw();
  const unconfirmed = last(state.frames)!.rotation!.clone();
  assert.deepEqual(panels, [1]);
  advanceTimers(DUO_HANDOFF_TIMEOUT_MS - 1);
  draw();
  assert.ok(last(state.frames)!.rotation!.angleTo(unconfirmed) < 1e-6, "still waiting");
  advanceTimers(1);
  draw();
  assert.ok(last(state.frames)!.rotation!.angleTo(unconfirmed) > 0.5);
  assert.deepEqual(panels, [1]);
  settle();
  assert.equal(pendingFrames(), 0);
  viewer.dispose();
});

test("the elected primary frame wins during handoff and a stale fixed-panel feed never overwrites it", () => {
  const { viewer, drawn } = fixture();
  const coverScreen = { ...cover, orientation: "portrait" as const, hingeAngle: 90 };
  viewer.setScreen(coverScreen);
  const primary = { width: 1398, height: 2034 } as HTMLCanvasElement;
  viewer.frameUpdated(1, primary);
  assert.equal(last(drawn), primary);
  const uploads = drawn.length;
  viewer.frameUpdated(1);
  assert.equal(drawn.length, uploads);
  // A frame for the inactive display is ignored.
  viewer.frameUpdated(3, primary);
  assert.equal(drawn.length, uploads);
  viewer.setScreen({ ...coverScreen, width: 2007, height: 2853, screenId: 3 });
  const elected = { width: 2007, height: 2853 } as HTMLCanvasElement;
  viewer.frameUpdated(3, elected);
  assert.equal(last(drawn), elected);
  viewer.setScreen(coverScreen);
  viewer.frameUpdated(1);
  assert.ok(drawn.length > uploads + 1);
  viewer.dispose();
});

test("a fixed panel's shutdown blank is ignored only while its display is activating", () => {
  const { viewer, drawn, wait } = fixture({ blankProbe: true });
  viewer.setScreen({ ...cover, orientation: "portrait", hingeAngle: 0 });
  const source = { width: 1398, height: 2034 };
  const uploads = () => drawn.filter((entry) => entry === source || (entry as { width?: number }).width === 1398).length;
  viewer.frameUpdated(1);
  // Only the 8×8 probe touched the blank frame; the display kept its last image.
  const probed = uploads();
  viewer.frameUpdated(1);
  assert.equal(uploads(), probed * 2, "no upload, only probes");
  wait(DUO_BLANK_PROBE_MS);
  viewer.frameUpdated(1);
  // Steady black application content is valid after activation.
  assert.equal(uploads(), probed * 2 + 1);
  viewer.dispose();
});

for (const face of ["left", "right"] as const) {
  test(`a pinch over the ${face} half keeps the primary surface still through closure and reopening`, () => {
    const { viewer, draw, state, pendingFrames, orientations, loaded } = fixture();
    viewer.resize(500, 700, 2);
    const open = { ...inner, orientation: "portrait" as const, hingeAngle: 180, hingePose: "open" as const };
    viewer.setScreen(open);
    draw();
    assert.equal(viewer.beginHinge(-1, -1), false);
    const leaf = loaded.getObjectByName("right-half")!;
    const mesh = loaded.getObjectByName(`inner-display-${face}`) as Mesh;
    const centre = mesh.geometry.boundingBox!.getCenter(new Vector3());
    const point = mesh.localToWorld(centre).project(last(state.frames)!.camera);
    assert.equal(viewer.beginHinge((point.x + 1) / 2, (1 - point.y) / 2), true);
    const orientation = leaf.getWorldQuaternion(new Quaternion());
    const partner = loaded.getObjectByName("left-half")!;
    const partnerStart = partner.getWorldQuaternion(new Quaternion());
    for (const value of [150, 90, 30, 0, 30, 90, 180]) {
      viewer.setHingePreview(value, true);
      draw();
      assert.ok(leaf.getWorldQuaternion(new Quaternion()).angleTo(orientation) < 1e-6);
      if (value === 90) assert.ok(partner.getWorldQuaternion(new Quaternion()).angleTo(partnerStart) > 1);
      const next =
        value === 0
          ? { ...open, width: 1398, height: 2034, screenId: 1, hingeAngle: value, hingePose: null }
          : { ...open, hingeAngle: value, hingePose: null };
      viewer.setScreen(next);
      viewer.setHingePreview(null, true);
      draw();
      // Late native readback cannot change the view.
      viewer.setScreen({ ...next });
      draw();
      assert.ok(leaf.getWorldQuaternion(new Quaternion()).angleTo(orientation) < 1e-6);
      // No fresh native frame yet.
      assert.equal(viewer.screenPoint(0.5, 0.5), null);
      if (value === 0) {
        const coverMesh = loaded.getObjectByName("cover-display") as Mesh;
        const hit = coverMesh.localToWorld(coverMesh.geometry.boundingBox!.getCenter(new Vector3())).project(last(state.frames)!.camera);
        assert.equal(viewer.beginHinge((hit.x + 1) / 2, (1 - hit.y) / 2), true);
      }
    }
    assert.equal(orientations.length, 0);
    draw();
    assert.equal(pendingFrames(), 0);
    viewer.dispose();
  });
}

test("the procedural Duo opens, closes and accepts a touch once its display has a frame", () => {
  const { viewer, draw, state, unavailable } = fixture({ procedural: true });
  viewer.resize(600, 600, 1);
  const open = { ...inner, orientation: "landscape_left" as const, hingeAngle: 180 };
  viewer.setScreen(open);
  draw();
  // No frame yet: input waits so a touch never lands on a stale surface.
  assert.equal(viewer.screenPoint(0.5, 0.5), null);
  viewer.frameUpdated(3, { width: 2007, height: 2853 } as HTMLCanvasElement);
  draw();
  const hit = viewer.screenPoint(0.5, 0.5);
  assert.ok(hit, "the inner display takes a centre touch");
  close(hit.x, 0.5, 0.05);
  close(hit.y, 0.5, 0.05);
  viewer.setScreen({ ...cover, orientation: "portrait", hingeAngle: 0 });
  draw();
  const bounds = last(state.frames)!.bounds!;
  assert.ok(bounds.max.y - bounds.min.y > bounds.max.x - bounds.min.x, "a closed Duo stands like a phone");
  assert.equal(unavailable(), 0);
  viewer.dispose();
});

test("a failed render falls back once, and a capture draws the framed device", async () => {
  const { viewer, draw, state, unavailable } = fixture();
  viewer.resize(500, 700, 2);
  viewer.setScreen({ ...inner, orientation: "portrait", hingeAngle: 180 });
  draw();
  const frames = state.frames.length;
  const image = await viewer.capture();
  assert.equal(image?.type, "image/png");
  assert.equal(state.frames.length, frames + 1);
  state.failNextRender = true;
  viewer.orbit(0.2, 0);
  draw();
  viewer.orbit(0.2, 0);
  draw();
  assert.equal(unavailable(), 1);
  assert.equal(await viewer.capture(), null);
  viewer.dispose();
});
