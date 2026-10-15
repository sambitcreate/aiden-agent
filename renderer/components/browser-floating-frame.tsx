import * as React from "react";
import { GripHorizontal, PanelRight, PictureInPicture2, X } from "lucide-react";
import { browserFloatingFrame, resizeBrowserFloatingFrame, type BrowserFloatingEdge, type BrowserFloatingFrame as FloatingFrame, type BrowserFloatingSize } from "../lib/browser-floating-layout";
import { Button } from "./ui";
import { useFloatingContainerBounds } from "../lib/use-floating-container-bounds";

const rememberedFrames = new Map<string, { width: number; position: { x: number; y: number } }>();
const EDGES: BrowserFloatingEdge[] = ["north", "south", "east", "west", "northwest", "northeast", "southwest", "southeast"];

export function BrowserFloatingFrame({ frameKey, source, chromeHeight, pictureInPicture, children, onDock, onClose, onPictureInPicture, onLayout }: {
  frameKey: string; source: BrowserFloatingSize; chromeHeight: number; pictureInPicture?: boolean;
  children: React.ReactNode; onDock: () => void; onClose: () => void; onPictureInPicture: () => void; onLayout: () => void;
}) {
  const container = useFloatingContainerBounds();
  const [preference, setPreference] = React.useState(() => rememberedFrames.get(frameKey));
  const gesture = React.useRef<{ pointerId: number; x: number; y: number; frame: FloatingFrame; edge: BrowserFloatingEdge | null } | null>(null);
  const frame = browserFloatingFrame({ source, container, chromeHeight, ...preference });
  React.useLayoutEffect(onLayout, [frame.x, frame.y, frame.width, frame.height, container.x, container.y, onLayout]);
  const update = (next: FloatingFrame) => {
    const value = { width: next.width, position: { x: next.x, y: next.y } };
    rememberedFrames.set(frameKey, value); setPreference(value);
  };
  const begin = (event: React.PointerEvent<HTMLElement>, edge: BrowserFloatingEdge | null) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, frame, edge };
    event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation();
  };
  const move = (event: React.PointerEvent<HTMLElement>) => {
    const start = gesture.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const delta = { x: event.clientX - start.x, y: event.clientY - start.y };
    update(start.edge ? resizeBrowserFloatingFrame({ start: start.frame, edge: start.edge, delta, source, container, chromeHeight }) : browserFloatingFrame({ source, container, chromeHeight, width: start.frame.width, position: { x: start.frame.x + delta.x, y: start.frame.y + delta.y } }));
  };
  const end = (event: React.PointerEvent<HTMLElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <section className="browser-floating-frame" aria-label="Floating browser preview" data-browser-floating={frameKey} style={{ visibility: container.width > 0 && container.height > 0 ? undefined : "hidden", left: container.x + frame.x, top: container.y + frame.y, width: frame.width, height: frame.height }}>
    <div className="browser-floating-header" role="toolbar" aria-label="Move floating browser" tabIndex={0} onPointerDown={(event) => begin(event, null)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onKeyDown={(event) => {
      if (event.target !== event.currentTarget || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const step = event.shiftKey ? 40 : 10;
      update(browserFloatingFrame({ source, container, chromeHeight, width: frame.width, position: { x: frame.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), y: frame.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) } }));
    }}><GripHorizontal aria-hidden="true" /><span>Browser</span><Button size="small" variant="transparent" iconOnly aria-label="Return browser to Environment" title="Return to Environment" onClick={onDock}><PanelRight /></Button><Button size="small" variant={pictureInPicture ? "muted" : "transparent"} iconOnly aria-label={pictureInPicture ? "Close separate preview window" : "Open separate preview window"} onClick={onPictureInPicture}><PictureInPicture2 /></Button><Button size="small" variant="transparent" iconOnly aria-label="Close floating browser preview" onClick={onClose}><X /></Button></div>
    <div className="browser-floating-body">{children}</div>
    {EDGES.map((edge) => <div key={edge} className={`browser-floating-resize browser-floating-resize-${edge}`} role="separator" tabIndex={0} aria-label={`Resize floating browser ${edge}`} aria-valuemin={1} aria-valuemax={Math.round(container.width)} aria-valuenow={Math.round(frame.width)} onPointerDown={(event) => begin(event, edge)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onKeyDown={(event) => {
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault(); const step = event.shiftKey ? 40 : 10;
      update(resizeBrowserFloatingFrame({ start: frame, edge, delta: { x: event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, y: event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0 }, source, container, chromeHeight }));
    }} />)}
  </section>;
}
