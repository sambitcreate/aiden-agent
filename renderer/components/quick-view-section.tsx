import * as React from "react";
import { ArrowUpRight, ChevronDown, GripVertical, PanelRightOpen } from "lucide-react";
import { prefersReducedMotion } from "../lib/appearance-runtime";
import { dragTargetIndex, type QuickViewSectionId } from "../lib/quick-view-layout";
import { cn } from "../lib/ui-utils";

export interface QuickViewSectionProps {
  id: QuickViewSectionId;
  title: string;
  /** Shown at the trailing edge while collapsed. */
  summary?: React.ReactNode;
  /** Accessible text for the summary (e.g. "9 percent used"). */
  summaryLabel?: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Position among visible sections. */
  index: number;
  /** Number of visible sections. */
  count: number;
  onMove: (id: QuickViewSectionId, toIndex: number) => void;
  /** Visible sibling cards' rects at drag start, in visible order; supplied by the parent. */
  measureSiblings: () => DOMRect[];
  /** Tier 3 header button, left of the grip: Open in sidebar (`PanelRightOpen`) or open-external (`ArrowUpRight`). */
  headerAction?: { kind: "sidebar" | "external"; label: string; onSelect: () => void };
  /** Live drop target while dragging (null when the drag ends) so the parent can shift siblings. */
  onDragPreview?: (id: QuickViewSectionId, to: number | null) => void;
  children?: React.ReactNode;
}

/** Pointer travel before a press on the grip becomes a drag. */
const DRAG_THRESHOLD_PX = 4;
/** How far past the first and last sibling the dragged card may travel. */
const DRAG_OVERSHOOT_PX = 8;

interface DragState {
  pointerId: number;
  startY: number;
  rects: DOMRect[];
  active: boolean;
  target: number;
}

/**
 * Keeps a collapsing body laid out until its grid-row transition finishes, and lays out an
 * expanding body at 0fr for one frame so the rows grow instead of appearing at full height.
 */
function useCollapsibleBody(collapsed: boolean, body: React.RefObject<HTMLDivElement | null>) {
  const [rendered, setRendered] = React.useState(!collapsed);
  const [opened, setOpened] = React.useState(!collapsed);

  React.useLayoutEffect(() => {
    if (collapsed) {
      setOpened(false);
      if (prefersReducedMotion()) setRendered(false);
      return;
    }
    setRendered(true);
  }, [collapsed]);

  React.useLayoutEffect(() => {
    if (collapsed || !rendered || opened) return;
    // Commit the 0fr layout before switching to 1fr so the transition has a start value.
    void body.current?.offsetHeight;
    setOpened(true);
  }, [body, collapsed, opened, rendered]);

  const onTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (collapsed && event.target === event.currentTarget) setRendered(false);
  };

  return { hidden: !rendered, open: opened && !collapsed, onTransitionEnd };
}

