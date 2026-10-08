// Adapted from t3code apps/web/src/components/device/DeviceDuoViewport.tsx @ a6ec88f7 (MIT).
import * as React from "react";
import { devicesApi } from "../lib/ipc";
import {
  createCanvasFrameSink,
  type DeviceScreenSize,
  type DeviceStreamClient,
  type DuoPanelSinks,
} from "../lib/device-stream";
import { createDuoPinch, type DuoPinch } from "../lib/device-duo-control";
import { createPhoneInteraction, type PhoneInteraction, type Point } from "../lib/device-3d/interaction";
import type { DuoViewer } from "../lib/device-3d/duo-viewer";
import { bindPhoneTrackpad, type PhoneTrackpad } from "../lib/device-3d/trackpad";

/** three.js loads only when a 3D view is first shown. */
const loadDuoViewer = () => import("../lib/device-3d/duo-viewer");
/** The bundled Duo GLB's URL; a module that cannot load leaves the procedural body. */
const loadModelAssets = () => import("../lib/device-3d/device-model-assets").catch(() => null);

export interface DeviceDuoViewportProps {
  /** The hidden canvas the stream client decodes the active display into. */
  source: React.RefObject<HTMLCanvasElement | null>;
  client: React.RefObject<DeviceStreamClient | null>;
  screen: DeviceScreenSize | null;
  /** The hinge angle a pending fold command asked for; the model moves before the device confirms. */
  hingePreview: number | null;
  controlError: string | null;
  onFrameListener(listener: (() => void) | null): void;
  onResetReady(reset: (() => void) | null): void;
  onCaptureReady?(capture: (() => Promise<Blob | null>) | null): void;
  /** Receives a canceller for captured input, for callers that send commands. */
  onInputCancel(cancel: (() => void) | null): void;
  onUnavailable(): void;
}

