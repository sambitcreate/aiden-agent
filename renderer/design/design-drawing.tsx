// The drawing tools on the design canvas: Text, Frame, Rectangle, Oval,
// Arrow, Line, Pencil and Pen.
//
// While one is chosen the canvas takes the pointer as a whole (frames do not
// move or take clicks; see `.design-drawing` in design-canvas.css). A press
// on the canvas starts the item and a release makes it; a click without a
// drag makes one of a standard size. Shift keeps a box square and a line at
// 45° steps. Every tool but the Pencil goes back to Select once it has made
// something. The Pen adds a corner per click and a curve per drag, and
// finishes with Enter, Escape, a double-click, or a click on its first point.

import { ViewportPortal, type ReactFlowInstance } from "@xyflow/react";
import * as React from "react";
import type { DesignPoint } from "../shared/design-canvas/connectors";
import { boxFromDrag, simplifyStroke, snapAngle, strokeFromCanvas } from "../shared/design-canvas/drawing";
import type { DesignConnectorEnd } from "../shared/design-canvas/schema";
import type { DesignNode, PlaceFrameInput } from "./canvas-adapter-core";
import { DESIGN_DRAW_DEFAULTS, DESIGN_TEXT_PX } from "./nodes/draw-style";

export type DesignDrawTool = "text" | "frame" | "rect" | "oval" | "arrow" | "line" | "pencil" | "pen";

/** A press that moves less than this many screen pixels is a click. */
const CLICK_SLOP_PX = 4;
/** A pen click this close to the first point, in screen pixels, closes the path. */
const CLOSE_PATH_PX = 8;

/** The size a click without a drag makes. */
const CLICK_SIZE = {
  rect: { w: 160, h: 100 },
  oval: { w: 120, h: 120 },
  frame: { w: 640, h: 400 },
  text: { w: 240 },
  line: 160,
} as const;

const TEXT_LINE_PX = Math.ceil(DESIGN_TEXT_PX[DESIGN_DRAW_DEFAULTS.text.size] * 1.3);

type Draft =
  | { type: "box"; tool: "rect" | "oval" | "frame" | "text"; from: DesignPoint; to: DesignPoint; square: boolean }
  | { type: "line"; tool: "arrow" | "line"; from: DesignPoint; to: DesignPoint }
  | { type: "pencil"; points: DesignPoint[] };

type PenPath = { anchors: DesignPoint[]; handles: DesignPoint[]; hover: DesignPoint | null; pressed: boolean };

