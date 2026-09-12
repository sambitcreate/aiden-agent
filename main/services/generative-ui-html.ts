import {
  GENERATIVE_UI_EXPORT_CSP,
  GENERATIVE_UI_EXPORT_HOST_CSP,
  GENERATIVE_UI_ARTIFACT_LIBS,
  GENERATIVE_UI_ESCAPE_MESSAGE,
  GENERATIVE_UI_GUEST_CSP,
  GENERATIVE_UI_IFRAME_SANDBOX,
  GENERATIVE_UI_PROTOCOL_SCHEME,
  generativeUiGuestCsp,
  HTML_ARTIFACT_MIME_TYPE,
  MAX_HTML_ARTIFACT_BYTES,
  isHtmlArtifactTitle,
} from "../../renderer/shared/generative-ui.js";
import {
  DESIGN_PICKER_COMMAND,
  DESIGN_PICKER_SELECTION,
} from "../../renderer/shared/design-workspace.js";

const FORBIDDEN_OPEN_TAG = /<\s*(iframe|object|embed|applet|frame|frameset|base)\b/iu;
const META_HTTP_EQUIV = /<\s*meta\b[^>]*\bhttp-equiv\s*=/iu;
const SCRIPT_WITH_SRC = /<\s*script\b[^>]*\bsrc\s*=/iu;
const JAVASCRIPT_URL = /javascript\s*:/iu;
const HTML_DATA_URL = /data\s*:\s*text\/html/iu;
const LINK_TAG = /<\s*link\b/iu;
const HTTP_SRC = /\bsrc\s*=\s*["']?\s*https?:\/\//iu;

export const OMITTED_DESIGN_HTML_SENTINEL =
  "[Previous Design HTML omitted by Aiden; the bounded current revision is supplied separately.]";

export interface GenerativeUiThemeTokens {
  colorScheme: "light" | "dark";
  canvas: string;
  foreground: string;
  secondary: string;
  accent: string;
}

const DEFAULT_THEME: GenerativeUiThemeTokens = {
  colorScheme: "light",
  canvas: "#f6f7f9",
  foreground: "#181817",
  secondary: "#6b6b68",
  accent: "#0b7de5",
};

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

export function parseGenerativeUiTheme(value: unknown): GenerativeUiThemeTokens {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_THEME;
  const record = value as Record<string, unknown>;
  const colorScheme = record.colorScheme === "dark" ? "dark" : "light";
  const color = (input: unknown, fallback: string): string =>
    typeof input === "string" && HEX_COLOR.test(input) ? input.toLowerCase() : fallback;
  return {
    colorScheme,
    canvas: color(record.canvas, DEFAULT_THEME.canvas),
    foreground: color(record.foreground, DEFAULT_THEME.foreground),
    secondary: color(record.secondary, DEFAULT_THEME.secondary),
    accent: color(record.accent, DEFAULT_THEME.accent),
  };
}

export function validateGenerativeUiHtml(html: string): Buffer {
  if (typeof html !== "string" || html.length === 0) {
    throw new Error("render_artifact requires non-empty HTML.");
  }
  if (html.includes("\0")) {
    throw new Error("Artifact HTML cannot contain NUL bytes.");
  }
  if (html.includes(OMITTED_DESIGN_HTML_SENTINEL)) {
    throw new Error("Aiden's omitted Design HTML placeholder cannot be rendered as an artifact.");
  }
  const bytes = Buffer.from(html, "utf8");
  if (bytes.byteLength > MAX_HTML_ARTIFACT_BYTES) {
    throw new Error(
      `Artifact HTML exceeds ${MAX_HTML_ARTIFACT_BYTES.toLocaleString("en-US")} bytes.`,
    );
  }
  if (bytes.toString("utf8") !== html) {
    throw new Error("Artifact HTML is not valid UTF-8.");
  }
  if (
    FORBIDDEN_OPEN_TAG.test(html) ||
    SCRIPT_WITH_SRC.test(html) ||
    META_HTTP_EQUIV.test(html) ||
    LINK_TAG.test(html)
  ) {
    throw new Error(
      "Artifact HTML cannot include iframes, remote documents, or external scripts. Use inline JavaScript; Chart.js, Plotly, and KaTeX are provided by Aiden.",
    );
  }
  if (JAVASCRIPT_URL.test(html) || HTML_DATA_URL.test(html) || HTTP_SRC.test(html)) {
    throw new Error(
      "Artifact HTML cannot load remote URLs or javascript: / data:text/html resources.",
    );
  }
  return bytes;
}

export function requireGenerativeUiTitle(value: unknown): string {
  if (!isHtmlArtifactTitle(value)) {
    throw new Error("render_artifact requires a 1–120 character title without control characters.");
  }
  return value;
}

function extractHeadInline(html: string): string {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/iu.exec(html);
  if (!head?.[1]) return "";
  const allowed = head[1].match(/<(style|script)\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/\1>/giu);
  return allowed ? allowed.join("\n") : "";
}

function extractFragment(html: string): string {
  const trimmed = html.trim();
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/iu.exec(trimmed);
  const headInline = extractHeadInline(trimmed);
  if (body?.[1] !== undefined) {
    return [headInline, body[1]].filter(Boolean).join("\n");
  }
  if (/^\s*<(!doctype|html)\b/iu.test(trimmed)) {
    const stripped = trimmed
      .replace(/^\s*<!doctype[^>]*>/iu, "")
      .replace(/<\/?html\b[^>]*>/giu, "")
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/iu, "")
      .replace(/<\/?body\b[^>]*>/giu, "");
    return [headInline, stripped.trim() || trimmed].filter(Boolean).join("\n");
  }
  return html;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

/** Preserve the guest source as one safely quoted outer-document attribute. */
function escapeSrcdoc(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function hostLibraryTags(designStudio: boolean): string {
  const libraries = designStudio
    ? [...GENERATIVE_UI_ARTIFACT_LIBS, "react-grab-primitives.js" as const]
    : GENERATIVE_UI_ARTIFACT_LIBS;
  return libraries
    .map((name) => {
      const href = `${GENERATIVE_UI_PROTOCOL_SCHEME}://${name}`;
      if (name.endsWith(".css")) {
        return `<link rel="stylesheet" href="${href}">`;
      }
      return `<script src="${href}"></script>`;
    })
    .join("\n");
}

function designPickerBridge(capability: string): string {
  return `<style>
[data-aiden-design-picker-box] {
  position: fixed;
  z-index: 2147483646;
  display: none;
  pointer-events: none;
  border: 2px solid var(--artifact-accent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--artifact-accent) 9%, transparent);
  box-sizing: border-box;
}
[data-aiden-design-picker-label] {
  position: absolute;
  inset-inline-start: -2px;
  bottom: calc(100% + 5px);
  max-width: min(280px, calc(100vw - 16px));
  overflow: hidden;
  border-radius: 6px;
  background: var(--artifact-accent);
  color: white;
  font: 600 11px/1.2 ui-sans-serif, system-ui, sans-serif;
  padding: 4px 6px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
html[data-aiden-design-picker-active="true"],
html[data-aiden-design-picker-active="true"] * { cursor: crosshair !important; }
</style>
<script>
(() => {
  "use strict";
  const capability = ${JSON.stringify(capability)};
  const commandType = ${JSON.stringify(DESIGN_PICKER_COMMAND)};
  const selectionType = ${JSON.stringify(DESIGN_PICKER_SELECTION)};
  const primitives = globalThis.AidenReactGrabPrimitives;
  if (!primitives) return;
  let active = false;
  let current = null;
  let selectedSelector = "";
  const box = document.createElement("div");
  box.setAttribute("data-aiden-design-picker-box", "");
  box.setAttribute("data-react-grab-ignore", "");
  const badge = document.createElement("span");
  badge.setAttribute("data-aiden-design-picker-label", "");
  box.append(badge);
  document.documentElement.append(box);

  const compact = (value, limit) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, limit);
  const labelFor = (element) =>
    compact(
      element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.textContent ||
        element.getAttribute("data-aiden-id") ||
        element.tagName.toLowerCase(),
      160,
    );
  const show = (element, selected) => {
    if (!(element instanceof Element)) {
      box.style.display = "none";
      current = null;
      return;
    }
    current = element;
    const bounds = primitives.getElementBounds(element);
    box.style.display = "block";
    box.style.left = bounds.x + "px";
    box.style.top = bounds.y + "px";
    box.style.width = bounds.width + "px";
    box.style.height = bounds.height + "px";
    box.style.borderStyle = selected ? "solid" : "dashed";
    badge.textContent = (selected ? "Selected · " : "") + labelFor(element);
  };
  const resolveSelected = () => {
    if (!selectedSelector) return null;
    try {
      return document.querySelector(selectedSelector);
    } catch {
      return null;
    }
  };
  const setActive = (enabled) => {
    active = enabled;
    document.documentElement.setAttribute("data-aiden-design-picker-active", String(enabled));
    if (!enabled) show(resolveSelected(), true);
  };
  const targetAt = (event) => {
    const target = primitives.getElementAtPoint(event.clientX, event.clientY, {
      filter: (candidate) =>
        primitives.isElementGrabbable(candidate) &&
        !candidate.closest("[data-aiden-design-picker-box]"),
    });
    return target || null;
  };
  const selectionFor = (element) => {
    const rawId = compact(element.getAttribute("data-aiden-id"), 120);
    const elementId = /^[A-Za-z0-9._:-]{1,120}$/.test(rawId) ? rawId : "";
    const selector = compact(
      elementId ? '[data-aiden-id="' + elementId + '"]' : primitives.getElementSelector(element),
      512,
    );
    const label = labelFor(element);
    const role = compact(element.getAttribute("role"), 64);
    const text = compact(element.matches("input, textarea, select") ? "" : element.textContent, 240);
    return {
      version: 1,
      tagName: element.tagName.toLowerCase().slice(0, 32),
      label: label || element.tagName.toLowerCase(),
      selector: selector || element.tagName.toLowerCase(),
      ...(elementId ? { elementId } : {}),
      ...(role ? { role } : {}),
      ...(text ? { text } : {}),
    };
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
    if (event.data.type !== commandType || event.data.capability !== capability) return;
    selectedSelector = typeof event.data.selectedSelector === "string"
      ? event.data.selectedSelector.slice(0, 512)
      : "";
    setActive(event.data.enabled === true);
  });
  document.addEventListener("pointermove", (event) => {
    if (!active) return;
    show(targetAt(event), false);
  }, true);
  document.addEventListener("click", (event) => {
    if (!active) return;
    const target = targetAt(event);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const selection = selectionFor(target);
    selectedSelector = selection.selector;
    show(target, true);
    window.parent.postMessage({ type: selectionType, capability, selection, additive: event.shiftKey === true }, "*");
  }, true);
  document.addEventListener("focusin", (event) => {
    if (active && event.target instanceof Element) show(event.target, false);
  }, true);
  document.addEventListener("keydown", (event) => {
    if (!active || event.key !== "Enter" || !(document.activeElement instanceof Element)) return;
    const target = document.activeElement;
    if (target === document.documentElement || target === document.body) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const selection = selectionFor(target);
    selectedSelector = selection.selector;
    show(target, true);
    window.parent.postMessage({ type: selectionType, capability, selection, additive: event.shiftKey === true }, "*");
  }, true);
})();
</script>`;
}

export interface GenerativeUiWrapperOptions {
  /** Main-generated capability enables the Design-only, no-authority selection bridge. */
  designCapability?: string;
}

/** Build the main-owned preview document. Renderer must not concatenate guest HTML. */
export function wrapGenerativeUiHtml(
  html: string,
  title: string,
  theme: GenerativeUiThemeTokens = DEFAULT_THEME,
  options: GenerativeUiWrapperOptions = {},
): string {
  const bytes = validateGenerativeUiHtml(html);
  const fragment = extractFragment(bytes.toString("utf8"));
  const safeTitle = escapeHtml(title);
  const tokens = parseGenerativeUiTheme(theme);
  const designStudio =
    typeof options.designCapability === "string" && options.designCapability.length > 0;
  const guestCsp = generativeUiGuestCsp(designStudio);
  return `<!DOCTYPE html>
<html lang="en" data-color-scheme="${tokens.colorScheme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${guestCsp}">
<title>${safeTitle}</title>
${hostLibraryTags(designStudio)}
<style>
:root {
  color-scheme: ${tokens.colorScheme};
  --artifact-canvas: ${tokens.canvas};
  --artifact-text: ${tokens.foreground};
  --artifact-secondary: ${tokens.secondary};
  --artifact-accent: ${tokens.accent};
}
html, body {
  margin: 0;
  min-height: 100%;
  background: var(--artifact-canvas);
  color: var(--artifact-text);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
button, input, select, textarea {
  color: inherit;
  font: inherit;
  accent-color: var(--artifact-accent);
}
* { scrollbar-color: var(--artifact-secondary) var(--artifact-canvas); }
</style>
</head>
<body>
${designStudio ? designPickerBridge(options.designCapability!) : ""}
<script>
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.parent.postMessage(${JSON.stringify(GENERATIVE_UI_ESCAPE_MESSAGE)}, "*");
}, true);
</script>
${fragment}
</body>
</html>
`;
}

export function generativeUiExportDocument(
  html: string,
  title: string,
  libraries: Readonly<Record<string, string>>,
  theme?: GenerativeUiThemeTokens,
): string {
  let guestDocument = wrapGenerativeUiHtml(html, title, theme).replace(
    GENERATIVE_UI_GUEST_CSP,
    GENERATIVE_UI_EXPORT_CSP,
  );
  for (const name of GENERATIVE_UI_ARTIFACT_LIBS) {
    const href = `${GENERATIVE_UI_PROTOCOL_SCHEME}://${name}`;
    const source = libraries[name];
    if (!source) {
      throw new Error(`Export is missing host library ${name}.`);
    }
    if (name.endsWith(".css")) {
      guestDocument = guestDocument.replace(
        `<link rel="stylesheet" href="${href}">`,
        `<style>\n${source}\n</style>`,
      );
    } else {
      guestDocument = guestDocument.replace(
        `<script src="${href}"></script>`,
        `<script>\n${source}\n</script>`,
      );
    }
  }
  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${GENERATIVE_UI_EXPORT_HOST_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
iframe { display: block; width: 100%; height: 100%; border: 0; }
</style>
</head>
<body>
<iframe title="${safeTitle}" sandbox="${GENERATIVE_UI_IFRAME_SANDBOX}" referrerpolicy="no-referrer" srcdoc="${escapeSrcdoc(guestDocument)}"></iframe>
</body>
</html>
`;
}

export function htmlArtifactByteLength(html: string): number {
  return Buffer.byteLength(html, "utf8");
}

export { HTML_ARTIFACT_MIME_TYPE };
