/**
 * Test-only stand-ins for the browser services a 3D viewer uses, so viewer
 * behaviour runs in Node: a recording renderer, manual frames, a manual clock
 * and timers, and 2D canvases that record what is drawn.
 */
import { Box3, Group, PerspectiveCamera, Texture, type Camera, type Object3D, type Quaternion, type Scene } from "three";
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

/** A WebGL canvas stand-in: an event target with the size fields the viewers touch. */
export function testCanvas(): HTMLCanvasElement {
  return Object.assign(new EventTarget(), {
    width: 0,
    height: 0,
    toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob(["png"], { type: "image/png" })),
  }) as unknown as HTMLCanvasElement;
}
