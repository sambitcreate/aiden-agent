import { AnimationFreezer } from "./freeze.js";
import { deepElementFromPoint, rectInTopViewport, type ViewportRect } from "./hit-test.js";
import { collectSensitiveFieldRects, containsSensitiveField, inspectDomElement } from "./inspect-dom.js";
import { inspectFrameworkElement } from "./inspect-frameworks.js";
import {
  findReactComponentBoundaryElement,
  inspectReactElement,
  type RawGrabComponentFrame,
  type RawGrabSourceHint,
} from "./inspect-react.js";
import { GrabOverlay, type OverlayAccent } from "./overlay.js";
import { GrabSteppingState } from "./stepping.js";

export interface RawGrabPayload {
  cancelled?: boolean;
  keepActive?: boolean;
  framework: "react" | "vue" | "svelte" | "astro" | "preact" | "solid" | "angular" | "dom";
  componentName?: string;
  componentStack?: RawGrabComponentFrame[];
  source?: RawGrabSourceHint;
  props?: Record<string, string | number | boolean | null>;
  /** The grabbed element is or wraps a credential field, so its props must not carry contents. */
  sensitiveTarget?: boolean;
  tagName: string;
  selector: string;
  role?: string;
  accessibleName?: string;
  htmlSnippet: string;
  textPreview?: string;
  attributes?: Record<string, string>;
  computedStyles?: Record<string, string>;
  boundingBox: ViewportRect;
  viewport: { width: number; height: number; devicePixelRatio: number };
  inIframe?: boolean;
  sensitiveRects?: ViewportRect[];
}

interface GrabStartOptions {
  accent?: OverlayAccent;
  reducedMotion?: boolean;
}

type GrabGlobal = typeof globalThis & {
  __aidenPickerCancel?: () => void;
  __aidenGrabStart?: (options?: GrabStartOptions) => boolean;
  __aidenGrabNext?: () => Promise<RawGrabPayload>;
  __aidenGrabResume?: () => boolean;
  __aidenGrabStop?: () => void;
};

const SUPPRESSED_POINTER_EVENTS = [
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "auxclick",
  "dblclick",
  "contextmenu",
  "touchstart",
  "touchend",
] as const;

interface ActiveSession {
  overlay: GrabOverlay;
  stepping: GrabSteppingState;
  freezer: AnimationFreezer;
  pausedForCapture: boolean;
  lastCrossOriginIframe: boolean;
  lastInIframe: boolean;
  previousCursor: string;
  pendingResolvers: Array<(payload: RawGrabPayload) => void>;
  queuedPayloads: RawGrabPayload[];
  cleanup: () => void;
  refresh: () => void;
}

let activeSession: ActiveSession | null = null;

const MAX_SHIELD_SCAN = 15_000;

/**
 * Frame documents never deliver their pointer events to this document, so while
 * Grab runs every frame is made transparent to the pointer: input lands here,
 * where it is suppressed, and hit tests briefly lift the shield to look inside
 * same-origin frames. A cross-origin frame stays a single grabbable element.
 */
class FrameShield {
  private readonly saved = new Map<HTMLElement, { value: string; priority: string }>();
  private observer: MutationObserver | null = null;

  start(): void {
    this.scan(document, 0);
    if (typeof MutationObserver === "function" && document.documentElement) {
      this.observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of Array.from(record.addedNodes)) {
            if (node instanceof Element) this.scanElement(node);
          }
        }
      });
      this.observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    // Keys typed into a focused frame would bypass the grab's own handling.
    const focused = document.activeElement;
    if (focused && this.isFrame(focused)) (focused as HTMLElement).blur();
  }

  /** Runs a hit test with the frames hittable again; no event can dispatch in between. */
  hittable<T>(test: () => T): T {
    for (const [frame, previous] of this.saved) frame.style.setProperty("pointer-events", previous.value, previous.priority);
    try {
      return test();
    } finally {
      for (const frame of this.saved.keys()) frame.style.setProperty("pointer-events", "none", "important");
    }
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const [frame, previous] of this.saved) frame.style.setProperty("pointer-events", previous.value, previous.priority);
    this.saved.clear();
  }

  private isFrame(element: Element): boolean {
    const tag = (element.localName || element.tagName || "").toLowerCase();
    return tag === "iframe" || tag === "frame" || tag === "embed" || tag === "object";
  }

  private shield(element: Element): void {
    if (!(element instanceof HTMLElement) || this.saved.has(element)) return;
    this.saved.set(element, {
      value: element.style.getPropertyValue("pointer-events"),
      priority: element.style.getPropertyPriority("pointer-events"),
    });
    element.style.setProperty("pointer-events", "none", "important");
  }

  private scanElement(element: Element): void {
    if (this.isFrame(element)) this.shield(element);
    if (element.shadowRoot) this.scan(element.shadowRoot, 1);
    this.scan(element, 1);
  }

  private scan(root: Document | ShadowRoot | Element, depth: number): void {
    if (depth > 8) return;
    let elements: NodeListOf<Element>;
    try {
      elements = root.querySelectorAll("*");
    } catch {
      return;
    }
    for (let index = 0; index < elements.length && index < MAX_SHIELD_SCAN; index += 1) {
      const element = elements[index];
      if (!element) continue;
      if (this.isFrame(element)) this.shield(element);
      if (element.shadowRoot) this.scan(element.shadowRoot, depth + 1);
    }
  }
}

