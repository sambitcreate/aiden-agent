export interface RawGrabSourceHint {
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
  debugStack?: string;
}

export interface RawGrabComponentFrame {
  name: string;
  environment?: "client" | "server";
  source?: RawGrabSourceHint;
  minified?: boolean;
}

export interface ReactInspectionResult {
  componentName?: string;
  componentStack: RawGrabComponentFrame[];
  source?: RawGrabSourceHint;
  props?: Record<string, string | number | boolean | null>;
}

const MAX_STACK_FRAMES = 12;
const MAX_WALK_STEPS = 80;
const MAX_DEBUG_STACK_CHARS = 4096;
const MAX_PROPS = 12;
const MAX_PROP_STRING_CHARS = 256;

const SECRET_PROP_PATTERN =
  /pass|secret|token|auth|api[_-]?key|cookie|session|credit|card|cvv|cvc|ssn|bearer|jwt|private|credential/iu;

const IGNORED_WRAPPER_NAMES = new Set([
  "AppRouter",
  "LayoutRouter",
  "InnerLayoutRouter",
  "OuterLayoutRouter",
  "RenderFromTemplateContext",
  "ScrollAndFocusHandler",
  "InnerScrollAndFocusHandler",
  "RedirectErrorBoundary",
  "RedirectBoundary",
  "NotFoundErrorBoundary",
  "NotFoundBoundary",
  "HTTPFallbackErrorBoundary",
  "ErrorBoundary",
  "ErrorBoundaryHandler",
  "HotReload",
  "ReactDevOverlay",
  "Router",
  "ServerRoot",
  "Root",
  "SegmentStateProvider",
  "SegmentViewNode",
  "TemplateContext",
  "PathnameContextProviderAdapter",
  "SearchParamsContextProviderAdapter",
  "FlightRouterStateProvider",
  "HeadManagerContext",
  "Fragment",
  "Suspense",
  "StrictMode",
  "Profiler",
  "Provider",
  "Consumer",
  "Context.Provider",
  "Context.Consumer",
]);

const NATIVE_ERROR_STACK_GETTER =
  Object.getOwnPropertyDescriptor(Error.prototype, "stack")?.get ??
  Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;

/**
 * Reads a data property from an untrusted page object without ever invoking
 * arbitrary page-defined getters.
 */