export function useDesignDrawing({
  tool,
  onDone,
  flow,
  wrapper,
  create,
  attachAt,
}: {
  tool: DesignDrawTool | null;
  /** The tool made its item and steps aside for Select. */
  onDone(): void;
  flow: React.RefObject<ReactFlowInstance<DesignNode> | null>;
  wrapper: React.RefObject<HTMLDivElement | null>;
  /** Places an item at its own box; returns its id, or null when the canvas is full. */
  create(input: PlaceFrameInput, options?: { edit?: boolean }): string | null;
  /** The frame on the page on screen that an arrow end at `point` joins, if any. */
  attachAt(point: DesignPoint, except?: string): string | undefined;
}) {
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [pen, setPen] = React.useState<PenPath | null>(null);
  const penRef = React.useRef<PenPath | null>(null);
  penRef.current = pen;

  const latest = React.useRef({ tool, onDone, create, attachAt });
  latest.current = { tool, onDone, create, attachAt };

  const zoom = () => flow.current?.getViewport().zoom || 1;
  const toFlow = (event: { clientX: number; clientY: number }) =>
    flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: event.clientX, y: event.clientY };

  const finishPen = React.useCallback((closed: boolean) => {
    const path = penRef.current;
    setPen(null);
    if (!path || path.anchors.length < 2) return path !== null;
    const width = DESIGN_DRAW_DEFAULTS.stroke.strokeWidth;
    const stroke = strokeFromCanvas(path.anchors, width, path.handles);
    if (stroke) {
      latest.current.create({
        kind: "stroke",
        title: "Pen path",
        ...stroke,
        color: DESIGN_DRAW_DEFAULTS.stroke.color,
        strokeWidth: width,
        ...(closed ? { closed: true as const } : {}),
        createdBy: "person",
      });
    }
    latest.current.onDone();
    return true;
  }, []);

  // A different tool, or none, drops anything half drawn; a pen path with two points is kept.
  React.useEffect(() => {
    if (tool === "pen") return;
    setDraft(null);
    if (penRef.current) finishPen(false);
  }, [tool, finishPen]);

  React.useEffect(() => {
    const element = wrapper.current;
    if (!element || tool === null) return;
    let pointer: number | null = null;
    let start: { screen: DesignPoint; flow: DesignPoint } | null = null;
    let current: Draft | null = null;
    const set = (next: Draft | null) => {
      current = next;
      setDraft(next);
    };

    const onCanvas = (target: EventTarget | null) =>
      target instanceof Element &&
      target.closest(".react-flow__renderer") !== null &&
      target.closest(".react-flow__panel") === null;

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || !onCanvas(event.target)) return;
      // The press is the tool's: React Flow does not pan, select or drag with it.
      event.preventDefault();
      event.stopPropagation();
      element.querySelector<HTMLElement>(".studio-canvas")?.focus({ preventScroll: true });
      pointer = event.pointerId;
      element.setPointerCapture?.(event.pointerId);
      const at = toFlow(event);
      start = { screen: { x: event.clientX, y: event.clientY }, flow: at };
      const active = latest.current.tool;
      if (active === "pen") {
        const path = penRef.current;
        const first = path?.anchors[0];
        if (path && first && path.anchors.length >= 2) {
          const away = Math.hypot(at.x - first.x, at.y - first.y) * zoom();
          if (away <= CLOSE_PATH_PX) {
            pointer = null;
            finishPen(true);
            return;
          }
        }
        setPen({
          anchors: [...(path?.anchors ?? []), at],
          handles: [...(path?.handles ?? []), { x: 0, y: 0 }],
          hover: null,
          pressed: true,
        });
        return;
      }
      if (active === "pencil") set({ type: "pencil", points: [at] });
      else if (active === "arrow" || active === "line") set({ type: "line", tool: active, from: at, to: at });
      else if (active) set({ type: "box", tool: active, from: at, to: at, square: event.shiftKey });
    };

    const onMove = (event: PointerEvent) => {
      const at = toFlow(event);
      if (latest.current.tool === "pen") {
        const path = penRef.current;
        if (!path) return;
        if (pointer === event.pointerId && path.pressed) {
          // Dragging out from the new point gives it a curve.
          const anchor = path.anchors[path.anchors.length - 1]!;
          const handles = [...path.handles];
          handles[handles.length - 1] = { x: at.x - anchor.x, y: at.y - anchor.y };
          setPen({ ...path, handles });
        } else {
          setPen({ ...path, hover: at });
        }
        return;
      }
      if (pointer !== event.pointerId || !current) return;
      if (current.type === "pencil") set({ type: "pencil", points: [...current.points, at] });
      else if (current.type === "line") set({ ...current, to: event.shiftKey ? snapAngle(current.from, at) : at });
      else set({ ...current, to: at, square: event.shiftKey });
    };

    const onUp = (event: PointerEvent) => {
      if (pointer !== event.pointerId) return;
      pointer = null;
      element.releasePointerCapture?.(event.pointerId);
      if (latest.current.tool === "pen") {
        const path = penRef.current;
        if (path) setPen({ ...path, pressed: false });
        return;
      }
      const made = current;
      const began = start;
      set(null);
      if (!made || !began) return;
      const moved = Math.hypot(event.clientX - began.screen.x, event.clientY - began.screen.y) > CLICK_SLOP_PX;
      if (make(made, moved)) {
        if (made.type !== "pencil") latest.current.onDone();
      }
    };

    const onCancel = (event: PointerEvent) => {
      if (pointer !== event.pointerId) return;
      pointer = null;
      set(null);
    };

    const onDoubleClick = (event: MouseEvent) => {
      if (latest.current.tool !== "pen" || !onCanvas(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      // The double-click's two presses each added the same point; finish without the repeat.
      const path = penRef.current;
      if (path && path.anchors.length > 2) {
        penRef.current = { ...path, anchors: path.anchors.slice(0, -1), handles: path.handles.slice(0, -1) };
      }
      finishPen(false);
    };

    /** Makes the item a finished draft stands for; false when nothing was made. */
    const make = (made: Draft, moved: boolean): boolean => {
      const { create: place, attachAt: attach } = latest.current;
      if (made.type === "pencil") {
        if (made.points.length < 2) return false;
        const width = DESIGN_DRAW_DEFAULTS.stroke.strokeWidth;
        const stroke = strokeFromCanvas(simplifyStroke(made.points, 0.75 / zoom()), width);
        if (!stroke) return false;
        return (
          place({
            kind: "stroke",
            title: "Drawing",
            ...stroke,
            color: DESIGN_DRAW_DEFAULTS.stroke.color,
            strokeWidth: width,
            createdBy: "person",
          }) !== null
        );
      }
      if (made.type === "line") {
        const from = made.from;
        const to = moved ? made.to : { x: from.x + CLICK_SIZE.line, y: from.y };
        const fromFrame = attach(from);
        const toFrame = attach(to);
        const end = (point: DesignPoint, frameId: string | undefined): DesignConnectorEnd => ({
          x: Math.round(point.x),
          y: Math.round(point.y),
          ...(frameId ? { frameId } : {}),
        });
        return (
          place({
            kind: "connector",
            title: made.tool === "arrow" ? "Arrow" : "Line",
            x: Math.round(Math.min(from.x, to.x)),
            y: Math.round(Math.min(from.y, to.y)),
            w: 1,
            h: 1,
            // Both ends on one frame would draw a loop; the second end stays free instead.
            ends: [end(from, fromFrame), end(to, toFrame !== fromFrame ? toFrame : undefined)],
            ...(made.tool === "arrow" ? { arrow: "end" as const } : {}),
            color: DESIGN_DRAW_DEFAULTS.connector.color,
            strokeWidth: DESIGN_DRAW_DEFAULTS.connector.strokeWidth,
            createdBy: "person",
          }) !== null
        );
      }
      const { tool: kind, from } = made;
      if (kind === "text") {
        const w = moved ? Math.max(40, Math.abs(made.to.x - from.x)) : CLICK_SIZE.text.w;
        const x = moved ? Math.min(from.x, made.to.x) : from.x;
        const y = (moved ? Math.min(from.y, made.to.y) : from.y) - (moved ? 0 : TEXT_LINE_PX / 2);
        return (
          place(
            {
              kind: "text",
              title: "Text",
              text: "",
              size: DESIGN_DRAW_DEFAULTS.text.size,
              x: Math.round(x),
              y: Math.round(y),
              w: Math.round(w),
              h: TEXT_LINE_PX,
              createdBy: "person",
            },
            { edit: true },
          ) !== null
        );
      }
      const size = CLICK_SIZE[kind];
      const box = moved
        ? boxFromDrag(from, made.to, { square: made.square })
        : { x: Math.round(from.x - size.w / 2), y: Math.round(from.y - size.h / 2), w: size.w, h: size.h };
      if (kind === "frame") {
        return place({ kind: "frame", title: "Frame", ...box, createdBy: "person" }) !== null;
      }
      return (
        place({
          kind: "shape",
          title: kind === "oval" ? "Oval" : "Rectangle",
          shape: kind,
          ...box,
          fill: DESIGN_DRAW_DEFAULTS.shape.fill,
          color: DESIGN_DRAW_DEFAULTS.shape.color,
          strokeWidth: DESIGN_DRAW_DEFAULTS.shape.strokeWidth,
          createdBy: "person",
        }) !== null
      );
    };

    element.addEventListener("pointerdown", onDown, true);
    element.addEventListener("pointermove", onMove, true);
    element.addEventListener("pointerup", onUp, true);
    element.addEventListener("pointercancel", onCancel, true);
    element.addEventListener("dblclick", onDoubleClick, true);
    return () => {
      element.removeEventListener("pointerdown", onDown, true);
      element.removeEventListener("pointermove", onMove, true);
      element.removeEventListener("pointerup", onUp, true);
      element.removeEventListener("pointercancel", onCancel, true);
      element.removeEventListener("dblclick", onDoubleClick, true);
    };
    // The listeners read the latest callbacks through refs; only the tool and the elements matter here.
  }, [tool, wrapper, finishPen]);

  /** Escape and Enter while drawing: a pen path is finished; anything else half drawn is dropped. */
  const finish = React.useCallback((): boolean => {
    if (penRef.current) return finishPen(false);
    return false;
  }, [finishPen]);

  const layer = draft || pen ? <DrawingDraft draft={draft} pen={pen} /> : null;
  return { finish, layer, penActive: pen !== null };
}

