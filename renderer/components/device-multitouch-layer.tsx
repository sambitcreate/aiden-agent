/**
 * Extra input for the flat simulator screen, layered on without changing the
 * viewer's own single-touch and keyboard handling:
 *
 * - Option-drag pinches or rotates with two touches mirrored around the
 *   centre; Option+Shift-drag pans with two fingers. Touch dots show where
 *   both fingers are while Option is held.
 * - A trackpad pinch (a `wheel` event with `ctrlKey`) pinches the device.
 * - Cmd+V pastes the Mac clipboard's text into the focused field.
 *
 * Native listeners on the screen element run before React's delegated ones,
 * so a gesture claimed here stops its events from also becoming single
 * touches.
 */
import * as React from "react";
import {
  createMultiTouchGesture,
  createTrackpadPinch,
  multiTouchMode,
  type MultiTouchSink,
  type TouchPair,
} from "../lib/device-multitouch";
import { isDevicePasteShortcut } from "../lib/device-clipboard";

export function DeviceMultiTouchLayer(props: {
  screenRef: React.RefObject<HTMLElement | null>;
  /** Reads the current stream client at send time. */
  sink: MultiTouchSink;
  enabled: boolean;
  /** Cmd+V on the focused screen; omitted where pasting is unavailable. */
  onPaste?: () => void;
}) {
  const { screenRef, sink, enabled, onPaste } = props;
  const [dots, setDots] = React.useState<TouchPair | null>(null);
  const [pressed, setPressed] = React.useState(false);

  React.useEffect(() => {
    const surface = screenRef.current;
    if (!surface || !enabled) return;
    const gesture = createMultiTouchGesture(sink);
    const pinch = createTrackpadPinch({
      sink,
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (timer) => clearTimeout(timer),
      onEnd: () => setDots(null),
    });
    let pointerId: number | null = null;
    const point = (event: { clientX: number; clientY: number }) => {
      const rect = surface.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) / Math.max(1, rect.width),
        y: (event.clientY - rect.top) / Math.max(1, rect.height),
      };
    };
    const claim = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const down = (event: PointerEvent) => {
      const mode = multiTouchMode(event);
      if (!mode || event.button !== 0 || pointerId !== null) return;
      claim(event);
      pointerId = event.pointerId;
      surface.setPointerCapture(event.pointerId);
      surface.focus({ preventScroll: true });
      setDots(gesture.begin(point(event), mode));
      setPressed(true);
    };
    const move = (event: PointerEvent) => {
      if (pointerId === event.pointerId) {
        claim(event);
        const pair = gesture.move(point(event));
        if (pair) setDots(pair);
        return;
      }
      const mode = multiTouchMode(event);
      if (!pinch.active()) setDots(mode && event.buttons === 0 ? gesture.preview(point(event), mode) : null);
    };
    const up = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;
      claim(event);
      gesture.end();
      pointerId = null;
      setPressed(false);
      if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
      setDots(event.altKey ? gesture.preview(point(event), multiTouchMode(event) ?? "pinch") : null);
    };
    const leave = () => {
      if (pointerId === null && !pinch.active()) setDots(null);
    };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      claim(event);
      setDots(pinch.wheel({ deltaY: event.deltaY, point: point(event) }));
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.target !== surface || !onPaste || !isDevicePasteShortcut(event) || event.repeat) return;
      claim(event);
      onPaste();
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.key === "Alt" && pointerId === null) setDots(null);
    };
    surface.addEventListener("pointerdown", down);
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerup", up);
    surface.addEventListener("pointercancel", up);
    surface.addEventListener("pointerleave", leave);
    surface.addEventListener("wheel", wheel, { passive: false });
    surface.addEventListener("keydown", keyDown);
    surface.addEventListener("keyup", keyUp);
    return () => {
      surface.removeEventListener("pointerdown", down);
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerup", up);
      surface.removeEventListener("pointercancel", up);
      surface.removeEventListener("pointerleave", leave);
      surface.removeEventListener("wheel", wheel);
      surface.removeEventListener("keydown", keyDown);
      surface.removeEventListener("keyup", keyUp);
      // A view that goes away mid-gesture lifts both fingers.
      gesture.end();
      pinch.cancel();
      setDots(null);
      setPressed(false);
    };
  }, [screenRef, sink, enabled, onPaste]);

  if (!dots) return null;
  return (
    <div className="device-touch-dots" aria-hidden data-pressed={pressed || undefined}>
      {dots.map((dot, index) => (
        <span key={index} className="device-touch-dot" style={{ left: `${dot.x * 100}%`, top: `${dot.y * 100}%` }} />
      ))}
    </div>
  );
}