export function QuickViewSection({
  id,
  title,
  summary,
  summaryLabel,
  collapsed,
  onToggle,
  index,
  count,
  onMove,
  measureSiblings,
  headerAction,
  onDragPreview,
  children,
}: QuickViewSectionProps): React.JSX.Element {
  const headingId = React.useId();
  const bodyId = React.useId();
  const summaryId = React.useId();
  const cardRef = React.useRef<HTMLElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<DragState | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState("");
  const { hidden, open, onTransitionEnd } = useCollapsibleBody(collapsed, bodyRef);

  const setTranslate = (dy: number | null) => {
    const card = cardRef.current;
    if (card) card.style.translate = dy === null ? "" : `0 ${dy}px`;
  };

  const endDrag = (drop: { clientY: number } | null) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (!drag.active) return;
    setTranslate(null);
    setDragging(false);
    onDragPreview?.(id, null);
    if (!drop) return;
    const target = targetFor(drag, drop.clientY);
    if (target !== index) onMove(id, target);
  };

  /** Clamped travel and the resulting drop target; null when the rects can't place this card. */
  const travel = (drag: DragState, clientY: number) => {
    const { rects } = drag;
    const self = rects[index];
    if (!self || rects.length === 0) return null;
    const first = rects[0];
    const last = rects[rects.length - 1];
    const min = first.top - self.top - DRAG_OVERSHOOT_PX;
    const max = last.top + last.height - (self.top + self.height) + DRAG_OVERSHOOT_PX;
    const dy = Math.min(max, Math.max(min, clientY - drag.startY));
    return { dy, target: dragTargetIndex(rects, index, dy) };
  };

  const targetFor = (drag: DragState, clientY: number) => travel(drag, clientY)?.target ?? index;

  const onGripPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      rects: measureSiblings(),
      active: false,
      target: index,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The pointer may already be gone (or capture unsupported); the drag still works while it stays over the grip.
    }
  };

  const onGripPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
      drag.active = true;
      setDragging(true);
    }
    const next = travel(drag, event.clientY);
    if (!next) return;
    setTranslate(next.dy);
    if (next.target !== drag.target) {
      drag.target = next.target;
      onDragPreview?.(id, next.target);
    }
  };

  const onGripPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    endDrag({ clientY: event.clientY });
  };

  const onGripPointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    endDrag(null);
  };

  const onGripKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const to = event.key === "ArrowUp" ? index - 1 : index + 1;
    if (to < 0 || to >= count) return;
    onMove(id, to);
    setAnnouncement(`${title} moved to position ${to + 1} of ${count}`);
  };

  const HeaderActionIcon = headerAction?.kind === "external" ? ArrowUpRight : PanelRightOpen;

  return (
    <section
      ref={cardRef}
      aria-labelledby={headingId}
      data-quick-view-section={id}
      data-dragging={dragging ? "" : undefined}
      className={cn(
        "group/qv relative rounded-dialog bg-popover text-primary shadow-popover",
        "transition-[box-shadow,scale] duration-(--motion-duration) ease-standard motion-reduce:transition-none",
        "data-dragging:z-10 data-dragging:scale-[1.02] data-dragging:shadow-dialog motion-reduce:data-dragging:scale-100",
      )}
    >
      <div className={cn("flex items-center gap-0.5 px-1 pt-1", collapsed && "pb-1")}>
        <h2 id={headingId} className="m-0 flex min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            aria-describedby={collapsed && summaryLabel ? summaryId : undefined}
            onClick={onToggle}
            className="flex min-h-9 flex-1 items-center gap-1 rounded-control px-2.5 text-left text-strong font-medium text-primary outline-none hover:bg-list-hover focus-visible:bg-list-hover"
          >
            <span className="min-w-0 truncate">{title}</span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-tertiary transition-transform duration-(--motion-duration) ease-standard motion-reduce:transition-none",
                collapsed && "-rotate-90",
              )}
            />
            {summary !== undefined ? (
              <span
                aria-hidden="true"
                className={cn(
                  "ml-auto inline-flex min-w-0 items-center gap-2 truncate pl-2.5 text-small font-normal text-tertiary tabular-nums",
                  "transition-opacity duration-(--motion-duration) ease-standard motion-reduce:transition-none",
                  !collapsed && "opacity-0",
                )}
              >
                {summary}
              </span>
            ) : null}
            {summaryLabel ? (
              <span id={summaryId} hidden>
                {summaryLabel}
              </span>
            ) : null}
          </button>
        </h2>
        {headerAction ? (
          <button
            type="button"
            aria-label={headerAction.label}
            title={headerAction.label}
            onClick={headerAction.onSelect}
            className="grid size-7 shrink-0 place-items-center rounded-control text-tertiary transition-colors hover:bg-list-hover hover:text-primary"
          >
            <HeaderActionIcon aria-hidden="true" className="size-4" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={`Move ${title}`}
          aria-keyshortcuts="ArrowUp ArrowDown"
          title="Drag to reorder"
          onKeyDown={onGripKeyDown}
          onPointerDown={onGripPointerDown}
          onPointerMove={onGripPointerMove}
          onPointerUp={onGripPointerUp}
          onPointerCancel={onGripPointerCancel}
          onLostPointerCapture={(event) => {
            if (dragRef.current?.pointerId === event.pointerId) endDrag(null);
          }}
          className={cn(
            "grid h-7 w-5 shrink-0 cursor-grab touch-none place-items-center rounded-control text-tertiary",
            "opacity-0 transition-[opacity,background-color] hover:bg-list-hover group-hover/qv:opacity-100 focus-visible:opacity-100",
            "group-data-dragging/qv:cursor-grabbing group-data-dragging/qv:opacity-100",
          )}
        >
          <GripVertical aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      <div
        ref={bodyRef}
        id={bodyId}
        inert={collapsed ? true : undefined}
        aria-hidden={collapsed ? true : undefined}
        hidden={hidden}
        onTransitionEnd={onTransitionEnd}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-(--motion-duration) ease-standard motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="px-1 pb-1">{children}</div>
        </div>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </section>
  );
}