/** What is being drawn, in canvas units, over everything else. */
function DrawingDraft({ draft, pen }: { draft: Draft | null; pen: PenPath | null }) {
  return (
    <ViewportPortal>
      <svg
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 overflow-visible"
        width={1}
        height={1}
        style={{ zIndex: 1000 }}
      >
        {draft?.type === "box" ? <BoxDraft draft={draft} /> : null}
        {draft?.type === "line" ? (
          <line className="design-draft-line" x1={draft.from.x} y1={draft.from.y} x2={draft.to.x} y2={draft.to.y} />
        ) : null}
        {draft?.type === "pencil" ? (
          <polyline className="design-draft-line" points={draft.points.map((point) => `${point.x},${point.y}`).join(" ")} />
        ) : null}
        {pen ? <PenDraft pen={pen} /> : null}
      </svg>
    </ViewportPortal>
  );
}

function BoxDraft({ draft }: { draft: Extract<Draft, { type: "box" }> }) {
  const box = boxFromDrag(draft.from, draft.to, { square: draft.square && draft.tool !== "text" });
  if (draft.tool === "oval") {
    return <ellipse className="design-draft" cx={box.x + box.w / 2} cy={box.y + box.h / 2} rx={box.w / 2} ry={box.h / 2} />;
  }
  return <rect className="design-draft" x={box.x} y={box.y} width={box.w} height={draft.tool === "text" ? TEXT_LINE_PX : box.h} />;
}

