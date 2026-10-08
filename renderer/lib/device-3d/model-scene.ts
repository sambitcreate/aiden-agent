// Adapted from t3code packages/client-runtime/src/device/modelScene.ts @ a6ec88f7 (MIT).
// T3 loads normalized GLB assets; Aiden feeds the same contract with its own
// procedural models, built synchronously in `hardware-models.ts`.
import { Box3, Group, Mesh, MeshBasicMaterial, Texture, type Material, type Object3D } from "three";
import { createDisplayProjection, updateDisplayUv, type PhoneDisplayLayout } from "./phone-scene";

/** Model resources belong to one viewer; the live framebuffer texture belongs to its stream presentation. */
export function disposeDeviceModel(root: Object3D) {
  const geometries = new Set<Mesh["geometry"]>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material as Material);
      for (const value of Object.values(material as object)) {
        if (value instanceof Texture) textures.add(value);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

/** Assets are portrait, front +Z, with one centred `device-screen` 2.2 units tall and planar display UVs. */
export function createModelPhoneScene(asset: Group, texture: Texture, initial: PhoneDisplayLayout) {
  const screens: Mesh[] = [];
  asset.traverse((object) => {
    if (object instanceof Mesh && object.name === "device-screen") screens.push(object);
  });
  const display = screens[0];
  if (!display || screens.length !== 1) throw new Error("Device model must have one device-screen mesh");
  asset.updateMatrixWorld(true);
  const screenBounds = new Box3().setFromObject(display);
  const screenWidth = screenBounds.max.x - screenBounds.min.x;
  const screenHeight = screenBounds.max.y - screenBounds.min.y;
  if (
    display.matrixWorld.elements.some(
      (value, index) => !Number.isFinite(value) || Math.abs(value - (index % 5 === 0 ? 1 : 0)) > 0.001,
    ) ||
    !Number.isFinite(screenWidth) ||
    !Number.isFinite(screenHeight) ||
    !Number.isFinite(screenBounds.min.z) ||
    !Number.isFinite(screenBounds.max.z) ||
    screenWidth <= 0 ||
    Math.abs(screenHeight - 2.2) > 0.001 ||
    Math.abs(screenBounds.min.x + screenBounds.max.x) > 0.001 ||
    Math.abs(screenBounds.min.y + screenBounds.max.y) > 0.001 ||
    screenBounds.max.z - screenBounds.min.z > 0.001
  ) {
    throw new Error("Device model display is not normalized");
  }
  updateDisplayUv(display.geometry, screenWidth, screenHeight, initial);
  const originalMaterial = display.material;
  const screenMaterial = new MeshBasicMaterial({ map: texture, toneMapped: false });
  display.material = screenMaterial;
  const root = new Group();
  const orientation = new Group();
  orientation.add(asset);
  root.add(orientation);
  const bounds = new Box3().setFromObject(asset);
  let layout = initial;
  const projection = createDisplayProjection(display, orientation, screenWidth, screenHeight, () => layout);
  return {
    root,
    orientation,
    width: bounds.max.x - bounds.min.x,
    height: bounds.max.y - bounds.min.y,
    setDisplay(nextTexture: Texture, nextLayout: PhoneDisplayLayout) {
      layout = nextLayout;
      screenMaterial.map = nextTexture;
      updateDisplayUv(display.geometry, screenWidth, screenHeight, layout);
    },
    screenPoint: projection,
    dispose() {
      // The viewer owns the asset's resources. This scene owns only its replacement screen material.
      display.material = originalMaterial;
      screenMaterial.map = null;
      screenMaterial.dispose();
      orientation.remove(asset);
    },
  };
}

export type ModelPhoneScene = ReturnType<typeof createModelPhoneScene>;
