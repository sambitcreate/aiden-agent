import { rectInTopViewport, type ViewportRect } from "./hit-test.js";

const POINTER_UNLOCK_DISTANCE_PX = 6;

function sameRect(a: ViewportRect, b: ViewportRect): boolean {
  return (
    Math.abs(a.x - b.x) < 1 &&
    Math.abs(a.y - b.y) < 1 &&
    Math.abs(a.width - b.width) < 1 &&
    Math.abs(a.height - b.height) < 1
  );
}

function logicalParent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = typeof element.getRootNode === "function" ? element.getRootNode() : null;
  if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot && root.host) {
    return root.host;
  }
  try {
    const frameEl = element.ownerDocument?.defaultView?.frameElement;
    if (frameEl instanceof Element) return frameEl;
  } catch {
    // Cross-origin frame boundary.
  }
  return null;
}

/**
 * Tracks hovered element selection plus `ArrowUp` / `ArrowDown` ancestor stepping.
 * Moving the pointer > 6px unlocks keyboard stepping and resumes live hover tracking.
 */
export class GrabSteppingState {
  private current: Element | null = null;
  private descendantTrail: Element[] = [];
  private lastPointer: { x: number; y: number } | null = null;
  private lockedByKeyboard = false;

  getCurrent(): Element | null {
    return this.current;
  }

  getDepth(): number {
    return this.descendantTrail.length;
  }

  reset(): void {
    this.current = null;
    this.descendantTrail = [];
    this.lastPointer = null;
    this.lockedByKeyboard = false;
  }

  onPointerMove(x: number, y: number, hitElement: Element | null): Element | null {
    if (this.lockedByKeyboard && this.lastPointer) {
      const dx = x - this.lastPointer.x;
      const dy = y - this.lastPointer.y;
      if (Math.hypot(dx, dy) <= POINTER_UNLOCK_DISTANCE_PX) {
        return this.current;
      }
      this.lockedByKeyboard = false;
      this.descendantTrail = [];
    }
    this.lastPointer = { x, y };
    this.current = hitElement;
    return this.current;
  }

  /**
   * Climbs to the next composite component ancestor (when provided) or nearest DOM ancestor
   * with a distinct bounding box, pushing the previous element onto `descendantTrail`.
   */
  stepUp(findComponentOwner?: (element: Element) => Element | null): Element | null {
    if (!this.current) return null;
    const currentRect = rectInTopViewport(this.current);

    const componentTarget = findComponentOwner?.(this.current) ?? null;
    if (componentTarget && componentTarget !== this.current) {
      this.descendantTrail.push(this.current);
      this.current = componentTarget;
      this.lockedByKeyboard = true;
      return this.current;
    }

    let candidate = logicalParent(this.current);
    let fallback: Element | null = candidate;
    while (candidate) {
      const tag = (candidate.localName || candidate.tagName || "").toLowerCase();
      if (tag === "html") break;
      const candidateRect = rectInTopViewport(candidate);
      if (!sameRect(currentRect, candidateRect)) {
        this.descendantTrail.push(this.current);
        this.current = candidate;
        this.lockedByKeyboard = true;
        return this.current;
      }
      fallback = candidate;
      candidate = logicalParent(candidate);
    }

    if (fallback && fallback !== this.current) {
      const tag = (fallback.localName || fallback.tagName || "").toLowerCase();
      if (tag !== "html") {
        this.descendantTrail.push(this.current);
        this.current = fallback;
        this.lockedByKeyboard = true;
        return this.current;
      }
    }
    return this.current;
  }

  /** Steps back down through `descendantTrail`. */
  stepDown(): Element | null {
    const previous = this.descendantTrail.pop();
    if (!previous) return this.current;
    this.current = previous;
    this.lockedByKeyboard = this.descendantTrail.length > 0;
    return this.current;
  }
}