function formatHoverLabel(element: Element, crossOriginIframe: boolean): string {
  if (crossOriginIframe) return "iframe (cross-origin)";
  const react = inspectReactElement(element);
  if (react?.componentName) return `<${react.componentName} />`;
  const fw = inspectFrameworkElement(element);
  if (fw?.componentName) return `<${fw.componentName} />`;
  const dom = inspectDomElement(element);
  return dom.domLabel;
}

function buildPayload(
  element: Element,
  inIframe: boolean,
  keepActive: boolean,
): RawGrabPayload {
  const dom = inspectDomElement(element);
  const sensitiveTarget = containsSensitiveField(element);
  const react = inspectReactElement(element, sensitiveTarget);
  const fw = react ? null : inspectFrameworkElement(element);

  const framework = react ? "react" : fw ? fw.framework : "dom";
  const componentName = react?.componentName ?? fw?.componentName;
  const componentStack = react?.componentStack?.length
    ? react.componentStack
    : fw?.componentStack?.length
      ? fw.componentStack
      : undefined;
  const source = react?.source ?? fw?.source;
  const props = react?.props;
  const boundingBox = rectInTopViewport(element);
  const sensitiveRects = collectSensitiveFieldRects(document);

  return {
    keepActive,
    framework,
    ...(componentName ? { componentName } : {}),
    ...(componentStack ? { componentStack } : {}),
    ...(source ? { source } : {}),
    ...(props ? { props } : {}),
    ...(sensitiveTarget ? { sensitiveTarget: true } : {}),
    tagName: dom.tagName,
    selector: dom.selector,
    ...(dom.role ? { role: dom.role } : {}),
    ...(dom.accessibleName ? { accessibleName: dom.accessibleName } : {}),
    htmlSnippet: dom.htmlSnippet,
    ...(dom.textPreview ? { textPreview: dom.textPreview } : {}),
    ...(dom.attributes ? { attributes: dom.attributes } : {}),
    ...(dom.computedStyles ? { computedStyles: dom.computedStyles } : {}),
    boundingBox,
    viewport: {
      width: Math.max(1, Math.round(window.innerWidth || 1)),
      height: Math.max(1, Math.round(window.innerHeight || 1)),
      devicePixelRatio: Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1,
    },
    ...(inIframe ? { inIframe: true } : {}),
    ...(sensitiveRects.length > 0 ? { sensitiveRects } : {}),
  };
}

function deliverPayload(session: ActiveSession, payload: RawGrabPayload): void {
  const resolver = session.pendingResolvers.shift();
  if (resolver) {
    resolver(payload);
  } else {
    session.queuedPayloads.push(payload);
  }
}

function stopSession(): void {
  const session = activeSession;
  if (!session) return;
  activeSession = null;
  session.cleanup();
  const cancelPayload: RawGrabPayload = {
    cancelled: true,
    framework: "dom",
    tagName: "body",
    selector: "body",
    htmlSnippet: "",
    boundingBox: { x: 0, y: 0, width: 0, height: 0 },
    viewport: {
      width: Math.max(1, Math.round(window.innerWidth || 1)),
      height: Math.max(1, Math.round(window.innerHeight || 1)),
      devicePixelRatio: 1,
    },
  };
  for (const resolve of session.pendingResolvers.splice(0)) {
    resolve(cancelPayload);
  }
}

