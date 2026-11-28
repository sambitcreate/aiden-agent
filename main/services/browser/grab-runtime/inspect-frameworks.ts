import {
  isMinifiedComponentName,
  safeOwnProp,
  type RawGrabComponentFrame,
  type RawGrabSourceHint,
} from "./inspect-react.js";

export interface FrameworkInspectionResult {
  framework: "vue" | "svelte" | "astro" | "preact" | "solid" | "angular";
  componentName?: string;
  componentStack: RawGrabComponentFrame[];
  source?: RawGrabSourceHint;
}

const MAX_FRAMES = 12;

function fileBaseComponentName(filePath: string): string | undefined {
  const clean = filePath.split(/[?#]/u)[0] ?? filePath;
  const segment = clean.split(/[\\/]/u).pop() ?? "";
  const base = segment.replace(/\.(vue|svelte|astro|tsx|jsx|ts|js)$/iu, "");
  return base && base.length <= 160 ? base : undefined;
}

function inspectVue(element: unknown): FrameworkInspectionResult | null {
  // Vue 3: __vueParentComponent or __vnode.component
  let comp: unknown =
    safeOwnProp(element, "__vueParentComponent") ??
    safeOwnProp(safeOwnProp(element, "__vnode"), "component");
  if (comp && typeof comp === "object") {
    const frames: RawGrabComponentFrame[] = [];
    for (let i = 0; comp && i < MAX_FRAMES; i += 1) {
      const type = safeOwnProp(comp, "type");
      const rawName = safeOwnProp(type, "__name") ?? safeOwnProp(type, "name");
      const rawFile = safeOwnProp(type, "__file");
      const filePath = typeof rawFile === "string" && rawFile.trim() ? rawFile.trim() : undefined;
      const name =
        typeof rawName === "string" && rawName.trim()
          ? rawName.trim()
          : filePath
            ? fileBaseComponentName(filePath)
            : undefined;
      if (name) {
        const minified = isMinifiedComponentName(name);
        frames.push({
          name: name.slice(0, 160),
          ...(filePath ? { source: { fileName: filePath.slice(0, 512) } } : {}),
          ...(minified ? { minified: true } : {}),
        });
      }
      comp = safeOwnProp(comp, "parent");
    }
    if (frames.length > 0) {
      const primary = frames.find((frame) => !frame.minified);
      return {
        framework: "vue",
        ...(primary ? { componentName: primary.name } : {}),
        componentStack: frames,
        ...((primary?.source ?? frames[0]?.source)
          ? { source: primary?.source ?? frames[0]?.source }
          : {}),
      };
    }
  }

  // Vue 2: __vue__.$options
  let vm: unknown = safeOwnProp(element, "__vue__");
  if (vm && typeof vm === "object") {
    const frames: RawGrabComponentFrame[] = [];
    for (let i = 0; vm && i < MAX_FRAMES; i += 1) {
      const opts = safeOwnProp(vm, "$options");
      const rawName = safeOwnProp(opts, "name") ?? safeOwnProp(opts, "_componentTag");
      const rawFile = safeOwnProp(opts, "__file");
      const filePath = typeof rawFile === "string" && rawFile.trim() ? rawFile.trim() : undefined;
      const name =
        typeof rawName === "string" && rawName.trim()
          ? rawName.trim()
          : filePath
            ? fileBaseComponentName(filePath)
            : undefined;
      if (name) {
        const minified = isMinifiedComponentName(name);
        frames.push({
          name: name.slice(0, 160),
          ...(filePath ? { source: { fileName: filePath.slice(0, 512) } } : {}),
          ...(minified ? { minified: true } : {}),
        });
      }
      vm = safeOwnProp(vm, "$parent");
    }
    if (frames.length > 0) {
      const primary = frames.find((frame) => !frame.minified);
      return {
        framework: "vue",
        ...(primary ? { componentName: primary.name } : {}),
        componentStack: frames,
        ...((primary?.source ?? frames[0]?.source)
          ? { source: primary?.source ?? frames[0]?.source }
          : {}),
      };
    }
  }

  return null;
}

function inspectSvelte(element: Element): FrameworkInspectionResult | null {
  const frames: RawGrabComponentFrame[] = [];
  const seenFiles = new Set<string>();
  let firstSource: RawGrabSourceHint | undefined;
  let cursor: Element | null = element;

  for (let steps = 0; cursor && steps < 40 && frames.length < MAX_FRAMES; steps += 1) {
    const meta = safeOwnProp(cursor, "__svelte_meta");
    const loc = safeOwnProp(meta, "loc");
    const file = safeOwnProp(loc, "file");
    if (typeof file === "string" && file.trim()) {
      const line = safeOwnProp(loc, "line");
      const char = safeOwnProp(loc, "char");
      const source: RawGrabSourceHint = {
        fileName: file.trim().slice(0, 512),
        // Svelte's __svelte_meta.loc.line is 0-based in Svelte 4/5 dev mode; normalize to 1-based.
        ...(typeof line === "number" && Number.isSafeInteger(line) && line >= 0
          ? { lineNumber: line + 1 }
          : {}),
        ...(typeof char === "number" && Number.isSafeInteger(char) && char >= 0
          ? { columnNumber: char + 1 }
          : {}),
      };
      if (!firstSource) firstSource = source;
      if (!seenFiles.has(file)) {
        seenFiles.add(file);
        const name = fileBaseComponentName(file) ?? "SvelteComponent";
        frames.push({
          name,
          source,
          ...(isMinifiedComponentName(name) ? { minified: true } : {}),
        });
      }
    }
    cursor = cursor.parentElement;
  }

  if (frames.length === 0) return null;
  const primary = frames.find((frame) => !frame.minified);
  return {
    framework: "svelte",
    ...(primary ? { componentName: primary.name } : {}),
    componentStack: frames,
    ...(firstSource ? { source: firstSource } : {}),
  };
}

function inspectAstro(element: Element): FrameworkInspectionResult | null {
  let cursor: Element | null = element;
  for (let steps = 0; cursor && steps < 30; steps += 1) {
    const file = cursor.getAttribute?.("data-astro-source-file");
    if (file && file.trim()) {
      const loc = cursor.getAttribute?.("data-astro-source-loc") ?? "";
      const [lineStr, colStr] = loc.split(":");
      const line = Number(lineStr);
      const col = Number(colStr);
      const source: RawGrabSourceHint = {
        fileName: file.trim().slice(0, 512),
        ...(Number.isSafeInteger(line) && line >= 1 ? { lineNumber: line } : {}),
        ...(Number.isSafeInteger(col) && col >= 1 ? { columnNumber: col } : {}),
      };
      const name = fileBaseComponentName(file) ?? "AstroComponent";
      return {
        framework: "astro",
        componentName: name,
        componentStack: [{ name, source }],
        source,
      };
    }
    cursor = cursor.parentElement;
  }
  return null;
}

function inspectPreact(element: unknown): FrameworkInspectionResult | null {
  let vnode: unknown = safeOwnProp(element, "__k") ?? safeOwnProp(element, "_vnode");
  if (!vnode || typeof vnode !== "object") return null;
  const frames: RawGrabComponentFrame[] = [];
  for (let i = 0; vnode && i < 40 && frames.length < MAX_FRAMES; i += 1) {
    const type = safeOwnProp(vnode, "type");
    if (typeof type === "function") {
      const rawName = safeOwnProp(type, "displayName") ?? safeOwnProp(type, "name");
      if (typeof rawName === "string" && rawName.trim()) {
        const name = rawName.trim().slice(0, 160);
        frames.push({
          name,
          ...(isMinifiedComponentName(name) ? { minified: true } : {}),
        });
      }
    }
    vnode = safeOwnProp(vnode, "__") ?? safeOwnProp(vnode, "_parent");
  }
  if (frames.length === 0) return null;
  const primary = frames.find((frame) => !frame.minified);
  return {
    framework: "preact",
    ...(primary ? { componentName: primary.name } : {}),
    componentStack: frames,
  };
}

function inspectSolid(element: Element): FrameworkInspectionResult | null {
  const owner = safeOwnProp(element, "_$owner") ?? safeOwnProp(element, "$$solid");
  const attrName = element.getAttribute?.("data-solid-component");
  if (!owner && !attrName) return null;
  const frames: RawGrabComponentFrame[] = [];
  if (attrName && attrName.trim()) {
    frames.push({ name: attrName.trim().slice(0, 160) });
  }
  let cursor: unknown = owner;
  for (let i = 0; cursor && i < 30 && frames.length < MAX_FRAMES; i += 1) {
    const rawName = safeOwnProp(cursor, "name");
    if (typeof rawName === "string" && rawName.trim()) {
      const name = rawName.trim().slice(0, 160);
      if (!frames.some((frame) => frame.name === name)) {
        frames.push({
          name,
          ...(isMinifiedComponentName(name) ? { minified: true } : {}),
        });
      }
    }
    cursor = safeOwnProp(cursor, "owner");
  }
  if (frames.length === 0) return null;
  const primary = frames.find((frame) => !frame.minified);
  return {
    framework: "solid",
    ...(primary ? { componentName: primary.name } : {}),
    componentStack: frames,
  };
}

function inspectAngular(element: Element): FrameworkInspectionResult | null {
  const ngContext = safeOwnProp(element, "__ngContext__");
  const globalNg = typeof window !== "undefined" ? safeOwnProp(window, "ng") : undefined;
  let component: unknown = undefined;
  if (globalNg && typeof safeOwnProp(globalNg, "getComponent") === "function") {
    try {
      component = (safeOwnProp(globalNg, "getComponent") as (el: Element) => unknown)(element);
    } catch {
      component = undefined;
    }
  }
  if (!component && Array.isArray(ngContext)) {
    // Angular LView typically holds the component instance at index 8 or nearby object with constructor.
    const candidate = ngContext[8];
    if (candidate && typeof candidate === "object") {
      component = candidate;
    }
  }
  if (!component || typeof component !== "object") return null;
  const ctor = safeOwnProp(component, "constructor");
  const rawName = typeof ctor === "function" ? safeOwnProp(ctor, "name") : undefined;
  if (typeof rawName !== "string" || !rawName.trim() || rawName === "Object") return null;
  const name = rawName.trim().slice(0, 160);
  const minified = isMinifiedComponentName(name);
  return {
    framework: "angular",
    ...(!minified ? { componentName: name } : {}),
    componentStack: [{ name, ...(minified ? { minified: true } : {}) }],
  };
}

/** Inspects non-React frontend frameworks (Vue 2/3, Svelte 4/5, Astro, Preact, Solid, Angular). */
export function inspectFrameworkElement(element: Element): FrameworkInspectionResult | null {
  return (
    inspectVue(element) ??
    inspectSvelte(element) ??
    inspectAstro(element) ??
    inspectPreact(element) ??
    inspectSolid(element) ??
    inspectAngular(element)
  );
}