function PenDraft({ pen }: { pen: PenPath }) {
  const { anchors, handles } = pen;
  let d = `M${anchors[0]!.x},${anchors[0]!.y}`;
  for (let index = 1; index < anchors.length; index += 1) {
    const a = anchors[index - 1]!;
    const b = anchors[index]!;
    const ha = handles[index - 1]!;
    const hb = handles[index]!;
    d += ` C${a.x + ha.x},${a.y + ha.y} ${b.x - hb.x},${b.y - hb.y} ${b.x},${b.y}`;
  }
  const last = anchors[anchors.length - 1]!;
  const lastHandle = handles[handles.length - 1]!;
  return (
    <>
      <path className="design-draft-line" d={d} />
      {pen.hover && !pen.pressed ? (
        <line className="design-draft-line" strokeDasharray="4 4" x1={last.x} y1={last.y} x2={pen.hover.x} y2={pen.hover.y} />
      ) : null}
      {pen.pressed && (lastHandle.x !== 0 || lastHandle.y !== 0) ? (
        <line
          className="design-draft-line"
          x1={last.x - lastHandle.x}
          y1={last.y - lastHandle.y}
          x2={last.x + lastHandle.x}
          y2={last.y + lastHandle.y}
        />
      ) : null}
      {anchors.map((point, index) => (
        <circle key={index} className="design-draft-point" cx={point.x} cy={point.y} r={4} />
      ))}
    </>
  );
}
