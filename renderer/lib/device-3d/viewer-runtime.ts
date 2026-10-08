/**
 * The browser services a 3D device viewer needs, injectable so the viewers'
 * behaviour can be tested in Node without WebGL, timers or a DOM.
 *
 * Lighting follows T3's Duo viewer: a RoomEnvironment prefiltered with PMREM
 * gives the PBR materials real reflections, plus a key and fill light.
 */
import {
  PMREMGenerator,
  SRGBColorSpace,
  WebGLRenderer,
  type Camera,
  type Scene,
  type Texture,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export interface ViewerRenderer {
  setDrawingBufferSize(width: number, height: number, pixelRatio: number): void;
  render(scene: Scene, camera: Camera): void;
  dispose(): void;
  forceContextLoss(): void;
}

export interface ViewerEnvironment {
  readonly texture: Texture;
  dispose(): void;
}

/** A 2D canvas the viewer can draw into, such as the Duo's per-display surfaces. */
export interface ViewerCanvas {
  width: number;
  height: number;
  getContext(kind: "2d", options?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D | null;
}

export interface ViewerRuntime {
  createRenderer(canvas: HTMLCanvasElement): ViewerRenderer;
  /** Image-based lighting for the scene, or null when it cannot be prepared. */
  createEnvironment(renderer: ViewerRenderer): ViewerEnvironment | null;
  createCanvas(width: number, height: number): ViewerCanvas;
  now(): number;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  reducedMotion(): boolean;
}

export function browserViewerRuntime(): ViewerRuntime {
  return {
    createRenderer(canvas) {
      const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
      renderer.outputColorSpace = SRGBColorSpace;
      return renderer;
    },
    createEnvironment(renderer) {
      if (!(renderer instanceof WebGLRenderer)) return null;
      const generator = new PMREMGenerator(renderer);
      const room = new RoomEnvironment();
      try {
        return generator.fromScene(room, 0.04);
      } finally {
        room.dispose();
        generator.dispose();
      }
    },
    createCanvas(width, height) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
    now: () => performance.now(),
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (id) => cancelAnimationFrame(id),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer),
    reducedMotion: () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  };
}

/** Viewport clamp shared by both viewers: at least 1×, at most 2× device pixels. */
export function viewerPixelRatio(ratio: number) {
  return Math.min(2, Math.max(1, ratio));
}

/**
 * Encodes what the viewer just drew. The render and the snapshot run in the
 * same task, so the drawing buffer is still intact without `preserveDrawingBuffer`.
 */
export function captureCanvas(canvas: HTMLCanvasElement, render: () => void): Promise<Blob | null> {
  render();
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), "image/png");
    } catch {
      resolve(null);
    }
  });
}
