import * as React from "react";
import { GripHorizontal, PanelRight, PictureInPicture2, X } from "lucide-react";
import { browserFloatingContentBounds, browserFloatingFrame, resizeBrowserFloatingFrame, type BrowserFloatingEdge, type BrowserFloatingFrame as FloatingFrame, type BrowserFloatingSize } from "../lib/browser-floating-layout";
import { Button } from "./ui";

const rememberedFrames = new Map<string, { width: number; position: { x: number; y: number } }>();
const EDGES: BrowserFloatingEdge[] = ["north", "south", "east", "west", "northwest", "northeast", "southwest", "southeast"];

export function BrowserFloatingFrame({ frameKey, source, chromeHeight, pictureInPicture, children, onDock, onClose, onPictureInPicture, onLayout }: {
  frameKey: string; source: BrowserFloatingSize; chromeHeight: number; pictureInPicture?: boolean;
  children: React.ReactNode; onDock: () => void; onClose: () => void; onPictureInPicture: () => void; onLayout: () => void;
}) {
  const [container, setContainer] = React.useState({ x: 0, y: 0, width: 0, height: 0 });
  const [preference, setPreference] = React.useState(() => rememberedFrames.get(frameKey));
  const gesture = React.useRef<{ pointerId: number; x: number; y: number; frame: FloatingFrame; edge: BrowserFloatingEdge | null } | null>(null);
  const frame = browserFloatingFrame({ source, container, chromeHeight, ...preference });
  React.useLayoutEffect(() => {
    const target = document.querySelector<HTMLElement>("[data-browser-floating-container]");
    const workbench = target?.closest<HTMLElement>("[data-environment-surface-mode]");
    let observed = new Set<HTMLElement>();
    let animationFrame = 0;
    const rect = (element: HTMLElement): FloatingFrame => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    };
    const measure = () => {
      animationFrame = 0;
      // ScrollArea's viewport excludes the terminal drawer; its absolute toolbar
      // is removed separately. The outer workbench can also contain an overlaid
      // Environment panel, so its full width is not the usable chat width.
      const viewport = target?.querySelector<HTMLElement>("[data-scroll-top]") ?? target;
      const toolbar = target?.querySelector<HTMLElement>("[data-toolbar]");
      const composer = target?.querySelector<HTMLElement>('[data-browser-composer-inset="true"]');
      const surfaces = Array.from(workbench?.querySelectorAll<HTMLElement>('[data-environment-surface][data-state="open"]') ?? []);
      const nextObserved = new Set([target, viewport, toolbar, composer, ...surfaces].filter((element): element is HTMLElement => Boolean(element)));
      for (const element of observed) if (!nextObserved.has(element)) observer.unobserve(element);
      for (const element of nextObserved) if (!observed.has(element)) observer.observe(element);
      observed = nextObserved;
      const next = viewport ? browserFloatingContentBounds({ viewport: rect(viewport), toolbar: toolbar ? rect(toolbar) : undefined, composer: composer ? rect(composer) : undefined, sideSurfaces: surfaces.map(rect) }) : { x: 0, y: 0, width: 0, height: 0 };
      setContainer((current) => Object.keys(next).every((key) => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next);
    };
    const schedule = () => { if (!animationFrame) animationFrame = window.requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    measure();
    const mutations = new MutationObserver(schedule);
    if (workbench ?? target) mutations.observe((workbench ?? target)!, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-browser-composer-inset", "data-state", "style"] });
    window.addEventListener("resize", schedule);
    document.addEventListener("transitionend", schedule, true);
    return () => { window.cancelAnimationFrame(animationFrame); observer.disconnect(); mutations.disconnect(); window.removeEventListener("resize", schedule); document.removeEventListener("transitionend", schedule, true); };
  }, []);
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
