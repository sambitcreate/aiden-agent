/**
 * Shared building blocks for Aiden's original procedural device models.
 *
 * Every model is authored in millimetres from public spec-sheet dimensions and
 * scaled once, so its display is 2.2 units tall like T3's normalized assets.
 * No vendor geometry, texture or art is used or derived.
 *
 * Static parts are merged per material (one draw call per material per moving
 * part), and repeated parts reuse one geometry before merging.
 */
import {
  BufferGeometry,
  Color,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Shape,
  ShapeGeometry,
  Vector2,
  type Material,
  type Object3D,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Bézier handle for continuous-curvature corners, softer than a circular arc. */
const CONTINUOUS = 0.18;
/** Corner reach relative to the nominal radius, so the visible curve matches a circular radius. */
const CORNER_REACH = 1.3;

export type CornerRadii = readonly [topLeft: number, topRight: number, bottomRight: number, bottomLeft: number];

/**
 * A rectangle centred on (cx, cy) with continuous ("squircle") corners. Each
 * corner radius may differ, so a foldable leaf can keep a square hinge edge.
 */
export function continuousRect(
  width: number,
  height: number,
  radius: number | CornerRadii,
  cx = 0,
  cy = 0,
  path: Shape = new Shape(),
): Shape {
  const radii = typeof radius === "number" ? ([radius, radius, radius, radius] as const) : radius;
  const limit = Math.min(width, height) / 2;
  const [tl, tr, br, bl] = radii.map((value) => Math.min(limit, Math.max(0, value * CORNER_REACH)));
  const left = cx - width / 2;
  const right = cx + width / 2;
  const bottom = cy - height / 2;
  const top = cy + height / 2;
  const corner = (reach: number, fromX: number, fromY: number, cornerX: number, cornerY: number, toX: number, toY: number) => {
    if (reach <= 0) {
      path.lineTo(cornerX, cornerY);
      return;
    }
    path.lineTo(fromX, fromY);
    path.bezierCurveTo(
      fromX + (cornerX - fromX) * (1 - CONTINUOUS),
      fromY + (cornerY - fromY) * (1 - CONTINUOUS),
      toX + (cornerX - toX) * (1 - CONTINUOUS),
      toY + (cornerY - toY) * (1 - CONTINUOUS),
      toX,
      toY,
    );
  };
  path.moveTo(left + bl!, bottom);
  corner(br!, right - br!, bottom, right, bottom, right, bottom + br!);
  corner(tr!, right, top - tr!, right, top, right - tr!, top);
  corner(tl!, left + tl!, top, left, top, left, top - tl!);
  corner(bl!, left, bottom + bl!, left, bottom, left + bl!, bottom);
  path.closePath();
  return path;
}

/** A capsule (stadium) outline, used for buttons, ports and the Dynamic Island. */
export function capsule(width: number, height: number, cx = 0, cy = 0): Shape {
  const radius = Math.min(width, height) / 2;
  const path = new Shape();
  const left = cx - width / 2;
  const right = cx + width / 2;
  const bottom = cy - height / 2;
  const top = cy + height / 2;
  if (width >= height) {
    path.moveTo(left + radius, bottom);
    path.lineTo(right - radius, bottom);
    path.absarc(right - radius, cy, radius, -Math.PI / 2, Math.PI / 2, false);
    path.lineTo(left + radius, top);
    path.absarc(left + radius, cy, radius, Math.PI / 2, (3 * Math.PI) / 2, false);
  } else {
    path.moveTo(right, bottom + radius);
    path.lineTo(right, top - radius);
    path.absarc(cx, top - radius, radius, 0, Math.PI, false);
    path.lineTo(left, bottom + radius);
    path.absarc(cx, bottom + radius, radius, Math.PI, 2 * Math.PI, false);
  }
  return path;
}

export function circle(radius: number, cx = 0, cy = 0): Shape {
  const path = new Shape();
  path.absarc(cx, cy, radius, 0, Math.PI * 2, false);
  return path;
}

/**
 * A flat face at depth `z`, facing +Z, or -Z when `back`. A back face keeps the
 * shape's own coordinates: its winding and normals turn, but X is not mirrored,
 * so a part drawn at +X stays on the +X leaf.
 */
export function face(shape: Shape, z: number, back = false, segments = 18): BufferGeometry {
  const geometry = new ShapeGeometry(shape, segments);
  if (back) {
    const index = geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const b = index.getX(i + 1);
        index.setX(i + 1, index.getX(i + 2));
        index.setX(i + 2, b);
      }
    }
    const normal = geometry.getAttribute("normal");
    for (let i = 0; i < normal.count; i++) normal.setXYZ(i, 0, 0, -1);
  }
  geometry.translate(0, 0, z);
  return geometry;
}

