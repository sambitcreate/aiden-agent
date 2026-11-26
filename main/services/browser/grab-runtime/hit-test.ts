export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HitTestResult {
  element: Element;
  rect: ViewportRect;
  inIframe: boolean;
  crossOriginIframe: boolean;
  doc: Document;
}

const MAX_TRAVERSAL_DEPTH = 10;

function isInsideOverlay(node: Element, overlayHost: Element | null): boolean {
  if (!overlayHost) return false;
  return node === overlayHost || overlayHost.contains(node);
}

function topElementAtPoint(
  root: Document | ShadowRoot,
  x: number,
  y: number,
  overlayHost: Element | null,
): Element | null {
  if (typeof root.elementsFromPoint === "function") {
    const hits = root.elementsFromPoint(x, y);
    for (const candidate of hits) {
      if (!isInsideOverlay(candidate, overlayHost)) return candidate;
    }
    return null;
  }
  const hit = root.elementFromPoint(x, y);
  return hit && !isInsideOverlay(hit, overlayHost) ? hit : null;
}

/**
 * Maps an element's `getBoundingClientRect()` from its owning document (including
 * nested same-origin iframes) into top-level viewport CSS pixel coordinates.
 */
export function rectInTopViewport(element: Element): ViewportRect {
  const rect = element.getBoundingClientRect();
  let x = rect.left;
  let y = rect.top;
  let win: Window | null = element.ownerDocument?.defaultView ?? null;
  let depth = 0;

  while (win && win !== window && depth < MAX_TRAVERSAL_DEPTH) {
    depth += 1;
    let frameEl: Element | null = null;
    try {
      frameEl = win.frameElement;
    } catch {
      break;
    }
    if (!frameEl) break;
    const frameRect = frameEl.getBoundingClientRect();
    let borderLeft = 0;
    let borderTop = 0;
    let paddingLeft = 0;
    let paddingTop = 0;
    try {
      const style = frameEl.ownerDocument?.defaultView?.getComputedStyle(frameEl);
      if (style) {
        borderLeft = parseFloat(style.borderLeftWidth) || 0;
        borderTop = parseFloat(style.borderTopWidth) || 0;
        paddingLeft = parseFloat(style.paddingLeft) || 0;
        paddingTop = parseFloat(style.paddingTop) || 0;
      }
    } catch {
      // Fall back to frame rect origin.
    }
    x += frameRect.left + borderLeft + paddingLeft;
    y += frameRect.top + borderTop + paddingTop;
    try {
      win = frameEl.ownerDocument?.defaultView ?? null;
    } catch {
      break;
    }
  }

  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    width: Number.isFinite(rect.width) ? Math.max(0, rect.width) : 0,
    height: Number.isFinite(rect.height) ? Math.max(0, rect.height) : 0,
  };
}

/**
 * Traverses open Shadow DOMs and same-origin iframes from a top-viewport pointer
 * coordinate `(x, y)`, ignoring the injected overlay host.
 */
export function deepElementFromPoint(
  x: number,
  y: number,
  overlayHost: Element | null,
): HitTestResult | null {
  let root: Document | ShadowRoot = document;
  let localX = x;
  let localY = y;
  let doc: Document = document;
  let inIframe = false;
  let current: Element | null = null;

  for (let depth = 0; depth < MAX_TRAVERSAL_DEPTH; depth += 1) {
    const hit = topElementAtPoint(root, localX, localY, overlayHost);
    if (!hit || hit === current) break;
    current = hit;

    if (hit.shadowRoot) {
      root = hit.shadowRoot;
      continue;
    }

    if (hit.tagName.toLowerCase() === "iframe") {
      let frameDoc: Document | null = null;
      try {
        frameDoc = (hit as HTMLIFrameElement).contentDocument;
      } catch {
        frameDoc = null;
      }
      if (!frameDoc) {
        return {
          element: hit,
          rect: rectInTopViewport(hit),
          inIframe,
          crossOriginIframe: true,
          doc,
        };
      }
      const frameRect = hit.getBoundingClientRect();
      let borderLeft = 0;
      let borderTop = 0;
      let paddingLeft = 0;
      let paddingTop = 0;
      try {
        const style = doc.defaultView?.getComputedStyle(hit);
        if (style) {
          borderLeft = parseFloat(style.borderLeftWidth) || 0;
          borderTop = parseFloat(style.borderTopWidth) || 0;
          paddingLeft = parseFloat(style.paddingLeft) || 0;
          paddingTop = parseFloat(style.paddingTop) || 0;
        }
      } catch {
        // Use border/padding 0.
      }
      localX -= frameRect.left + borderLeft + paddingLeft;
      localY -= frameRect.top + borderTop + paddingTop;
      doc = frameDoc;
      root = frameDoc;
      inIframe = true;
      current = null;
      continue;
    }

    break;
  }

  if (!current) return null;
  return {
    element: current,
    rect: rectInTopViewport(current),
    inIframe,
    crossOriginIframe: false,
    doc,
  };
}
