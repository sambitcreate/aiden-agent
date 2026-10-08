// Adapted from t3code apps/web/src/components/device/DevicePhoneViewport.tsx @ a6ec88f7 (MIT).
import * as React from "react";
import { devicesApi } from "../lib/ipc";
import type { DeviceScreenSize } from "../lib/device-stream";
import { createPhoneInteraction, type PhoneInteraction, type Point } from "../lib/device-3d/interaction";
import type { DeviceModelId } from "../lib/device-3d/model-registry";
import type { PhoneViewer } from "../lib/device-3d/phone-viewer";
import type { DeviceShapeProfile } from "../lib/device-3d/shape-profile";
import { bindPhoneTrackpad, type PhoneTrackpad } from "../lib/device-3d/trackpad";

/** three.js loads only when a 3D view is first shown. */
const loadPhoneViewer = () => import("../lib/device-3d/phone-viewer");

export interface DevicePhoneViewportProps {
  /** The hidden canvas the stream client decodes into. */
  source: React.RefObject<HTMLCanvasElement | null>;
  screen: DeviceScreenSize | null;
  profile: DeviceShapeProfile;
  /** A hardware model by exact simulator name, or null for the family body. */
  model: DeviceModelId | null;
  /**
   * Android foldables: the hinge angle (0 closed, 180 open), or null for a slab
   * phone. Fed by the Android fold controls' state.
   */
  foldAngle: number | null;
  onFrameListener(listener: (() => void) | null): void;
  onResetReady(reset: (() => void) | null): void;
  /** Receives a capture of the framed device while the 3D view is mounted. */
  onCaptureReady?(capture: (() => Promise<Blob | null>) | null): void;
  touch(phase: "begin" | "move" | "end", point: Point): void;
  onUnavailable(): void;
}

/** Web shell for the framework-independent viewer. The decoded screen and input connection stay with DeviceViewer. */
export function DevicePhoneViewport({
  source,
  screen,
  profile,
  model,
  foldAngle,
  onFrameListener,
  onResetReady,
  onCaptureReady,
  touch,
  onUnavailable,
}: DevicePhoneViewportProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const viewerRef = React.useRef<PhoneViewer | null>(null);
  const interactionRef = React.useRef<PhoneInteraction | null>(null);
  const screenRef = React.useRef(screen);
  const profileRef = React.useRef(profile);
  const modelRef = React.useRef(model);
  const foldAngleRef = React.useRef(foldAngle);
  const touchRef = React.useRef(touch);
  touchRef.current = touch;

  React.useEffect(() => {
    foldAngleRef.current = foldAngle;
    viewerRef.current?.setFoldAngle(foldAngle);
  }, [foldAngle]);

  React.useEffect(() => {
    screenRef.current = screen;
    profileRef.current = profile;
    modelRef.current = model;
    // A new screen shape or orientation invalidates any captured touch.
    interactionRef.current?.end();
    viewerRef.current?.setModel(model);
    viewerRef.current?.setScreen(screen, profile);
  }, [screen, profile, model]);

  React.useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const decoded = source.current;
    if (!host || !canvas || !decoded) return;
    let disposed = false;
    let trackpad: PhoneTrackpad | null = null;
    let stopTrackpadEnd: (() => void) | undefined;
    const resize = () => {
      const { width, height } = host.getBoundingClientRect();
      viewerRef.current?.resize(width, height, window.devicePixelRatio);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    // Moving between Retina and standard displays changes the pixel ratio without a resize.
    let ratioQuery: MediaQueryList | null = null;
    const watchRatio = () => {
      ratioQuery?.removeEventListener("change", ratioChanged);
      ratioQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`) ?? null;
      ratioQuery?.addEventListener("change", ratioChanged);
    };
    function ratioChanged() {
      resize();
      watchRatio();
    }
    watchRatio();
    const blur = () => {
      interactionRef.current?.end();
      trackpad?.cancel();
    };
    window.addEventListener("blur", blur);
    void loadPhoneViewer()
      .then(({ createPhoneViewer }) => {
        if (disposed) return;
        const viewer = createPhoneViewer({
          canvas,
          source: decoded,
          onUnavailable,
          profile: profileRef.current,
          model: modelRef.current,
          foldAngle: foldAngleRef.current,
        });
        viewerRef.current = viewer;
        viewer.setScreen(screenRef.current, profileRef.current);
        interactionRef.current = createPhoneInteraction({
          screenPoint: (point, captured) => viewer.screenPoint(point.x, point.y, captured),
          touch: (phase, point) => touchRef.current(phase, point),
          orbit: viewer.orbit,
          zoomBy: viewer.zoomBy,
          onInteractionActive: viewer.setInteractionActive,
        });
        trackpad = bindPhoneTrackpad(canvas, interactionRef.current);
        stopTrackpadEnd = devicesApi.onTrackpadScrollEnd(() => trackpad?.endOrbit());
        onResetReady(viewer.resetPose);
        onCaptureReady?.(viewer.capture);
        onFrameListener(viewer.frameUpdated);
        resize();
        viewer.frameUpdated();
      })
      .catch(() => {
        if (!disposed) onUnavailable();
      });
    return () => {
      disposed = true;
      stopTrackpadEnd?.();
      trackpad?.dispose();
      interactionRef.current?.end();
      interactionRef.current = null;
      onResetReady(null);
      onCaptureReady?.(null);
      onFrameListener(null);
      observer.disconnect();
      ratioQuery?.removeEventListener("change", ratioChanged);
      ratioQuery = null;
      window.removeEventListener("blur", blur);
      viewerRef.current?.dispose();
      viewerRef.current = null;
    };
  }, [source, onFrameListener, onResetReady, onCaptureReady, onUnavailable]);

  const point = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / Math.max(1, rect.width),
      y: (event.clientY - rect.top) / Math.max(1, rect.height),
    };
  };

  return (
    <div ref={hostRef} className="device-phone-viewport">
      <canvas
        ref={canvasRef}
        aria-hidden
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          if (!interactionRef.current?.begin(event.pointerId, point(event), event.altKey)) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          (event.currentTarget.closest('[role="application"]') as HTMLElement | null)?.focus({ preventScroll: true });
        }}
        onPointerMove={(event) => interactionRef.current?.move(event.pointerId, point(event))}
        onPointerUp={(event) => {
          interactionRef.current?.move(event.pointerId, point(event));
          interactionRef.current?.end(event.pointerId);
        }}
        onPointerCancel={(event) => interactionRef.current?.end(event.pointerId)}
        onLostPointerCapture={(event) => interactionRef.current?.end(event.pointerId)}
        onContextMenu={(event) => event.preventDefault()}
      />
    </div>
  );
}