/** An extruded slab between `zBack` and `zFront`, with a rounded rail of radius `bevel` on both edges. */
export function slab(shape: Shape, zBack: number, zFront: number, bevel: number, segments = 4, curveSegments = 14): BufferGeometry {
  const depth = Math.max(1e-4, zFront - zBack - bevel * 2);
  const geometry = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: segments,
    curveSegments,
    steps: 1,
  });
  geometry.translate(0, 0, zBack + bevel);
  return geometry;
}

/**
 * A camera lens assembly turned on a lathe: polished guard ring, black barrel,
 * and a recessed glass element. Faces +Z from z = 0; callers rotate it onto the back.
 */
export function lensProfile(outer: number, height: number): { ring: BufferGeometry; glass: BufferGeometry; iris: BufferGeometry } {
  const wall = outer * 0.16;
  const ring = new LatheGeometry(
    [
      new Vector2(outer, 0),
      new Vector2(outer, height * 0.82),
      new Vector2(outer - wall * 0.35, height),
      new Vector2(outer - wall, height),
      new Vector2(outer - wall * 1.15, height * 0.7),
    ],
    48,
  );
  ring.rotateX(Math.PI / 2);
  const glassRadius = outer - wall * 1.1;
  const glass = new LatheGeometry(
    [new Vector2(0, height * 0.66), new Vector2(glassRadius * 0.6, height * 0.665), new Vector2(glassRadius, height * 0.7)],
    48,
  );
  glass.rotateX(Math.PI / 2);
  const iris = new LatheGeometry([new Vector2(0, height * 0.675), new Vector2(glassRadius * 0.42, height * 0.677)], 32);
  iris.rotateX(Math.PI / 2);
  return { ring, glass, iris };
}

/**
 * PBR materials for one model build. Meshes own them once merged, and
 * `disposeDeviceModel` releases every material a model's meshes use.
 */
export function createMaterialKit(finish: { frame: number; back: number; plateau?: number }) {
  // Brushed titanium: fully metallic, satin roughness, a thin protective coat.
  const frame = new MeshPhysicalMaterial({
    color: finish.frame,
    metalness: 1,
    roughness: 0.34,
    clearcoat: 0.25,
    clearcoatRoughness: 0.4,
    name: "frame",
  });
  /** Keys: the frame's metal, a touch smoother where fingers wear it. */
  const key = new MeshPhysicalMaterial({ color: finish.frame, metalness: 1, roughness: 0.26, name: "key" });
  const polished = new MeshPhysicalMaterial({ color: new Color(finish.frame).offsetHSL(0, 0, 0.08), metalness: 1, roughness: 0.14, name: "polished" });
  // Glossy, but with muted reflections so a wide bezel reads as black glass rather than a mirror.
  const frontGlass = new MeshPhysicalMaterial({
    color: 0x040507,
    metalness: 0.05,
    roughness: 0.2,
    specularIntensity: 0.25,
    clearcoat: 0.2,
    clearcoatRoughness: 0.2,
    envMapIntensity: 0.4,
    name: "front-glass",
  });
  const backGlass = new MeshPhysicalMaterial({
    color: finish.back,
    metalness: 0.15,
    roughness: 0.58,
    clearcoat: 0.35,
    clearcoatRoughness: 0.7,
    name: "back-glass",
  });
  const plateau = new MeshPhysicalMaterial({
    color: finish.plateau ?? finish.frame,
    metalness: 0.92,
    roughness: 0.42,
    clearcoat: 0.2,
    clearcoatRoughness: 0.5,
    name: "plateau",
  });
  const lensGlass = new MeshPhysicalMaterial({
    color: 0x0a0f1f,
    metalness: 0.4,
    roughness: 0.04,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    iridescence: 0.5,
    iridescenceIOR: 1.6,
    name: "lens-glass",
  });
  const lensIris = new MeshPhysicalMaterial({ color: 0x02030a, metalness: 0.2, roughness: 0.25, clearcoat: 1, name: "lens-iris" });
  const dark = new MeshStandardMaterial({ color: 0x0b0c0e, metalness: 0.3, roughness: 0.55, name: "dark" });
  const flash = new MeshStandardMaterial({ color: 0xf1ead8, emissive: 0x2a261c, roughness: 0.35, name: "flash" });
  /** Unlit black: the Dynamic Island and punch-hole read as cut-outs in any light. */
  const cutout = new MeshBasicMaterial({ color: 0x000000, name: "cutout" });
  return { frame, key, polished, frontGlass, backGlass, plateau, lensGlass, lensIris, dark, flash, cutout };
}

