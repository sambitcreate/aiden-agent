/**
 * Aiden's original procedural iPhone Duo: two thin leaves on a hinge barrel.
 *
 * The rig matches the contract `duo-scene.ts` (ported from T3) expects, so the
 * articulation, UV and touch code works unchanged:
 *   - `left-half` and `right-half` groups pivot about the asset's Y axis, which
 *     is the hinge line on the inner display plane (z = 0).
 *   - `inner-display-left` / `inner-display-right` are coplanar halves of one
 *     display, authored in a shared frame so their planar UVs join at the crease.
 *   - `cover-display` faces -Z on the back of the left leaf.
 * Every mesh keeps an identity transform; positions are baked into geometry.
 *
 * Proportions come from the simulator's own display sizes (cover 784 × 1140,
 * inner 1600 × 1125 once turned onto the leaves). No vendor model, texture or
 * art is used or derived.
 */
import { CylinderGeometry, ExtrudeGeometry, Group, Mesh, MeshBasicMaterial } from "three";
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

export const DUO_COVER_PIXELS = { width: 784, height: 1140 } as const;
/** The inner panel's canvas, already turned a quarter onto the open leaves. */
export const DUO_INNER_PIXELS = { width: 1600, height: 1125 } as const;

/** Millimetre layout. Exported for the model's geometry tests. */
export const DUO_LAYOUT = (() => {
  const displayHeight = 141.6;
  const displayHalfWidth = (displayHeight * (DUO_INNER_PIXELS.width / DUO_INNER_PIXELS.height)) / 2;
  const leafWidth = displayHalfWidth + 2.5;
  const leafHeight = displayHeight + 5.8;
  const coverHeight = 139.0;
  return {
    displayHeight,
    displayHalfWidth,
    displayRadius: 8.0,
    leafWidth,
    leafHeight,
    /** Each leaf's thickness; the hinge barrel's radius matches it. */
    thickness: 5.2,
    rail: 0.8,
    cornerRadius: 10.0,
    /** Seam between each leaf and the hinge line. */
    seam: 0.15,
    coverHeight,
    coverWidth: (coverHeight * DUO_COVER_PIXELS.width) / DUO_COVER_PIXELS.height,
    coverRadius: 9.0,
    plateau: { height: 40.0, rise: 1.6 },
  };
})();

/** Scale so the inner display is 2.2 units tall, matching the phone models. */
export const DUO_SCALE = 2.2 / DUO_LAYOUT.displayHeight;

const LIGHT_TITANIUM = { frame: 0xb9b3a8, back: 0xa9a399, plateau: 0xb3ada2 } as const;

type Side = "left" | "right";

/** Leaf outline: rounded outer corners, a square edge along the hinge. */
function leafOutline(side: Side, inset: number) {
  const L = DUO_LAYOUT;
  const width = L.leafWidth - L.seam - inset * 2;
  const height = L.leafHeight - inset * 2;
  const cx = (side === "left" ? -1 : 1) * (L.seam + inset + width / 2);
  const r = Math.max(0, L.cornerRadius - inset);
  const radii = side === "left" ? ([r, 0, 0, r] as const) : ([0, r, r, 0] as const);
  return continuousRect(width, height, radii, cx, 0);
}

function sideKey(parts: PartList, kit: MaterialKit, fromTop: number, length: number) {
  const L = DUO_LAYOUT;
  const thickness = L.thickness * 0.42;
  const key = new ExtrudeGeometry(capsule(thickness - 0.3, length - 0.3), {
    depth: 0.45,
    bevelEnabled: true,
    bevelSize: 0.15,
    bevelThickness: 0.15,
    bevelSegments: 2,
    curveSegments: 10,
  });
  // Keys sit on the right leaf's outer edge, centred in its thickness.
  parts.add(kit.key, key, place(L.leafWidth - 0.25, L.leafHeight / 2 - fromTop, -L.thickness / 2, 0, Math.PI / 2));
  key.dispose();
}