export function safeOwnProp(obj: unknown, key: string): unknown {
  if (!obj || (typeof obj !== "object" && typeof obj !== "function")) return undefined;
  let current: object | null = obj as object;
  for (let depth = 0; current && depth < 6; depth += 1) {
    let desc: PropertyDescriptor | undefined;
    try {
      desc = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      return undefined;
    }
    if (desc) {
      if ("get" in desc && desc.get !== undefined) {
        return undefined;
      }
      return desc.value;
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Reads an Error stack string without invoking hostile user-defined getters. */
export function safeErrorStack(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? value.slice(0, MAX_DEBUG_STACK_CHARS) : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const ownDesc = (() => {
    try {
      return Object.getOwnPropertyDescriptor(value, "stack");
    } catch {
      return undefined;
    }
  })();
  if (ownDesc) {
    if ("value" in ownDesc && typeof ownDesc.value === "string") {
      return ownDesc.value.length > 0 ? ownDesc.value.slice(0, MAX_DEBUG_STACK_CHARS) : undefined;
    }
    if (
      ownDesc.get &&
      NATIVE_ERROR_STACK_GETTER &&
      ownDesc.get === NATIVE_ERROR_STACK_GETTER &&
      value instanceof Error
    ) {
      try {
        const result = ownDesc.get.call(value);
        return typeof result === "string" && result.length > 0
          ? result.slice(0, MAX_DEBUG_STACK_CHARS)
          : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  if (value instanceof Error && NATIVE_ERROR_STACK_GETTER) {
    const protoDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), "stack");
    if (!protoDesc || protoDesc.get === NATIVE_ERROR_STACK_GETTER) {
      try {
        const result = NATIVE_ERROR_STACK_GETTER.call(value);
        return typeof result === "string" && result.length > 0
          ? result.slice(0, MAX_DEBUG_STACK_CHARS)
          : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function isMinifiedComponentName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length <= 2) return true;
  // Common single-char + digits mangling like `_a`, `$a`, `e1`
  if (/^[_$][a-zA-Z0-9]?$/u.test(trimmed)) return true;
  return false;
}

function unwrapReactTypeName(type: unknown): string | null {
  if (!type) return null;
  if (typeof type === "string") return null; // Host element, not a composite component.
  if (typeof type === "function") {
    const displayName = safeOwnProp(type, "displayName");
    if (typeof displayName === "string" && displayName.trim()) return displayName.trim();
    const name = safeOwnProp(type, "name");
    if (typeof name === "string" && name.trim()) return name.trim();
    return null;
  }
  if (typeof type === "object") {
    const displayName = safeOwnProp(type, "displayName");
    if (typeof displayName === "string" && displayName.trim()) return displayName.trim();
    // React.memo -> { type }
    const innerType = safeOwnProp(type, "type");
    if (innerType && innerType !== type) {
      const inner = unwrapReactTypeName(innerType);
      if (inner) return inner;
    }
    // React.forwardRef -> { render }
    const render = safeOwnProp(type, "render");
    if (render && render !== type) {
      const inner = unwrapReactTypeName(render);
      if (inner) return inner;
    }
  }
  return null;
}

function extractDebugSource(node: unknown): RawGrabSourceHint | undefined {
  const debugSource = safeOwnProp(node, "_debugSource");
  const debugStack = safeErrorStack(
    safeOwnProp(node, "_debugStack") ?? safeOwnProp(node, "debugStack"),
  );
  const hint: RawGrabSourceHint = {};
  if (debugSource && typeof debugSource === "object") {
    const fileName = safeOwnProp(debugSource, "fileName");
    const lineNumber = safeOwnProp(debugSource, "lineNumber");
    const columnNumber = safeOwnProp(debugSource, "columnNumber");
    if (typeof fileName === "string" && fileName.trim()) {
      hint.fileName = fileName.trim().slice(0, 512);
    }
    if (typeof lineNumber === "number" && Number.isSafeInteger(lineNumber) && lineNumber >= 1) {
      hint.lineNumber = lineNumber;
    }
    if (typeof columnNumber === "number" && Number.isSafeInteger(columnNumber) && columnNumber >= 1) {
      hint.columnNumber = columnNumber;
    }
  }
  if (debugStack) {
    hint.debugStack = debugStack;
  }
  return hint.fileName || hint.debugStack ? hint : undefined;
}

function extractSafeProps(fiber: unknown): Record<string, string | number | boolean | null> | undefined {
  const rawProps = safeOwnProp(fiber, "memoizedProps");
  if (!rawProps || typeof rawProps !== "object" || Array.isArray(rawProps)) return undefined;
  let keys: string[];
  try {
    keys = Object.getOwnPropertyNames(rawProps);
  } catch {
    return undefined;
  }
  const props: Record<string, string | number | boolean | null> = {};
  let count = 0;
  for (const key of keys) {
    if (count >= MAX_PROPS) break;
    if (
      key === "children" ||
      key === "key" ||
      key === "ref" ||
      key === "dangerouslySetInnerHTML" ||
      key === "__proto__" ||
      key.startsWith("__") ||
      /^on[A-Z]/u.test(key)
    ) {
      continue;
    }
    if (key.length === 0 || key.length > 80) continue;
    if (SECRET_PROP_PATTERN.test(key)) {
      props[key] = "[redacted]";
      count += 1;
      continue;
    }
    const value = safeOwnProp(rawProps, key);
    if (value === null || typeof value === "boolean") {
      props[key] = value;
      count += 1;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      props[key] = value;
      count += 1;
    } else if (typeof value === "string") {
      props[key] = value.slice(0, MAX_PROP_STRING_CHARS);
      count += 1;
    }
  }
  return count > 0 ? props : undefined;
}

function findReactFiberOnElement(element: unknown): unknown {
  if (!element || typeof element !== "object") return undefined;
  let keys: string[];
  try {
    keys = Object.getOwnPropertyNames(element);
  } catch {
    return undefined;
  }
  for (const key of keys) {
    if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
      const fiber = safeOwnProp(element, key);
      if (fiber && typeof fiber === "object") return fiber;
    }
  }
  return undefined;
}

function isServerComponentInfo(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const env = safeOwnProp(node, "env");
  return typeof env === "string" && env.toLowerCase().includes("server");
}

function extractFrameFromNode(node: unknown): RawGrabComponentFrame | null {
  if (!node || typeof node !== "object") return null;
  const type = safeOwnProp(node, "type");
  let name = unwrapReactTypeName(type);
  let environment: "client" | "server" | undefined;

  // React 19 RSC ReactComponentInfo shape: { name, env: "Server", debugStack, owner }
  if (!name) {
    const infoName = safeOwnProp(node, "name");
    if (typeof infoName === "string" && infoName.trim()) {
      name = infoName.trim();
      if (isServerComponentInfo(node)) {
        environment = "server";
      }
    }
  } else if (isServerComponentInfo(node)) {
    environment = "server";
  }

  if (!name || IGNORED_WRAPPER_NAMES.has(name)) return null;
  if (name.startsWith("Anonymous") || name === "default") return null;

  const minified = isMinifiedComponentName(name);
  const source = extractDebugSource(node);
  const frame: RawGrabComponentFrame = { name: name.slice(0, 160) };
  if (environment) frame.environment = environment;
  if (source) frame.source = source;
  if (minified) frame.minified = true;
  return frame;
}

function collectDebugInfoFrames(fiber: unknown): RawGrabComponentFrame[] {
  const debugInfo = safeOwnProp(fiber, "_debugInfo");
  if (!Array.isArray(debugInfo)) return [];
  const frames: RawGrabComponentFrame[] = [];
  for (const entry of debugInfo.slice(0, MAX_STACK_FRAMES)) {
    const frame = extractFrameFromNode(entry);
    if (frame) frames.push(frame);
  }
  return frames;
}

/**
 * Finds the nearest composite component fiber's host DOM node for `ArrowUp` component stepping.
 */
export function findReactComponentBoundaryElement(element: Element): Element | null {
  const startFiber = findReactFiberOnElement(element);
  if (!startFiber) return null;
  let cursor: unknown = safeOwnProp(startFiber, "return");
  let passedComposite = false;
  for (let steps = 0; cursor && steps < MAX_WALK_STEPS; steps += 1) {
    const frame = extractFrameFromNode(cursor);
    if (frame && !frame.minified) {
      passedComposite = true;
    } else if (passedComposite) {
      const stateNode = safeOwnProp(cursor, "stateNode");
      if (
        stateNode &&
        typeof stateNode === "object" &&
        stateNode !== element &&
        "nodeType" in stateNode &&
        safeOwnProp(stateNode, "nodeType") === 1
      ) {
        return stateNode as Element;
      }
    }
    cursor = safeOwnProp(cursor, "return");
  }
  return null;
}

/**
 * Extracts React 16–19 component hierarchy, source hints (`_debugSource`, `_debugStack`,
 * RSC `_debugOwner`/`_debugInfo`), and redacted primitive props from a mounted DOM element.
 */
export function inspectReactElement(element: unknown): ReactInspectionResult | null {
  const hostFiber = findReactFiberOnElement(element);
  if (!hostFiber) return null;

  const frames: RawGrabComponentFrame[] = [];
  const seenNodes = new Set<unknown>();
  const seenKeys = new Set<string>();
  let immediateCompositeFiber: unknown = undefined;

  const pushFrame = (node: unknown, frame: RawGrabComponentFrame) => {
    const dedup = `${frame.name}:${frame.environment ?? "client"}:${frame.source?.fileName ?? ""}:${frame.source?.lineNumber ?? ""}`;
    if (seenKeys.has(dedup)) return;
    seenKeys.add(dedup);
    if (!immediateCompositeFiber && !frame.minified && safeOwnProp(node, "memoizedProps")) {
      immediateCompositeFiber = node;
    }
    frames.push(frame);
  };

  // Capture any RSC _debugInfo attached directly to the host fiber.
  for (const infoFrame of collectDebugInfoFrames(hostFiber)) {
    if (frames.length >= MAX_STACK_FRAMES) break;
    pushFrame(hostFiber, infoFrame);
  }

  // First walk _debugOwner (preferred JSX logical owner chain, including React 19 RSC owners).
  let owner: unknown = safeOwnProp(hostFiber, "_debugOwner");
  for (let steps = 0; owner && steps < MAX_WALK_STEPS && frames.length < MAX_STACK_FRAMES; steps += 1) {
    if (seenNodes.has(owner)) break;
    seenNodes.add(owner);
    const frame = extractFrameFromNode(owner);
    if (frame) pushFrame(owner, frame);
    for (const infoFrame of collectDebugInfoFrames(owner)) {
      if (frames.length >= MAX_STACK_FRAMES) break;
      pushFrame(owner, infoFrame);
    }
    owner = safeOwnProp(owner, "_debugOwner") ?? safeOwnProp(owner, "owner");
  }

  // Merge with fiber.return chain to cover createPortal boundaries and production builds lacking _debugOwner.
  let parent: unknown = safeOwnProp(hostFiber, "return");
  for (let steps = 0; parent && steps < MAX_WALK_STEPS && frames.length < MAX_STACK_FRAMES; steps += 1) {
    if (!seenNodes.has(parent)) {
      seenNodes.add(parent);
      const frame = extractFrameFromNode(parent);
      if (frame) pushFrame(parent, frame);
      for (const infoFrame of collectDebugInfoFrames(parent)) {
        if (frames.length >= MAX_STACK_FRAMES) break;
        pushFrame(parent, infoFrame);
      }
    }
    parent = safeOwnProp(parent, "return");
  }

  // Host fiber's own _debugSource / _debugStack points to the exact JSX call site of this element.
  const hostSource = extractDebugSource(hostFiber);
  const primaryFrame = frames.find((frame) => !frame.minified);
  const source = hostSource ?? primaryFrame?.source;
  const props = immediateCompositeFiber ? extractSafeProps(immediateCompositeFiber) : undefined;

  return {
    ...(primaryFrame ? { componentName: primaryFrame.name } : {}),
    componentStack: frames,
    ...(source ? { source } : {}),
    ...(props ? { props } : {}),
  };
}
