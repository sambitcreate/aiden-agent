// Adapted from t3code packages/client-runtime/src/device/phoneViewer.ts @ a6ec88f7 (MIT).
// T3 swaps in downloaded Apple GLB bodies; Aiden builds its own procedural
// hardware models synchronously (`hardware-models.ts`) and never fetches assets.
import {
  AmbientLight,
  Box3,
  CanvasTexture,
  DirectionalLight,
  LinearFilter,
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector3,
  type Group,
} from "three";
import type { DeviceScreenSize } from "../device-stream";
import { createAndroidFoldScene, DEFAULT_FOLD_INNER_ASPECT, isFoldInnerAspect } from "./android-fold-scene";
import { createDeviceMotion } from "./device-motion";
import { createDeviceFraming } from "./framing";
import { buildHandsetModel } from "./hardware-models";
import { createRenderScheduler } from "./interaction";
import { createModelPhoneScene, disposeDeviceModel } from "./model-scene";
import type { DeviceModelId } from "./model-registry";
import { createPhoneScene, phoneDisplayLayout } from "./phone-scene";
import { IOS_PHONE_SHAPE, type DeviceShapeProfile } from "./shape-profile";
import { nearestDeviceView } from "./view-snap";
import {
  browserViewerRuntime,
  captureCanvas,
  viewerPixelRatio,
  type ViewerEnvironment,
  type ViewerRuntime,
} from "./viewer-runtime";

export interface PhoneViewer {
  /** A hardware model by exact simulator name, or null for the family body. Duo bodies use `duo-viewer.ts`. */
  readonly setModel: (id: DeviceModelId | null) => void;
  readonly frameUpdated: () => void;
  readonly setScreen: (screen: DeviceScreenSize | null, profile?: DeviceShapeProfile) => void;
  /** Android foldables: hinge degrees (0 closed, 180 open), or null for a slab phone. */
  readonly setFoldAngle: (angle: number | null) => void;
  readonly resize: (width: number, height: number, pixelRatio: number) => void;
  /** Normalized viewport point to normalized device point, or null off the display. */
  readonly screenPoint: (x: number, y: number, captured?: boolean) => { x: number; y: number } | null;
  /** Deltas in viewport fractions. */
  readonly orbit: (deltaX: number, deltaY: number) => void;
  /** Natural-log zoom step; positive moves closer. */
  readonly zoomBy: (logDelta: number) => void;
  readonly setInteractionActive: (active: boolean, mode: "touch" | "orbit") => void;
  readonly resetPose: () => void;
  /** A PNG of the framed device as currently drawn. */
  readonly capture: () => Promise<Blob | null>;
  readonly dispose: () => void;
}

const ANDROID_ORIENTATION_TURN_MS = 450;
const ANDROID_FOLD_TURN_MS = 850;
/** Pinch zoom range, as natural-log steps from the fitted distance. */
export const PHONE_ZOOM_LIMITS = { closer: 0.9, farther: 0.6 } as const;

const isAndroid = (profile: DeviceShapeProfile) => profile.id.startsWith("android");