export type MaterialKit = ReturnType<typeof createMaterialKit>;

/**
 * Collects static parts by material and merges them into one mesh per material.
 * Named parts that other code looks up (displays, hinge groups) stay separate.
 */
export function createPartList() {
  const parts = new Map<Material, BufferGeometry[]>();
  return {
    /** Copies `geometry` (optionally placed by `matrix`); the caller keeps and disposes its template. */
    add(material: Material, geometry: BufferGeometry, matrix?: Matrix4) {
      let flat = geometry.clone();
      if (matrix) flat.applyMatrix4(matrix);
      if (flat.index) {
        const expanded = flat.toNonIndexed();
        flat.dispose();
        flat = expanded;
      }
      for (const name of Object.keys(flat.attributes)) {
        if (name !== "position" && name !== "normal" && name !== "uv") flat.deleteAttribute(name);
      }
      flat.clearGroups();
      const list = parts.get(material) ?? [];
      list.push(flat);
      parts.set(material, list);
    },
    /** Adds one merged mesh per material to `parent`. Source geometries are released. */
    mergeInto(parent: Object3D, prefix: string) {
      for (const [material, geometries] of parts) {
        const merged = geometries.length === 1 ? geometries[0]! : mergeGeometries(geometries, false);
        if (!merged) throw new Error(`Could not merge ${prefix} ${material.name}`);
        if (geometries.length > 1) for (const geometry of geometries) geometry.dispose();
        merged.computeBoundingBox();
        merged.computeBoundingSphere();
        const mesh = new Mesh(merged, material);
        mesh.name = `${prefix}-${material.name || "part"}`;
        parent.add(mesh);
      }
      parts.clear();
    },
  };
}

export type PartList = ReturnType<typeof createPartList>;

/** Translation/rotation helper for placing a reusable part. */
export function place(x: number, y: number, z: number, rotateX = 0, rotateY = 0, rotateZ = 0): Matrix4 {
  const matrix = new Matrix4().makeRotationZ(rotateZ);
  if (rotateY) matrix.premultiply(new Matrix4().makeRotationY(rotateY));
  if (rotateX) matrix.premultiply(new Matrix4().makeRotationX(rotateX));
  return matrix.premultiply(new Matrix4().makeTranslation(x, y, z));
}

/** Uniformly scales every geometry under `root` in place, so each mesh keeps an identity transform. */
export function bakeScale(root: Group, scale: number) {
  const matrix = new Matrix4().makeScale(scale, scale, scale);
  const seen = new Set<BufferGeometry>();
  root.traverse((object) => {
    if (object instanceof Mesh && !seen.has(object.geometry)) {
      seen.add(object.geometry);
      object.geometry.applyMatrix4(matrix);
      object.geometry.computeBoundingBox();
      object.geometry.computeBoundingSphere();
    }
    if (object !== root) object.position.multiplyScalar(scale);
  });
}