function buildLeaf(side: Side, kit: MaterialKit): Group {
  const L = DUO_LAYOUT;
  const sign = side === "left" ? -1 : 1;
  const leaf = new Group();
  leaf.name = `${side}-half`;
  const parts = createPartList();
  const t = L.thickness;

  const body = slab(leafOutline(side, L.rail), -t, -0.03, L.rail, 4, 16);
  parts.add(kit.frame, body);
  body.dispose();

  // Inner face: black cover glass around the display half.
  const bezel = new Mesh(face(leafOutline(side, L.rail - 0.1), -0.015), kit.frontGlass);
  bezel.name = `inner-bezel-${side}`;
  leaf.add(bezel);

  const halfWidth = L.displayHalfWidth;
  const display = new Mesh(
    face(
      continuousRect(
        halfWidth,
        L.displayHeight,
        side === "left" ? [L.displayRadius, 0, 0, L.displayRadius] : [0, L.displayRadius, L.displayRadius, 0],
        (sign * halfWidth) / 2,
        0,
      ),
      0,
      false,
      20,
    ),
    new MeshBasicMaterial({ color: 0x000000, name: "inner-placeholder" }),
  );
  display.name = `inner-display-${side}`;
  leaf.add(display);

  const backZ = -t - 0.015;
  if (side === "left") {
    // The cover display fills most of the left leaf's back, inside black glass.
    const backGlass = face(leafOutline(side, L.rail - 0.1), backZ, true);
    parts.add(kit.frontGlass, backGlass);
    backGlass.dispose();
    const cx = -(L.leafWidth + L.seam) / 2;
    const cover = new Mesh(
      face(continuousRect(L.coverWidth, L.coverHeight, L.coverRadius, cx, 0), -t - 0.04, true, 20),
      new MeshBasicMaterial({ color: 0x000000, name: "cover-placeholder" }),
    );
    cover.name = "cover-display";
    leaf.add(cover);
    const punch = face(circle(1.35, cx, L.coverHeight / 2 - 5.2), -t - 0.09, true, 20);
    parts.add(kit.cutout, punch);
    punch.dispose();
    // Speaker slots on the top edge.
    const slot = face(capsule(4.2, 1.1), 0);
    for (const x of [-26, -32, -38]) parts.add(kit.dark, slot, place(x, L.leafHeight / 2 + 0.03, -t / 2, -Math.PI / 2));
    slot.dispose();
  } else {
    // Frosted back glass under a full-width camera plateau.
    const plateauBottom = L.leafHeight / 2 - L.plateau.height;
    const glassTop = plateauBottom - 1.2;
    const glassBottom = -L.leafHeight / 2 + 3.4;
    const glassLeft = L.seam + 3.4;
    const glassRight = L.leafWidth - 3.4;
    const glass = face(
      continuousRect(
        glassRight - glassLeft,
        glassTop - glassBottom,
        [3, 3, L.cornerRadius - 3.4, 2],
        (glassLeft + glassRight) / 2,
        (glassTop + glassBottom) / 2,
      ),
      backZ,
      true,
    );
    parts.add(kit.backGlass, glass);
    glass.dispose();
    const shelfRail = 0.6;
    const shelfLeft = L.seam + L.rail + shelfRail + 0.2;
    const shelfRight = L.leafWidth - L.rail - shelfRail - 0.2;
    const shelfTop = L.leafHeight / 2 - L.rail - shelfRail - 0.1;
    const shelfBottom = plateauBottom + shelfRail;
    const corner = L.cornerRadius - L.rail - shelfRail;
    const shelf = slab(
      continuousRect(shelfRight - shelfLeft, shelfTop - shelfBottom, [1.5, corner, 6, 4], (shelfLeft + shelfRight) / 2, (shelfTop + shelfBottom) / 2),
      -t - L.plateau.rise,
      -t + 0.4,
      shelfRail,
      4,
      16,
    );
    parts.add(kit.plateau, shelf);
    shelf.dispose();
    const surface = -t - L.plateau.rise;
    const lensY = L.leafHeight / 2 - L.plateau.height / 2 - 0.4;
    const lens = lensProfile(7.2, 2.4);
    for (const x of [0.6 * L.leafWidth, 0.81 * L.leafWidth]) {
      const matrix = place(x, lensY, surface, 0, Math.PI);
      parts.add(kit.polished, lens.ring, matrix);
      parts.add(kit.lensGlass, lens.glass, matrix);
      parts.add(kit.lensIris, lens.iris, matrix);
    }
    lens.ring.dispose();
    lens.glass.dispose();
    lens.iris.dispose();
    const flashX = 0.4 * L.leafWidth;
    const flashRing = face(circle(2.7, flashX, lensY + 6.5), surface - 0.05, true, 24);
    const flashLens = face(circle(1.95, flashX, lensY + 6.5), surface - 0.08, true, 24);
    const sensor = face(circle(2.5, flashX, lensY - 6.0), surface - 0.06, true, 24);
    const microphone = face(circle(0.45, flashX, lensY), surface - 0.06, true, 10);
    parts.add(kit.dark, flashRing);
    parts.add(kit.flash, flashLens);
    parts.add(kit.lensIris, sensor);
    parts.add(kit.cutout, microphone);
    for (const geometry of [flashRing, flashLens, sensor, microphone]) geometry.dispose();
    sideKey(parts, kit, 40, 18);
    sideKey(parts, kit, 70, 26);
    // USB-C port and speaker slots on the bottom edge.
    const port = face(capsule(9.0, 2.6), 0);
    parts.add(kit.dark, port, place(L.leafWidth / 2, -L.leafHeight / 2 - 0.03, -t / 2, Math.PI / 2));
    port.dispose();
    const slot = face(capsule(4.2, 1.1), 0);
    for (const x of [L.leafWidth / 2 + 14, L.leafWidth / 2 + 20, L.leafWidth / 2 + 26]) {
      parts.add(kit.dark, slot, place(x, -L.leafHeight / 2 - 0.03, -t / 2, Math.PI / 2));
    }
    slot.dispose();
  }
  parts.mergeInto(leaf, side);
  return leaf;
}

/**
 * Builds a fresh Duo asset. The hinge barrel is a fixed half-cylinder on the
 * outside of the hinge line: hidden inside the leaves when open, it becomes the
 * rounded spine as they close.
 */
export function buildDuoModel(): Group {
  const L = DUO_LAYOUT;
  const kit = createMaterialKit(LIGHT_TITANIUM);
  const asset = new Group();
  asset.name = "iphone-duo";
  const left = buildLeaf("left", kit);
  const right = buildLeaf("right", kit);
  const barrel = new Mesh(
    new CylinderGeometry(L.thickness, L.thickness, L.leafHeight - L.rail * 2 - 0.4, 40, 1, false, Math.PI / 2, Math.PI),
    kit.polished,
  );
  barrel.name = "hinge-barrel";
  asset.add(left, right, barrel);
  bakeScale(asset, DUO_SCALE);
  return asset;
}
