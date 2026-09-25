// Adapted from t3code apps/web/src/components/device/DevicePhoneViewport.tsx @ 1c127066 (MIT).
import * as React from "react";
import type { DeviceScreenSize } from "../lib/device-stream";
import { createPhoneInteraction, wheelOrbit, type Point } from "../lib/device-3d/interaction";
import type { PhoneViewer } from "../lib/device-3d/phone-viewer";
import type { DeviceShapeProfile } from "../lib/device-3d/shape-profile";

/** three.js loads only when a 3D frame is first shown. */
const loadPhoneViewer = () => import("../lib/device-3d/phone-viewer");

/** Trackpad swipes have no end event; a short pause releases the orbit. */
const WHEEL_RELEASE_MS = 160;

export interface DevicePhoneViewportProps {
  /** The hidden canvas the stream client decodes into. */
  source: React.RefObject<HTMLCanvasElement | null>;
  screen: DeviceScreenSize | null;
  profile: DeviceShapeProfile;
  onFrameListener(listener: (() => void) | null): void;
  onResetReady(reset: (() => void) | null): void;
  touch(phase: "begin" | "move" | "end", point: Point): void;
  onUnavailable(): void;
}

/** Web shell for the framework-independent viewer. The decoded screen and input connection stay with DeviceViewer. */
export function DevicePhoneViewport({
  source,
  screen,
  profile,
  onFrameListener,
  onResetReady,
  touch,
  onUnavailable,
}: DevicePhoneViewportProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const viewerRef = React.useRef<PhoneViewer | null>(null);
  const interactionRef = React.useRef<ReturnType<typeof createPhoneInteraction> | null>(null);
  const wheelTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const screenRef = React.useRef(screen);
  const profileRef = React.useRef(profile);
  const touchRef = React.useRef(touch);
  touchRef.current = touch;

  React.useEffect(() => {
    screenRef.current = screen;
    profileRef.current = profile;
    // A new screen shape or orientation invalidates any captured touch.
    interactionRef.current?.end();
    viewerRef.current?.setScreen(screen, profile);
  }, [screen, profile]);

  React.useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const decoded = source.current;
    if (!host || !canvas || !decoded) return;
    let disposed = false;
    const resize = () => {
      const { width, height } = host.getBoundingClientRect();
      viewerRef.current?.resize(width, height, window.devicePixelRatio);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const blur = () => interactionRef.current?.end();
    window.addEventListener("blur", blur);
    void loadPhoneViewer()
      .then(({ createPhoneViewer }) => {
        if (disposed) return;
        const viewer = createPhoneViewer({ canvas, source: decoded, profile: profileRef.current, onUnavailable });
        viewerRef.current = viewer;
        viewer.setScreen(screenRef.current, profileRef.current);
        interactionRef.current = createPhoneInteraction({
          screenPoint: (point, captured) => viewer.screenPoint(point.x, point.y, captured),
          touch: (phase, point) => touchRef.current(phase, point),
          orbit: viewer.orbit,
          release: viewer.release,
        });
        onResetReady(viewer.resetPose);
        onFrameListener(viewer.frameUpdated);
        resize();
        viewer.frameUpdated();
      })
      .catch(() => {
        if (!disposed) onUnavailable();
      });
    return () => {
      disposed = true;
      if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
      wheelTimerRef.current = null;
      interactionRef.current?.end();
      interactionRef.current = null;
      onResetReady(null);
      onFrameListener(null);
      observer.disconnect();
      window.removeEventListener("blur", blur);
      viewerRef.current?.dispose();
      viewerRef.current = null;
    };
  }, [source, onFrameListener, onResetReady, onUnavailable]);

  // Wheel listeners must be non-passive to keep the panel from scrolling while orbiting.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      const delta = wheelOrbit({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        width: rect.width,
        height: rect.height,
      });
      if (!delta || !interactionRef.current?.wheel(delta)) return;
      event.preventDefault();
      if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
      wheelTimerRef.current = setTimeout(() => {
        wheelTimerRef.current = null;
        if (!interactionRef.current?.active()) viewerRef.current?.release();
      }, WHEEL_RELEASE_MS);
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, []);

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
