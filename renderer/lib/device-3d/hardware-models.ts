/**
 * Aiden's original, hardware-accurate procedural iPhone and iPad models.
 *
 * Dimensions come from public spec sheets (body size, depth, display pixels and
 * pixel density); proportions such as button and lens placement follow those
 * measurements. Nothing is bundled from, downloaded from, or derived from any
 * vendor 3D asset. Each model satisfies the normalized-asset contract that
 * `model-scene.ts` validates: portrait, front +Z, one centred `device-screen`
 * mesh exactly 2.2 units tall with identity transforms.
 */
import { BufferGeometry, ExtrudeGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import type { DeviceModelId } from "./model-registry";
import {
  bakeScale,
  capsule,
  circle,
  continuousRect,
  createMaterialKit,
  createPartList,
  face,
  lensProfile,
  place,
  slab,
  type MaterialKit,
  type PartList,
} from "./model-kit";

export const DISPLAY_HEIGHT = 2.2;
/** Simulator framebuffer pixels per inch, used with the pixel size to find the active area in millimetres. */
const MM_PER_INCH = 25.4;

interface SideButton {
  readonly side: "left" | "right";
  /** Centre distance from the top of the body, mm. */
  readonly fromTop: number;
  readonly length: number;
  readonly kind: "key" | "camera-control";
}

interface EdgeKey {
  readonly edge: "top";
  /** Centre distance from the right edge (front view), mm. */
  readonly fromRight: number;
  readonly length: number;
}

interface RearPart {
  /** Distance from the right edge in front view, which is the left edge seen from the back, mm. */
  readonly fromRight: number;
  readonly fromTop: number;
  readonly radius: number;
}

export interface HandsetSpec {
  readonly id: DeviceModelId;
  readonly body: { readonly width: number; readonly height: number; readonly depth: number; readonly radius: number };
  readonly pixels: { readonly width: number; readonly height: number; readonly ppi: number };
  readonly displayRadius: number;
  /** Rounded rail radius where the frame meets each face. */
  readonly rail: number;
  readonly island: { readonly width: number; readonly height: number; readonly fromTop: number } | null;
  /** Front camera when there is no island, as an offset from the display centre. */
  readonly frontCamera: { readonly x: number; readonly y: number; readonly radius: number } | null;
  readonly back:
    | { readonly kind: "plateau"; readonly height: number; readonly rise: number; readonly windowInset: number }
    | { readonly kind: "bump"; readonly width: number; readonly height: number; readonly inset: number; readonly rise: number };
  readonly lenses: readonly RearPart[];
  readonly lensRise: number;
  readonly flash: RearPart;
  readonly lidar: RearPart | null;
  readonly microphone: RearPart | null;
  readonly buttons: readonly SideButton[];
  readonly edgeKeys: readonly EdgeKey[];
  /** Bottom-edge port width and speaker hole spread, mm. */
  readonly port: { readonly width: number; readonly height: number };
  readonly speakers: { readonly from: number; readonly to: number; readonly holes: number; readonly edges: readonly ("top" | "bottom")[] };
  readonly finish: { readonly frame: number; readonly back: number; readonly plateau?: number };
}

const proCameraCluster = {
  lenses: [
    { fromRight: 14.4, fromTop: 14.3, radius: 6.4 },
    { fromRight: 14.4, fromTop: 33.6, radius: 6.4 },
    { fromRight: 32.5, fromTop: 23.9, radius: 6.4 },
  ],
  lensRise: 2.9,
  flash: { fromRight: 57.7, fromTop: 13.8, radius: 3.0 },
  lidar: { fromRight: 58.0, fromTop: 34.2, radius: 3.2 },
  microphone: { fromRight: 58.0, fromTop: 24.0, radius: 0.45 },
} as const;

/** Natural titanium: brushed frame, frosted back glass and a matching plateau. */
const NATURAL_TITANIUM = { frame: 0xa29d94, back: 0x8f8b84, plateau: 0x9d988f } as const;

/** 6.3-inch class iPhone Pro: 150.0 × 71.9 × 8.75 mm, 2622 × 1206 at 460 ppi. */
export const IPHONE_PRO: HandsetSpec = {
  id: "iphone-pro",
  body: { width: 71.9, height: 150.0, depth: 8.75, radius: 11.0 },
  pixels: { width: 1206, height: 2622, ppi: 460 },
  displayRadius: 9.1,
  rail: 0.9,
  island: { width: 20.7, height: 6.1, fromTop: 1.9 },
  frontCamera: null,
  back: { kind: "plateau", height: 48.8, rise: 2.0, windowInset: 3.8 },
  ...proCameraCluster,
  buttons: [
    { side: "left", fromTop: 33.0, length: 7.4, kind: "key" },
    { side: "left", fromTop: 48.4, length: 11.2, kind: "key" },
    { side: "left", fromTop: 62.6, length: 11.2, kind: "key" },
    { side: "right", fromTop: 55.5, length: 17.7, kind: "key" },
    { side: "right", fromTop: 98.4, length: 17.1, kind: "camera-control" },
  ],
  edgeKeys: [],
  port: { width: 9.0, height: 3.3 },
  speakers: { from: 9.0, to: 20.5, holes: 6, edges: ["bottom"] },
  finish: NATURAL_TITANIUM,
};

/** 6.9-inch class iPhone Pro Max: 163.4 × 78.0 × 8.75 mm, 2868 × 1320 at 460 ppi. */
export const IPHONE_PRO_MAX: HandsetSpec = {
  ...IPHONE_PRO,
  id: "iphone-pro-max",
  body: { width: 78.0, height: 163.4, depth: 8.75, radius: 12.0 },
  pixels: { width: 1320, height: 2868, ppi: 460 },
  displayRadius: 9.8,
  buttons: [
    { side: "left", fromTop: 35.5, length: 7.4, kind: "key" },
    { side: "left", fromTop: 52.0, length: 11.2, kind: "key" },
    { side: "left", fromTop: 66.6, length: 11.2, kind: "key" },
    { side: "right", fromTop: 60.0, length: 17.7, kind: "key" },
    { side: "right", fromTop: 107.0, length: 17.1, kind: "camera-control" },
  ],
  speakers: { from: 9.5, to: 23.0, holes: 7, edges: ["bottom"] },
};

/** 13-inch iPad Pro (M4/M5 chassis): 281.6 × 215.5 × 5.1 mm, 2064 × 2752 at 264 ppi. */
export const IPAD_PRO_13: HandsetSpec = {
  id: "ipad-pro-13",
  body: { width: 215.5, height: 281.6, depth: 5.1, radius: 13.4 },
  pixels: { width: 2064, height: 2752, ppi: 264 },
  displayRadius: 5.0,
  rail: 0.7,
  island: null,
  // The front camera sits on the landscape edge, the right bezel in portrait.
  frontCamera: { x: 103.5, y: 0, radius: 1.1 },
  back: { kind: "bump", width: 17.5, height: 26.0, inset: 7.5, rise: 1.2 },
  lenses: [{ fromRight: 16.25, fromTop: 14.0, radius: 5.0 }],
  lensRise: 1.1,
  flash: { fromRight: 16.25, fromTop: 28.2, radius: 1.9 },
  lidar: { fromRight: 16.25, fromTop: 22.6, radius: 2.6 },
  microphone: { fromRight: 20.4, fromTop: 30.2, radius: 0.4 },
  buttons: [
    { side: "right", fromTop: 26.0, length: 12.0, kind: "key" },
    { side: "right", fromTop: 41.0, length: 12.0, kind: "key" },
  ],
  edgeKeys: [{ edge: "top", fromRight: 24.0, length: 16.0 }],
  port: { width: 9.0, height: 2.6 },
  speakers: { from: 58.0, to: 70.0, holes: 6, edges: ["top", "bottom"] },
  finish: { frame: 0xa7aaae, back: 0xa7aaae, plateau: 0xa7aaae },
};

export const HANDSET_SPECS: Readonly<Record<Exclude<DeviceModelId, "iphone-duo">, HandsetSpec>> = {
  "iphone-pro": IPHONE_PRO,
  "iphone-pro-max": IPHONE_PRO_MAX,
  "ipad-pro-13": IPAD_PRO_13,
};

/** Active display area in millimetres, from the framebuffer's pixel size and density. */
export function displaySize(spec: HandsetSpec) {
  return {
    width: (spec.pixels.width / spec.pixels.ppi) * MM_PER_INCH,
    height: (spec.pixels.height / spec.pixels.ppi) * MM_PER_INCH,
  };
}

function sideKey(parts: PartList, kit: MaterialKit, spec: HandsetSpec, button: SideButton) {
  const { width, height, depth } = spec.body;
  const sign = button.side === "right" ? 1 : -1;
  const y = height / 2 - button.fromTop;
  const thickness = Math.min(depth * 0.36, 3.2);
  if (button.kind === "camera-control") {
    // A flush sapphire key inside a polished surround.
    const surround = face(capsule(thickness + 0.7, button.length + 0.7), 0);
    const crystal = face(capsule(thickness, button.length), 0);
    parts.add(kit.polished, surround, place(sign * (width / 2 + 0.02), y, 0, 0, sign * (Math.PI / 2)));
    parts.add(kit.lensGlass, crystal, place(sign * (width / 2 + 0.05), y, 0, 0, sign * (Math.PI / 2)));
    surround.dispose();
    crystal.dispose();
    return;
  }
  const protrusion = 0.5;
  const key = new ExtrudeGeometry(capsule(thickness - 0.3, button.length - 0.3), {
    depth: protrusion,
    bevelEnabled: true,
    bevelSize: 0.15,
    bevelThickness: 0.15,
    bevelSegments: 2,
    curveSegments: 10,
  });
  parts.add(kit.key, key, place(sign * (width / 2 - 0.25), y, 0, 0, sign * (Math.PI / 2)));
  key.dispose();
}

function edgeKey(parts: PartList, kit: MaterialKit, spec: HandsetSpec, key: EdgeKey) {
  const { width, height, depth } = spec.body;
  const thickness = Math.min(depth * 0.4, 2.2);
  const geometry = new ExtrudeGeometry(capsule(key.length - 0.3, thickness - 0.3), {
    depth: 0.45,
    bevelEnabled: true,
    bevelSize: 0.15,
    bevelThickness: 0.15,
    bevelSegments: 2,
    curveSegments: 10,
  });
  parts.add(kit.key, geometry, place(width / 2 - key.fromRight, height / 2 - 0.25, 0, -Math.PI / 2));
  geometry.dispose();
}

/** Port and speaker holes on a flat end of the rail, facing ±Y. */
function edgeOpenings(parts: PartList, kit: MaterialKit, spec: HandsetSpec) {
  const { height } = spec.body;
  const port = face(capsule(spec.port.width, spec.port.height), 0);
  parts.add(kit.dark, port, place(0, -height / 2 - 0.03, 0, Math.PI / 2));
  port.dispose();
  const hole = face(circle(Math.min(0.55, spec.port.height * 0.18)), 0, false, 10);
  const { from, to, holes } = spec.speakers;
  for (const edge of spec.speakers.edges) {
    const y = edge === "bottom" ? -height / 2 - 0.03 : height / 2 + 0.03;
    const turn = edge === "bottom" ? Math.PI / 2 : -Math.PI / 2;
    for (const sign of [-1, 1]) {
      for (let index = 0; index < holes; index++) {
        const x = sign * (from + ((to - from) * index) / Math.max(1, holes - 1));
        parts.add(kit.dark, hole, place(x, y, 0, turn));
      }
    }
  }
  hole.dispose();
}

/** Lenses, flash and sensors on the back. Positions are measured from the camera corner. */
function rearCamera(parts: PartList, kit: MaterialKit, spec: HandsetSpec, surface: number) {
  const { width, height } = spec.body;
  const at = (part: RearPart) => ({ x: width / 2 - part.fromRight, y: height / 2 - part.fromTop });
  const lensTemplates = new Map<number, ReturnType<typeof lensProfile>>();
  for (const lens of spec.lenses) {
    const template = lensTemplates.get(lens.radius) ?? lensProfile(lens.radius, spec.lensRise);
    lensTemplates.set(lens.radius, template);
    const { x, y } = at(lens);
    // Lathe parts face +Z; a half turn about Y puts them on the back, rising from the surface.
    const matrix = place(x, y, surface, 0, Math.PI);
    parts.add(kit.polished, template.ring, matrix);
    parts.add(kit.lensGlass, template.glass, matrix);
    parts.add(kit.lensIris, template.iris, matrix);
  }
  for (const template of lensTemplates.values()) {
    template.ring.dispose();
    template.glass.dispose();
    template.iris.dispose();
  }
  const flashPosition = at(spec.flash);
  const flashRing = face(circle(spec.flash.radius), 0, true, 24);
  const flashLens = face(circle(spec.flash.radius * 0.72), 0, true, 24);
  parts.add(kit.dark, flashRing, place(flashPosition.x, flashPosition.y, surface - 0.05));
  parts.add(kit.flash, flashLens, place(flashPosition.x, flashPosition.y, surface - 0.08));
  flashRing.dispose();
  flashLens.dispose();
  if (spec.lidar) {
    const { x, y } = at(spec.lidar);
    const lidar = face(circle(spec.lidar.radius), 0, true, 28);
    parts.add(kit.lensIris, lidar, place(x, y, surface - 0.06));
    lidar.dispose();
  }
  if (spec.microphone) {
    const { x, y } = at(spec.microphone);
    const microphone = face(circle(spec.microphone.radius), 0, true, 10);
    parts.add(kit.cutout, microphone, place(x, y, surface - 0.06));
    microphone.dispose();
  }
}

/** Builds one handset, in mm, then scales it so the display is 2.2 units tall. */
export function buildHandset(spec: HandsetSpec): Group {
  const kit = createMaterialKit(spec.finish);
  const parts = createPartList();
  const { width, height, depth, radius } = spec.body;
  const display = displaySize(spec);
  const rail = spec.rail;
  const front = depth / 2;
  const back = -depth / 2;
  const root = new Group();
  root.name = spec.id;

  // Frame: one slab with a rounded rail on both faces.
  const body = slab(continuousRect(width - rail * 2, height - rail * 2, radius - rail), back, front, rail, 5, 18);
  parts.add(kit.frame, body);
  body.dispose();

  // Cover glass over the flat front, then the display and its cut-outs.
  const glass = face(continuousRect(width - rail * 2 + 0.2, height - rail * 2 + 0.2, radius - rail), front + 0.02);
  parts.add(kit.frontGlass, glass);
  glass.dispose();
  const screen = new Mesh(
    face(continuousRect(display.width, display.height, spec.displayRadius), front + 0.06, false, 24),
    new MeshBasicMaterial({ color: 0x000000, name: "screen-placeholder" }),
  );
  screen.name = "device-screen";
  if (spec.island) {
    const islandY = display.height / 2 - spec.island.fromTop - spec.island.height / 2;
    const island = face(capsule(spec.island.width, spec.island.height, 0, islandY), front + 0.14, false, 16);
    parts.add(kit.cutout, island);
    island.dispose();
    const lens = face(circle(spec.island.height * 0.21, spec.island.width / 2 - spec.island.height * 0.55, islandY), front + 0.18, false, 16);
    parts.add(kit.lensIris, lens);
    lens.dispose();
  }
  if (spec.frontCamera) {
    const camera = face(circle(spec.frontCamera.radius, spec.frontCamera.x, spec.frontCamera.y), front + 0.05, false, 16);
    parts.add(kit.lensIris, camera);
    camera.dispose();
  }

  // Back: frosted glass and a raised camera plateau, or a unibody with a camera bump.
  let cameraSurface: number;
  if (spec.back.kind === "plateau") {
    const plateau = spec.back;
    const plateauBottom = height / 2 - plateau.height;
    const windowTop = plateauBottom - 1.4;
    const windowBottom = -height / 2 + plateau.windowInset;
    const windowHeight = windowTop - windowBottom;
    const windowGlass = face(
      continuousRect(width - plateau.windowInset * 2, windowHeight, [3.5, 3.5, radius - plateau.windowInset, radius - plateau.windowInset], 0, windowBottom + windowHeight / 2),
      back - 0.03,
      true,
    );
    parts.add(kit.backGlass, windowGlass);
    windowGlass.dispose();
    // The shelf's rounded rail adds `shelfRail` all round; keep it inside the flat back.
    const shelfRail = 0.7;
    const shelfWidth = width - rail * 2 - shelfRail * 2 - 0.2;
    const shelfTop = height / 2 - rail - shelfRail - 0.1;
    const shelfBottom = plateauBottom + shelfRail;
    const shelfCorner = radius - rail - shelfRail - 0.1;
    const shelf = slab(
      continuousRect(shelfWidth, shelfTop - shelfBottom, [shelfCorner, shelfCorner, 6, 6], 0, (shelfTop + shelfBottom) / 2),
      back - plateau.rise,
      back + 0.4,
      shelfRail,
      4,
      16,
    );
    parts.add(kit.plateau, shelf);
    shelf.dispose();
    cameraSurface = back - plateau.rise;
  } else {
    const bump = spec.back;
    const cx = width / 2 - bump.inset - bump.width / 2;
    const cy = height / 2 - bump.inset - bump.height / 2;
    const raised = slab(continuousRect(bump.width, bump.height, Math.min(bump.width, bump.height) / 2, cx, cy), back - bump.rise, back + 0.3, 0.45, 3, 18);
    parts.add(kit.plateau, raised);
    raised.dispose();
    cameraSurface = back - bump.rise;
  }
  rearCamera(parts, kit, spec, cameraSurface);

  for (const button of spec.buttons) sideKey(parts, kit, spec, button);
  for (const key of spec.edgeKeys) edgeKey(parts, kit, spec, key);
  edgeOpenings(parts, kit, spec);

  parts.mergeInto(root, spec.id);
  root.add(screen);
  bakeScale(root, DISPLAY_HEIGHT / display.height);
  // The kit is now referenced only by meshes; `disposeDeviceModel` releases it with them.
  return root;
}

/** Builds a fresh, independently disposable hardware model. Duo bodies come from `duo-model.ts`. */
export function buildHandsetModel(id: Exclude<DeviceModelId, "iphone-duo">): Group {
  return buildHandset(HANDSET_SPECS[id]);
}

/** Test and debugging helper: every geometry in a model. */
export function modelGeometries(root: Group): BufferGeometry[] {
  const geometries = new Set<BufferGeometry>();
  root.traverse((object) => {
    if (object instanceof Mesh) geometries.add(object.geometry);
  });
  return [...geometries];
}