function startSession(options?: GrabStartOptions): boolean {
  const g = globalThis as GrabGlobal;
  try {
    g.__aidenPickerCancel?.();
  } catch {
    // Ignore prior picker errors.
  }
  stopSession();

  const accent: OverlayAccent = {
    bg: options?.accent?.bg || "#006AD6",
    fg: options?.accent?.fg || "#FFFFFF",
  };
  const overlay = new GrabOverlay(accent, Boolean(options?.reducedMotion));
  const stepping = new GrabSteppingState();
  const freezer = new AnimationFreezer();
  const frames = new FrameShield();
  const rootEl = document.documentElement;
  const previousCursor = rootEl ? rootEl.style.cursor : "";
  if (rootEl) rootEl.style.cursor = "crosshair";

  const session: ActiveSession = {
    overlay,
    stepping,
    freezer,
    pausedForCapture: false,
    lastCrossOriginIframe: false,
    lastInIframe: false,
    previousCursor,
    pendingResolvers: [],
    queuedPayloads: [],
    cleanup: () => undefined,
    refresh: () => undefined,
  };

  const refresh = () => {
    if (session.pausedForCapture) return;
    const el = stepping.getCurrent();
    if (!el || !el.isConnected) {
      overlay.hide();
      return;
    }
    const rect = rectInTopViewport(el);
    const label = formatHoverLabel(el, session.lastCrossOriginIframe);
    overlay.update({
      rect,
      label,
      dimensions: `${Math.round(rect.width)} × ${Math.round(rect.height)}`,
      stepDepth: stepping.getDepth(),
      frozen: freezer.isFrozen(),
    });
  };
  session.refresh = refresh;

  const suppress = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (session.pausedForCapture) return;
    const hit = frames.hittable(() => deepElementFromPoint(event.clientX, event.clientY, overlay.host));
    if (!hit) {
      overlay.hide();
      return;
    }
    session.lastCrossOriginIframe = hit.crossOriginIframe;
    session.lastInIframe = hit.inIframe;
    stepping.onPointerMove(event.clientX, event.clientY, hit.element);
    refresh();
  };

  const onClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (session.pausedForCapture || event.button !== 0) return;

    let target = stepping.getCurrent();
    let inIframe = session.lastInIframe;
    if (!target || !target.isConnected) {
      const hit = frames.hittable(() => deepElementFromPoint(event.clientX, event.clientY, overlay.host));
      if (!hit) return;
      target = hit.element;
      inIframe = hit.inIframe;
    }

    const keepActive = Boolean(event.shiftKey);
    session.pausedForCapture = true;
    const payload = buildPayload(target, inIframe, keepActive);

    void overlay.hideForCapture(!keepActive).then(() => {
      if (activeSession !== session) return;
      deliverPayload(session, payload);
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (session.pausedForCapture) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        stopSession();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      stopSession();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "g") {
      event.preventDefault();
      event.stopImmediatePropagation();
      stopSession();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopImmediatePropagation();
      session.lastCrossOriginIframe = false;
      stepping.stepUp(findReactComponentBoundaryElement);
      refresh();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopImmediatePropagation();
      stepping.stepDown();
      refresh();
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopImmediatePropagation();
      freezer.toggle();
      refresh();
    }
  };

  const onViewportChange = () => {
    refresh();
  };

  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onViewportChange, true);
  window.addEventListener("resize", onViewportChange, true);
  for (const name of SUPPRESSED_POINTER_EVENTS) {
    document.addEventListener(name, suppress, true);
  }
  frames.start();

  session.cleanup = () => {
    frames.stop();
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onViewportChange, true);
    window.removeEventListener("resize", onViewportChange, true);
    for (const name of SUPPRESSED_POINTER_EVENTS) {
      document.removeEventListener(name, suppress, true);
    }
    freezer.resume();
    overlay.destroy();
    if (rootEl) rootEl.style.cursor = session.previousCursor;
  };

  activeSession = session;
  return true;
}

function nextGrab(): Promise<RawGrabPayload> {
  const session = activeSession;
  if (!session) {
    return Promise.resolve({
      cancelled: true,
      framework: "dom",
      tagName: "body",
      selector: "body",
      htmlSnippet: "",
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      viewport: { width: 1, height: 1, devicePixelRatio: 1 },
    });
  }
  const queued = session.queuedPayloads.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise<RawGrabPayload>((resolve) => {
    session.pendingResolvers.push(resolve);
  });
}

function resumeGrab(): boolean {
  const session = activeSession;
  if (!session) return false;
  session.pausedForCapture = false;
  session.overlay.showAfterCapture();
  session.refresh();
  return true;
}

const g = globalThis as GrabGlobal;
g.__aidenGrabStart = startSession;
g.__aidenGrabNext = nextGrab;
g.__aidenGrabResume = resumeGrab;
g.__aidenGrabStop = stopSession;