/** Owns only presentation resources. The caller retains the decoded canvas and the stream connection. */
export function createPhoneViewer(options: {
  readonly canvas: HTMLCanvasElement;
  readonly source: HTMLCanvasElement;
  readonly onUnavailable: () => void;
  readonly onFramingAspect?: (aspect: number) => void;
  readonly profile?: DeviceShapeProfile;
  readonly model?: DeviceModelId | null;
  readonly foldAngle?: number | null;
  readonly runtime?: ViewerRuntime;
}): PhoneViewer {
  const runtime = options.runtime ?? browserViewerRuntime();
  const renderer = runtime.createRenderer(options.canvas);
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
  let environment: ViewerEnvironment | null = null;
  try {
    environment = runtime.createEnvironment(renderer);
  } catch {
    // Reflections are a nicety; the lights below still show the device.
  }
  scene.environment = environment?.texture ?? null;
  const camera = new PerspectiveCamera(32, 1, 0.1, 30);
  camera.position.z = 5.5;
  const key = new DirectionalLight(0xffffff, 3.2);
  key.position.set(-3, 4, 5);
  const rim = new DirectionalLight(0xffffff, 2.2);
  rim.position.set(3, 1, -3);
  const fill = new DirectionalLight(0xc7dcff, 1.2);
  fill.position.set(-2, -2, -4);
  scene.add(new AmbientLight(0xffffff, environment ? 0.6 : 2.4), key, rim, fill);

  let screen: DeviceScreenSize | null = null;
  /** The source canvas is 300×150 until the first frame lands; its size means nothing before that. */
  let hasFrame = false;
  const sourceWidth = () => (hasFrame ? options.source.width : 0);
  const sourceHeight = () => (hasFrame ? options.source.height : 0);
  let layout = phoneDisplayLayout(screen, sourceWidth(), sourceHeight());
  let profile = options.profile ?? IOS_PHONE_SHAPE;
  let foldAngle = options.foldAngle ?? null;
  let orientationAngle = foldAngle !== null && isAndroid(profile) ? 0 : layout.rotation;
  let orientationTurn: { from: number; to: number; startedAt: number } | null = null;
  let foldTurn: { from: number; to: number; startedAt: number } | null = null;
  let modelId: DeviceModelId | null = null;
  let modelAsset: Group | null = null;
  // The inner display's raw width over height. Cover frames leave the last unfolded shape.
  const rawAspect = () => (hasFrame ? options.source.width / options.source.height : Number.NaN);
  let foldAspect = isFoldInnerAspect(rawAspect()) ? rawAspect() : DEFAULT_FOLD_INNER_ASPECT;
  const createFoldScene = (angle: number, displayLayout = layout) =>
    createAndroidFoldScene(texture, displayLayout, angle, foldAspect);
  /** The hinge angle currently on screen, including an unfinished turn. */
  const visibleFoldAngle = (fallback: number) => {
    if (!foldTurn) return fallback;
    const progress = Math.min(1, (runtime.now() - foldTurn.startedAt) / ANDROID_FOLD_TURN_MS);
    const eased = progress * progress * (3 - 2 * progress);
    return foldTurn.from + (foldTurn.to - foldTurn.from) * eased;
  };
  type AnyScene =
    | ReturnType<typeof createPhoneScene>
    | ReturnType<typeof createAndroidFoldScene>
    | ReturnType<typeof createModelPhoneScene>;
  const familyScene = (): AnyScene =>
    foldAngle !== null && isAndroid(profile) ? createFoldScene(foldAngle) : createPhoneScene(texture, layout, profile);
  let phone: AnyScene = familyScene();
  scene.add(phone.root);
  let disposed = false;
  let failed = false;
  const rest = new Quaternion();
  const motion = createDeviceMotion({
    choose: (rotation) => nearestDeviceView(rotation, [{ rotation: new Quaternion(), yawLimit: Math.PI / 3 }])!.rotation,
  });
  motion.setPose(rest, runtime.now(), true);
  const framing = createDeviceFraming();
  let zoom = 0;
  let viewport = { width: 0, height: 0, pixelRatio: 1 };
  let drawingBuffer = { width: 0, height: 0, pixelRatio: 0 };
  let framingAspect: number | null = null;

  const applyCamera = () => {
    camera.position.set(framing.center.x, framing.center.y, framing.distance() * Math.exp(-zoom));
    camera.lookAt(framing.center.x, framing.center.y, 0);
    camera.updateProjectionMatrix();
  };
  const fit = (immediate = false) => {
    if (!viewport.width || !viewport.height) return;
    camera.aspect = viewport.width / viewport.height;
    const bounds = new Box3(
      new Vector3(-phone.width / 2, -phone.height / 2, 0),
      new Vector3(phone.width / 2, phone.height / 2, 0),
    );
    bounds.applyMatrix4(new Matrix4().makeRotationZ(orientationAngle));
    const size = bounds.getSize(new Vector3());
    const aspect = size.x / size.y;
    if (aspect !== framingAspect) {
      framingAspect = aspect;
      options.onFramingAspect?.(aspect);
    }
    phone.root.updateMatrixWorld(true);
    framing.setBounds(new Box3().setFromObject(phone.root), (camera.fov * Math.PI) / 360, camera.aspect, runtime.now(), immediate);
    applyCamera();
  };
  const applyPose = () => {
    phone.root.quaternion.copy(motion.rotation);
    phone.orientation.rotation.z = orientationAngle;
  };
  const fail = () => {
    if (disposed || failed) return;
    // Latched: one failure, one fallback, and no further frames.
    failed = true;
    scheduler.dispose();
    options.onUnavailable();
  };
  const draw = () => {
    if (
      drawingBuffer.width !== viewport.width ||
      drawingBuffer.height !== viewport.height ||
      drawingBuffer.pixelRatio !== viewport.pixelRatio
    ) {
      // Canvas allocation clears the previous image. Commit it with the redraw,
      // rather than exposing an empty buffer between ResizeObserver and the next frame.
      renderer.setDrawingBufferSize(viewport.width, viewport.height, viewport.pixelRatio);
      drawingBuffer = viewport;
    }
    renderer.render(scene, camera);
  };
  const scheduler = createRenderScheduler(
    () => {
      if (disposed || failed || !viewport.width || !viewport.height) return;
      try {
        const now = runtime.now();
        const reduced = runtime.reducedMotion();
        if (motion.advance(now, reduced)) {
          applyPose();
          fit(reduced);
        }
        if (orientationTurn) {
          const progress = Math.min(1, (now - orientationTurn.startedAt) / ANDROID_ORIENTATION_TURN_MS);
          const eased = progress * progress * (3 - 2 * progress);
          orientationAngle = orientationTurn.from + (orientationTurn.to - orientationTurn.from) * eased;
          if (progress === 1) orientationTurn = null;
          applyPose();
          fit(reduced);
        }
        if (foldTurn && "setAngle" in phone) {
          const progress = Math.min(1, (now - foldTurn.startedAt) / ANDROID_FOLD_TURN_MS);
          const eased = progress * progress * (3 - 2 * progress);
          phone.setAngle(foldTurn.from + (foldTurn.to - foldTurn.from) * eased);
          if (progress === 1) foldTurn = null;
          fit(reduced);
        }
        framing.advance(now, reduced);
        applyCamera();
        draw();
        if (motion.needsFrame() || framing.needsFrame() || orientationTurn || foldTurn) scheduler.invalidate();
      } catch {
        fail();
      }
    },
    (callback) => runtime.requestFrame(callback),
    (id) => runtime.cancelFrame(id),
  );
  const updateLayout = (nextProfile = profile) => {
    const next = phoneDisplayLayout(screen, sourceWidth(), sourceHeight());
    const resized = textureWidth !== options.source.width || textureHeight !== options.source.height;
    if (
      resized ||
      nextProfile !== profile ||
      next.aspect !== layout.aspect ||
      next.rawLandscape !== layout.rawLandscape ||
      next.rotation !== layout.rotation
    ) {
      // The model and renderer survive framebuffer rotation and native resolution changes.
      if (resized) {
        const previous = texture;
        texture = makeTexture();
        textureWidth = options.source.width;
        textureHeight = options.source.height;
        phone.setDisplay(texture, next);
        previous.dispose();
      }
      // Learn the inner display shape from any unfolded frame, including before fold mode.
      const frameAspect = rawAspect();
      const innerChanged = isFoldInnerAspect(frameAspect) && frameAspect !== foldAspect;
      if (innerChanged) foldAspect = frameAspect;
      const imported = modelAsset !== null;
      if (!imported && "setAngle" in phone && innerChanged) {
        // A new inner display shape resizes the body; the hinge keeps its visible angle.
        const angle = visibleFoldAngle(foldAngle ?? 180);
        scene.remove(phone.root);
        phone.dispose();
        phone = createFoldScene(angle, next);
        scene.add(phone.root);
      } else if (!imported && !("setAngle" in phone) && (nextProfile !== profile || next.aspect !== layout.aspect)) {
        scene.remove(phone.root);
        phone.dispose();
        phone = createPhoneScene(texture, next, nextProfile);
        scene.add(phone.root);
      } else {
        phone.setDisplay(texture, next);
      }
      if (next.rotation !== layout.rotation) {
        if (isAndroid(nextProfile) && !("setAngle" in phone) && !runtime.reducedMotion()) {
          const difference = Math.atan2(Math.sin(next.rotation - orientationAngle), Math.cos(next.rotation - orientationAngle));
          orientationTurn = { from: orientationAngle, to: orientationAngle + difference, startedAt: runtime.now() };
        } else {
          orientationTurn = null;
          orientationAngle = "setAngle" in phone ? 0 : next.rotation;
        }
      }
      layout = next;
      profile = nextProfile;
      applyPose();
      fit(!orientationTurn);
    }
    applyPose();
  };
  /** Prepares the next scene before releasing the visible one; a model that fails to build keeps the family body. */
  const installModel = (id: DeviceModelId | null) => {
    let asset: Group | null = null;
    let next: AnyScene;
    try {
      asset = id && id !== "iphone-duo" ? buildHandsetModel(id) : null;
      next = asset ? createModelPhoneScene(asset, texture, layout) : familyScene();
    } catch {
      if (asset) disposeDeviceModel(asset);
      asset = null;
      next = familyScene();
    }
    foldTurn = null;
    scene.remove(phone.root);
    phone.dispose();
    if (modelAsset) disposeDeviceModel(modelAsset);
    modelAsset = asset;
    phone = next;
    scene.add(phone.root);
    applyPose();
    fit(true);
    scheduler.invalidate();
  };
  const contextLost = (event: Event) => {
    event.preventDefault();
    fail();
  };
  options.canvas.addEventListener("webglcontextlost", contextLost);
  applyPose();
  if (options.model) {
    modelId = options.model;
    installModel(modelId);
  }

  return {
    setModel(id) {
      if (disposed || id === modelId) return;
      modelId = id;
      installModel(id);
    },
    setFoldAngle(next) {
      if (disposed || next === foldAngle) return;
      const previous = foldAngle;
      foldAngle = next;
      // A hardware model owns the scene; reinstalling it reads foldAngle if it is removed.
      if (modelAsset) return;
      if (next === null || !("setAngle" in phone)) {
        if (next !== null && !isAndroid(profile)) return;
        scene.remove(phone.root);
        phone.dispose();
        phone = next === null ? createPhoneScene(texture, layout, profile) : createFoldScene(next);
        scene.add(phone.root);
        orientationTurn = null;
        orientationAngle = next === null ? layout.rotation : 0;
        foldTurn = null;
        applyPose();
        fit(true);
      } else {
        const from = visibleFoldAngle(previous ?? next);
        if (runtime.reducedMotion()) {
          foldTurn = null;
          phone.setAngle(next);
          fit(true);
        } else {
          foldTurn = { from, to: next, startedAt: runtime.now() };
        }
      }
      scheduler.invalidate();
    },
    frameUpdated() {
      if (disposed || failed) return;
      hasFrame = true;
      updateLayout();
      texture.needsUpdate = true;
      scheduler.invalidate();
    },
    setScreen(next, nextProfile = profile) {
      if (disposed) return;
      screen = next;
      updateLayout(nextProfile);
      scheduler.invalidate();
    },
    resize(width, height, pixelRatio) {
      if (disposed) return;
      if (![width, height, pixelRatio].every(Number.isFinite) || width <= 0 || height <= 0) return;
      const ratio = viewerPixelRatio(pixelRatio);
      if (viewport.width === width && viewport.height === height && viewport.pixelRatio === ratio) return;
      viewport = { width, height, pixelRatio: ratio };
      fit(true);
      scheduler.invalidate();
    },
    screenPoint(x, y, captured = false) {
      if (disposed || !viewport.width || !viewport.height) return null;
      applyPose();
      return phone.screenPoint(x, y, camera, captured);
    },
    orbit(deltaX, deltaY) {
      if (disposed) return;
      motion.orbit(deltaX * viewport.width, deltaY * viewport.height, runtime.now());
      scheduler.invalidate();
    },
    zoomBy(logDelta) {
      if (disposed || !Number.isFinite(logDelta)) return;
      const next = Math.min(PHONE_ZOOM_LIMITS.closer, Math.max(-PHONE_ZOOM_LIMITS.farther, zoom + logDelta));
      if (next === zoom) return;
      zoom = next;
      applyCamera();
      scheduler.invalidate();
    },
    setInteractionActive(active, mode) {
      if (disposed) return;
      const now = runtime.now();
      if (mode === "orbit") motion.dragActive(active, now);
      else {
        motion.hold(active, now);
        framing.hold(active, now);
      }
      scheduler.invalidate();
    },
    resetPose() {
      if (disposed) return;
      zoom = 0;
      motion.reset(rest, runtime.now());
      scheduler.invalidate();
    },
    capture() {
      if (disposed || failed || !viewport.width || !viewport.height) return Promise.resolve(null);
      return captureCanvas(options.canvas, () => {
        applyPose();
        applyCamera();
        draw();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scheduler.dispose();
      options.canvas.removeEventListener("webglcontextlost", contextLost);
      scene.remove(phone.root);
      phone.dispose();
      if (modelAsset) disposeDeviceModel(modelAsset);
      modelAsset = null;
      texture.dispose();
      scene.environment = null;
      environment?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
