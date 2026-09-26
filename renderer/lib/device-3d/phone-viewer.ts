// Adapted from t3code packages/client-runtime/src/device/phoneViewer.ts @ 1c127066 (MIT).
// Procedural iOS bodies only: no imported models, fold scenes, or Android shells.
import {
  AmbientLight,
  Box3,
  CanvasTexture,
  DirectionalLight,
  LinearFilter,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from "three";
import type { DeviceScreenSize } from "../device-stream";
import { createRenderScheduler } from "./interaction";
import { createDeviceMotion } from "./motion";
import { createPhoneScene, phoneDisplayLayout, type PhoneScene } from "./phone-scene";
import { IOS_PHONE_SHAPE, type DeviceShapeProfile } from "./shape-profile";

export interface PhoneViewer {
  readonly frameUpdated: () => void;
  readonly setScreen: (screen: DeviceScreenSize | null, profile: DeviceShapeProfile) => void;
  readonly resize: (width: number, height: number, pixelRatio: number) => void;
  /** Normalized viewport point to normalized device point, or null off the display. */
  readonly screenPoint: (x: number, y: number, captured: boolean) => { x: number; y: number } | null;
  /** Deltas in viewport fractions. */
  readonly orbit: (deltaX: number, deltaY: number) => void;
  readonly release: () => void;
  readonly resetPose: () => void;
  readonly dispose: () => void;
}

const FIELD_OF_VIEW = 32;

/** Camera distance and centre that fit the current pose's bounds, with a small margin. */
export function fitCamera(bounds: Box3, verticalFovDegrees: number, aspect: number) {
  const tanY = Math.tan((verticalFovDegrees * Math.PI) / 360);
  const tanX = tanY * aspect;
  const size = bounds.getSize(new Vector3());
  const center = bounds.getCenter(new Vector3());
  const distance = Math.max(1, Math.max(size.x / tanX, size.y / tanY) * 0.565 + bounds.max.z);
  return { x: center.x, y: center.y, distance };
}

/** Owns only presentation resources. The caller retains the decoded canvas and the stream connection. */
export function createPhoneViewer(options: {
  readonly canvas: HTMLCanvasElement;
  readonly source: HTMLCanvasElement;
  readonly profile?: DeviceShapeProfile;
  readonly onUnavailable: () => void;
}): PhoneViewer {
  const renderer = new WebGLRenderer({
    canvas: options.canvas,
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  renderer.outputColorSpace = SRGBColorSpace;
  const makeTexture = () => {
    const next = new CanvasTexture(options.source);
    next.colorSpace = SRGBColorSpace;
    next.minFilter = LinearFilter;
    next.magFilter = LinearFilter;
    next.generateMipmaps = false;
    return next;
  };
  let texture = makeTexture();
  let textureWidth = options.source.width;
  let textureHeight = options.source.height;
  const scene = new Scene();
  const camera = new PerspectiveCamera(FIELD_OF_VIEW, 1, 0.1, 30);
  camera.position.z = 5.5;
  const key = new DirectionalLight(0xe4edff, 5);
  key.position.set(-3, 4, 5);
  const rim = new DirectionalLight(0xffffff, 4);
  rim.position.set(3, 1, -3);
  const fill = new DirectionalLight(0x9facd4, 2);
  fill.position.set(-2, -2, -4);
  scene.add(new AmbientLight(0xffffff, 2.4), key, rim, fill);

  let screen: DeviceScreenSize | null = null;
  let profile = options.profile ?? IOS_PHONE_SHAPE;
  /** The source canvas is 300×150 until the first frame lands; its size means nothing before that. */
  let hasFrame = false;
  const sourceWidth = () => (hasFrame ? options.source.width : 0);
  const sourceHeight = () => (hasFrame ? options.source.height : 0);
  let layout = phoneDisplayLayout(screen, sourceWidth(), sourceHeight());
  let phone: PhoneScene = createPhoneScene(texture, layout, profile);
  scene.add(phone.root);
  const motion = createDeviceMotion();
  const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
  let disposed = false;
  let failed = false;
  let viewport = { width: 0, height: 0, pixelRatio: 1 };
  let drawingBuffer = { width: 0, height: 0, pixelRatio: 0 };
  /** Framing is fitted to the resting pose, so the device holds its size while it turns. */
  let fit: ReturnType<typeof fitCamera> | null = null;

  const applyPose = () => {
    phone.root.rotation.set(motion.pitch(), motion.yaw(), 0, "XYZ");
    phone.orientation.rotation.z = layout.rotation;
  };
  const applyCamera = () => {
    if (!viewport.width || !viewport.height) return;
    if (!fit) {
      camera.aspect = viewport.width / viewport.height;
      phone.root.rotation.set(0, 0, 0);
      phone.root.updateMatrixWorld(true);
      fit = fitCamera(new Box3().setFromObject(phone.root as Object3D), FIELD_OF_VIEW, camera.aspect);
      applyPose();
      camera.position.set(fit.x, fit.y, fit.distance);
      camera.lookAt(fit.x, fit.y, 0);
      camera.updateProjectionMatrix();
    }
    phone.root.updateMatrixWorld(true);
  };
  const fail = () => {
    if (disposed || failed) return;
    // Latched: one failure, one fallback, and no further frames.
    failed = true;
    scheduler.dispose();
    options.onUnavailable();
  };
  const scheduler = createRenderScheduler(() => {
    if (disposed || failed || !viewport.width || !viewport.height) return;
    try {
      if (
        drawingBuffer.width !== viewport.width ||
        drawingBuffer.height !== viewport.height ||
        drawingBuffer.pixelRatio !== viewport.pixelRatio
      ) {
        renderer.setPixelRatio(viewport.pixelRatio);
        renderer.setSize(viewport.width, viewport.height, false);
        drawingBuffer = viewport;
      }
      motion.advance(performance.now(), reducedMotion?.matches ?? false);
      applyPose();
      applyCamera();
      renderer.render(scene, camera);
      if (motion.needsFrame()) scheduler.invalidate();
    } catch {
      fail();
    }
  });
  const updateLayout = (nextProfile: DeviceShapeProfile) => {
    const next = phoneDisplayLayout(screen, sourceWidth(), sourceHeight());
    const resized = textureWidth !== options.source.width || textureHeight !== options.source.height;
    if (resized) {
      // A native resolution change needs a texture of the new size; the scene survives.
      const previous = texture;
      texture = makeTexture();
      textureWidth = options.source.width;
      textureHeight = options.source.height;
      phone.setDisplay(texture, next);
      previous.dispose();
    }
    if (nextProfile !== profile || next.aspect !== layout.aspect) {
      scene.remove(phone.root);
      phone.dispose();
      phone = createPhoneScene(texture, next, nextProfile);
      scene.add(phone.root);
    } else if (next.rotation !== layout.rotation || next.rawLandscape !== layout.rawLandscape) {
      phone.setDisplay(texture, next);
    }
    if (
      nextProfile !== profile ||
      next.aspect !== layout.aspect ||
      next.rotation !== layout.rotation
    ) {
      fit = null;
    }
    layout = next;
    profile = nextProfile;
    applyPose();
  };
  const contextLost = (event: Event) => {
    event.preventDefault();
    fail();
  };
  options.canvas.addEventListener("webglcontextlost", contextLost);
  applyPose();

  return {
    frameUpdated() {
      if (disposed || failed) return;
      hasFrame = true;
      updateLayout(profile);
      texture.needsUpdate = true;
      scheduler.invalidate();
    },
    setScreen(next, nextProfile) {
      if (disposed) return;
      screen = next;
      updateLayout(nextProfile);
      scheduler.invalidate();
    },
    resize(width, height, pixelRatio) {
      if (disposed) return;
      if (![width, height, pixelRatio].every(Number.isFinite) || width <= 0 || height <= 0) return;
      const ratio = Math.min(2, Math.max(1, pixelRatio));
      if (viewport.width === width && viewport.height === height && viewport.pixelRatio === ratio) return;
      if (viewport.width !== width || viewport.height !== height) fit = null;
      viewport = { width, height, pixelRatio: ratio };
      scheduler.invalidate();
    },
    screenPoint(x, y, captured) {
      if (disposed || !viewport.width || !viewport.height) return null;
      applyPose();
      applyCamera();
      return phone.screenPoint(x, y, camera, captured);
    },
    orbit(deltaX, deltaY) {
      if (disposed) return;
      motion.orbit(deltaX * viewport.width, deltaY * viewport.height, performance.now());
      scheduler.invalidate();
    },
    release() {
      if (disposed) return;
      motion.release(performance.now());
      scheduler.invalidate();
    },
    resetPose() {
      if (disposed) return;
      motion.reset(performance.now());
      scheduler.invalidate();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scheduler.dispose();
      options.canvas.removeEventListener("webglcontextlost", contextLost);
      scene.remove(phone.root);
      phone.dispose();
      texture.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
