/**
 * Test-only stand-ins for the browser services a 3D viewer uses, so viewer
 * behaviour runs in Node: a recording renderer, manual frames, a manual clock
 * and timers, and 2D canvases that record what is drawn.
 */
import {
  Box3,
  Group,
  PerspectiveCamera,
  Texture,
  type BufferGeometry,
  type Camera,
  type Object3D,
  type Quaternion,
  type Scene,
} from "three";
import type { ViewerCanvas, ViewerRenderer, ViewerRuntime } from "./viewer-runtime";

export interface RecordedFrame {
  scene: Scene;
  root: Object3D | undefined;
  rotation: Quaternion | undefined;
  /** The root's first child's roll: the display orientation for phone scenes. */
  displayAngle: number | undefined;
  yaw: number | undefined;
  camera: PerspectiveCamera;
  bounds: Box3 | null;
}

export interface RendererState {
  blank: boolean;
  allocations: number;
  disposed: boolean;
  contextLost: boolean;
  size: { width: number; height: number; pixelRatio: number };
  frames: RecordedFrame[];
  failNextRender: boolean;
}

export function createTestRuntime(options: { reduced?: boolean; blankProbe?: boolean } = {}) {
  let now = 0;
  let nextFrame = 0;
  let nextTimer = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { at: number; run: () => void }>();
  const renderers: RendererState[] = [];
  let environmentsDisposed = 0;
  const drawn: unknown[] = [];
  let reduced = options.reduced ?? false;
  const runtime: ViewerRuntime = {
    createRenderer(): ViewerRenderer {
      const state: RendererState = {
        blank: true,
        allocations: 0,
        disposed: false,
        contextLost: false,
        size: { width: 0, height: 0, pixelRatio: 1 },
        frames: [],
        failNextRender: false,
      };
      renderers.push(state);
      return {
        setDrawingBufferSize(width, height, pixelRatio) {
          state.size = { width, height, pixelRatio };
          state.allocations++;
          state.blank = true;
        },
        render(scene: Scene, camera: Camera) {
          if (state.failNextRender) {
            state.failNextRender = false;
            throw new Error("GPU lost");
          }
          const root = scene.children.find((child) => child instanceof Group);
          root?.updateMatrixWorld(true);
          camera.updateMatrixWorld(true);
          state.frames.push({
            scene,
            root,
            rotation: root?.quaternion.clone(),
            displayAngle: root?.children[0]?.rotation.z,
            yaw: root?.rotation.y,
            camera: (camera as PerspectiveCamera).clone(),
            bounds: root ? new Box3().setFromObject(root) : null,
          });
          state.blank = false;
        },
        dispose() {
          state.disposed = true;
        },
        forceContextLoss() {
          state.contextLost = true;
        },
      };
    },
    createEnvironment: () => ({ texture: new Texture(), dispose: () => void environmentsDisposed++ }),
    createCanvas(width, height): ViewerCanvas {
      const canvas = {
        width,
        height,
        getContext: () =>
          ({
            fillStyle: "",
            fillRect() {},
            save() {},
            restore() {},
            translate() {},
            rotate() {},
            drawImage: (source: unknown) => void drawn.push(source),
            getImageData: (_x: number, _y: number, w: number, h: number) => ({
              data: new Uint8ClampedArray(w * h * 4).fill(options.blankProbe ? 0 : 255),
            }),
          }) as unknown as CanvasRenderingContext2D,
      };
      return canvas;
    },
    now: () => now,
    requestFrame(callback) {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelFrame: (id) => void frames.delete(id),
    setTimeout(run, ms) {
      timers.set(++nextTimer, { at: now + ms, run });
      return nextTimer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => void timers.delete(timer as unknown as number),
    reducedMotion: () => reduced,
  };
  /** Runs every queued animation frame at `time` (default: the current clock). */
  const draw = (time = now) => {
    now = time;
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(now);
  };
  return {
    runtime,
    renderers,
    drawn,
    environmentsDisposed: () => environmentsDisposed,
    pendingFrames: () => frames.size,
    draw,
    /** Draws until the viewer stops asking for frames, advancing `step` ms each frame. */
    settle(step = 16, limit = 10_000) {
      const end = now + limit;
      while (frames.size && now < end) draw(now + step);
    },
    setNow(time: number) {
      now = time;
    },
    now: () => now,
    /** Fires timers that are due after advancing the clock by `ms`. */
    advanceTimers(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.run();
        }
      }
    },
    setReduced(value: boolean) {
      reduced = value;
    },
  };
}