/** Web shell for the framework-independent Duo viewer. The decoded screen and input connection stay with DeviceViewer. */
export function DeviceDuoViewport({
  source,
  client,
  screen,
  hingePreview,
  controlError,
  onFrameListener,
  onResetReady,
  onCaptureReady,
  onInputCancel,
  onUnavailable,
}: DeviceDuoViewportProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const viewerRef = React.useRef<DuoViewer | null>(null);
  const interactionRef = React.useRef<PhoneInteraction | null>(null);
  const pinchRef = React.useRef<DuoPinch | null>(null);
  const trackpadRef = React.useRef<PhoneTrackpad | null>(null);
  const panelsRef = React.useRef<DuoPanelSinks | null>(null);
  const screenRef = React.useRef(screen);
  const previewRef = React.useRef(hingePreview);

  React.useEffect(() => {
    screenRef.current = screen;
    interactionRef.current?.end();
    viewerRef.current?.setScreen(screen);
    // Panels attach once the device reports its hinge, and again to a stream client
    // replaced by a reconnect. Attaching the same sinks twice is a no-op.
    if (panelsRef.current) client.current?.setDuoPanels(panelsRef.current);
  }, [screen, client]);

  // A refused command or a lost screen abandons any view the device did not confirm.
  React.useEffect(() => {
    if (controlError || !screen) {
      trackpadRef.current?.cancel();
      viewerRef.current?.rejectOrientation();
    }
  }, [controlError, screen]);

  React.useEffect(() => {
    previewRef.current = hingePreview;
    if (!pinchRef.current?.active) viewerRef.current?.setHingePreview(hingePreview);
  }, [hingePreview]);

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
    const blur = () => {
      interactionRef.current?.end();
      trackpad?.cancel();
      viewerRef.current?.cancelInput();
    };
    onInputCancel(blur);
    window.addEventListener("blur", blur);
    void Promise.all([loadDuoViewer(), loadModelAssets()])
      .then(([{ createDuoViewer }, assets]) => {
        if (disposed) return;
        const sources = { 1: document.createElement("canvas"), 3: document.createElement("canvas") };
        const viewer = createDuoViewer({
          canvas,
          sources,
          onUnavailable,
          // Every hinge-reporting iOS simulator is an iPhone Duo, so it gets the Duo's own body.
          asset: assets?.deviceModelSource("iphone-duo") ?? null,
          // A model that cannot load keeps the procedural body; the 3D view stays up.
          onModelError: (cause) => console.warn("iPhone Duo 3D model could not load", cause),
          // Snapping to the other display turns the device over; the hub confirms or the view rolls back.
          onPanelRequested: (panel) =>
            client.current?.controlDuo({ control: "physical", value: panel === 1 ? "facedown" : "faceup" }),
          onOrientationRequested: (value) => client.current?.controlDuo({ control: "orientation", value }),
        });
        viewerRef.current = viewer;
        onResetReady(viewer.resetPose);
        onCaptureReady?.(viewer.capture);
        viewer.setScreen(screenRef.current);
        const primaryFrame = () => {
          const panel = screenRef.current?.screenId;
          if (panel === 1 || panel === 3) viewer.frameUpdated(panel, decoded);
        };
        onFrameListener(primaryFrame);
        primaryFrame();
        viewer.setHingePreview(previewRef.current);
        const panelSink = (panel: 1 | 3) => {
          const sink = createCanvasFrameSink(sources[panel]);
          return {
            present(frame: CanvasImageSource, width: number, height: number) {
              const presented = sink.present(frame, width, height);
              if (presented) viewer.frameUpdated(panel);
              return presented;
            },
          };
        };
        panelsRef.current = {
          onScreen(next) {
            screenRef.current = next;
            interactionRef.current?.end();
            viewer.setScreen(next);
          },
          cover: panelSink(1),
          inner: panelSink(3),
        };
        client.current?.setDuoPanels(panelsRef.current);
        const interaction = createPhoneInteraction({
          screenPoint: (point, captured) => viewer.screenPoint(point.x, point.y, captured),
          touch: (phase, point) => client.current?.sendRawTouch(phase, point.x, point.y),
          orbit: viewer.orbit,
          // A pinch over the Duo folds its hinge; it never zooms.
          zoomBy: () => undefined,
          onInteractionActive: viewer.setInteractionActive,
        });
        interactionRef.current = interaction;
        const pinch = createDuoPinch({
          angle: () =>
            previewRef.current ?? screenRef.current?.hingeAngle ?? (screenRef.current?.screenId === 1 ? 0 : 180),
          contains: (x, y) => Boolean(screenRef.current) && viewer.beginHinge(x, y),
          change: (angle) => {
            // The model follows the fingers at once; the device confirms each angle in turn.
            viewer.setHingePreview(angle ?? previewRef.current, true);
            if (angle !== null) client.current?.controlDuo({ control: "angle", value: angle });
          },
        });
        pinchRef.current = pinch;
        trackpad = bindPhoneTrackpad(canvas, interaction, {
          begin(x, y) {
            interaction.end();
            return pinch.begin(x, y);
          },
          move: pinch.move,
          end: pinch.end,
        });
        trackpadRef.current = trackpad;
        stopTrackpadEnd = devicesApi.onTrackpadScrollEnd(() => trackpad?.endOrbit());
        resize();
      })
      .catch(() => {
        if (!disposed) onUnavailable();
      });
    return () => {
      disposed = true;
      stopTrackpadEnd?.();
      trackpad?.dispose();
      trackpadRef.current = null;
      pinchRef.current = null;
      interactionRef.current?.end();
      interactionRef.current = null;
      onInputCancel(null);
      onResetReady(null);
      onCaptureReady?.(null);
      onFrameListener(null);
      panelsRef.current = null;
      client.current?.setDuoPanels(null);
      observer.disconnect();
      window.removeEventListener("blur", blur);
      viewerRef.current?.dispose();
      viewerRef.current = null;
    };
  }, [source, client, onFrameListener, onResetReady, onCaptureReady, onInputCancel, onUnavailable]);

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