/**
 * A minimal binary glTF (GLB) built by hand: untextured meshes, optionally
 * under named group nodes. Enough to exercise the real GLTFLoader in Node.
 */
export function minimalGlb(
  meshes: ReadonlyArray<{ name: string; geometry: BufferGeometry; group?: string }>,
): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const push = (bytes: Uint8Array, target: number) => {
    const padded = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4);
    padded.set(bytes);
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, target });
    chunks.push(padded);
    byteLength += padded.byteLength;
    return bufferViews.length - 1;
  };
  const groups = [...new Set(meshes.flatMap((mesh) => (mesh.group ? [mesh.group] : [])))];
  const nodes: Array<{ name: string; mesh?: number; children?: number[] }> = groups.map((name) => ({ name, children: [] }));
  const roots: number[] = groups.map((_, index) => index);
  const gltfMeshes = meshes.map((mesh, index) => {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position");
    const positions = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) positions.set([position.getX(i), position.getY(i), position.getZ(i)], i * 3);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    accessors.push({
      bufferView: push(new Uint8Array(positions.buffer), 34962),
      componentType: 5126,
      count: position.count,
      type: "VEC3",
      min: box.min.toArray(),
      max: box.max.toArray(),
    });
    const attributes: Record<string, number> = { POSITION: accessors.length - 1 };
    const normal = geometry.getAttribute("normal");
    if (normal) {
      const normals = new Float32Array(normal.count * 3);
      for (let i = 0; i < normal.count; i++) normals.set([normal.getX(i), normal.getY(i), normal.getZ(i)], i * 3);
      accessors.push({ bufferView: push(new Uint8Array(normals.buffer), 34962), componentType: 5126, count: normal.count, type: "VEC3" });
      attributes.NORMAL = accessors.length - 1;
    }
    const primitive: Record<string, unknown> = { attributes };
    if (geometry.index) {
      const indices = Uint32Array.from(geometry.index.array as ArrayLike<number>);
      accessors.push({ bufferView: push(new Uint8Array(indices.buffer), 34963), componentType: 5125, count: indices.length, type: "SCALAR" });
      primitive.indices = accessors.length - 1;
    }
    nodes.push({ name: mesh.name, mesh: index });
    const node = nodes.length - 1;
    if (mesh.group) nodes[groups.indexOf(mesh.group)]!.children!.push(node);
    else roots.push(node);
    return { name: mesh.name, primitives: [primitive] };
  });
  const json = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: roots }],
      nodes,
      meshes: gltfMeshes,
      accessors,
      bufferViews,
      buffers: [{ byteLength }],
    }),
  );
  const jsonLength = Math.ceil(json.byteLength / 4) * 4;
  const total = 12 + 8 + jsonLength + 8 + byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(json, 20);
  let offset = 20 + jsonLength;
  view.setUint32(offset, byteLength, true);
  view.setUint32(offset + 4, 0x004e4942, true);
  offset += 8;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/** A WebGL canvas stand-in: an event target with the size fields the viewers touch. */
export function testCanvas(): HTMLCanvasElement {
  return Object.assign(new EventTarget(), {
    width: 0,
    height: 0,
    toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob(["png"], { type: "image/png" })),
  }) as unknown as HTMLCanvasElement;
}
