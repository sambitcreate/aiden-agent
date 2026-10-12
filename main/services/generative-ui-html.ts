import {
  GENERATIVE_UI_EXPORT_CSP,
  GENERATIVE_UI_EXPORT_HOST_CSP,
  GENERATIVE_UI_ESCAPE_MESSAGE,
  GENERATIVE_UI_GUEST_CSP,
  GENERATIVE_UI_HOST_LIBS,
  GENERATIVE_UI_IFRAME_SANDBOX,
  GENERATIVE_UI_KIT_LIB,
  GENERATIVE_UI_PROTOCOL_SCHEME,
  HTML_ARTIFACT_MIME_TYPE,
  MAX_HTML_ARTIFACT_BYTES,
  generativeUiDraftCsp,
  isHtmlArtifactTitle,
} from "../../renderer/shared/generative-ui.js";
import {
  GENERATIVE_UI_DEFAULT_THEME_VARS,
  GENERATIVE_UI_THEME_VARIABLES,
  sanitizeGenerativeUiThemeVars,
} from "../../renderer/shared/generative-ui-theme.js";
import {
  GENERATIVE_UI_PROMPT_MESSAGE,
  GENERATIVE_UI_READY_MESSAGE,
  GENERATIVE_UI_RESIZE_MESSAGE,
  GENERATIVE_UI_THEME_MESSAGE,
  MAX_GUEST_PROMPT_CHARS,
} from "../../renderer/shared/generative-ui-bridge.js";
import { generativeUiKitCss } from "./generative-ui-kit.js";

const FORBIDDEN_OPEN_TAG =
  /<\s*(iframe|object|embed|applet|frame|frameset|base)\b/iu;
const META_HTTP_EQUIV = /<\s*meta\b[^>]*\bhttp-equiv\s*=/iu;
const SCRIPT_WITH_SRC = /<\s*script\b[^>]*\bsrc\s*=/iu;
const JAVASCRIPT_URL = /javascript\s*:/iu;
const HTML_DATA_URL = /data\s*:\s*text\/html/iu;
const LINK_TAG = /<\s*link\b/iu;
const HTTP_SRC = /\bsrc\s*=\s*["']?\s*https?:\/\//iu;

export interface GenerativeUiThemeTokens {
  colorScheme: "light" | "dark";
  canvas: string;
  foreground: string;
  secondary: string;
  accent: string;
  /** Allowlisted semantic tokens; sanitized again on every parse. */
  vars?: Record<string, string>;
}

export interface GenerativeUiWrapOptions {
  /** Chat-inline preview: transparent canvas so the transcript shows through. */
  inline?: boolean;
  /** Draft previews block model scripts; only the nonce'd bridge may run. */
  bridgeNonce?: string;
  /** Snapshot capture: charts draw at their final values instead of animating in. */
  stillImage?: boolean;
}

/** Runs after the host libraries, before model code creates any chart. */
const STILL_IMAGE_SCRIPT = `<script>
(() => {
  const Chart = window.Chart;
  if (Chart && Chart.defaults) Chart.defaults.animation = false;
})();
</script>`;

const NONCE = /^[A-Za-z0-9+/=]{16,64}$/u;

/**
 * Host-owned guest runtime, placed before host libraries and model code.
 * Reports content height, relays Escape, exposes a frozen `window.aiden`
 * (sendPrompt, theme), and applies parent theme updates in place.
 */
function guestBridgeScript(nonce?: string): string {
  if (nonce !== undefined && !NONCE.test(nonce)) throw new Error("Invalid bridge nonce.");
  const attr = nonce ? ` nonce="${nonce}"` : "";
  return `<script${attr}>
(() => {
  const parentWindow = window.parent;
  const post = (data) => parentWindow.postMessage(data, "*");
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") post(${JSON.stringify(GENERATIVE_UI_ESCAPE_MESSAGE)});
  }, true);
  let lastHeight = 0;
  let frame = 0;
  const report = () => {
    frame = 0;
    // The inline body is a positioned flow root without min-height, so its
    // scrollHeight is the content (absolute and overflowing children
    // included) and shrinks with it; the root's scrollHeight never drops
    // below the frame's viewport.
    const body = document.body;
    const height = Math.ceil(
      body ? body.scrollHeight : document.documentElement.getBoundingClientRect().height,
    );
    if (Math.abs(height - lastHeight) < 2) return;
    lastHeight = height;
    post({ type: ${JSON.stringify(GENERATIVE_UI_RESIZE_MESSAGE)}, height });
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(report); };
  const sizes = new ResizeObserver(schedule);
  sizes.observe(document.documentElement);
  // Absolute children change scrollHeight without resizing any observed box.
  // The callback must never mutate the DOM itself, or it would re-trigger.
  let observedBody = null;
  new MutationObserver(() => {
    if (document.body && document.body !== observedBody) {
      observedBody = document.body;
      sizes.observe(observedBody);
    }
    schedule();
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  window.addEventListener("load", schedule);
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const seriesSlots = () => [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar("--chart-" + i));
  const chartColorKeys = [
    "backgroundColor", "borderColor", "pointBackgroundColor", "pointBorderColor",
    "hoverBackgroundColor", "hoverBorderColor",
  ];
  // Datasets colored straight from aiden.series() hold copied strings, so a
  // theme change would leave them on the old palette. Swap only those values.
  const remapSeriesColors = (before, after) => {
    const Chart = window.Chart;
    if (!Chart || !Chart.instances) return;
    const key = (value) => String(value).trim().toLowerCase();
    const swaps = new Map();
    before.forEach((previous, index) => {
      const next = after[index];
      if (previous && next && key(previous) !== key(next)) swaps.set(key(previous), next);
    });
    if (swaps.size === 0) return;
    const swap = (value) => (typeof value === "string" && swaps.has(key(value)) ? swaps.get(key(value)) : value);
    for (const chart of Object.values(Chart.instances)) {
      const datasets = chart && chart.data && Array.isArray(chart.data.datasets) ? chart.data.datasets : [];
      for (const dataset of datasets) {
        if (!dataset || typeof dataset !== "object") continue;
        for (const name of chartColorKeys) {
          const value = dataset[name];
          if (Array.isArray(value)) dataset[name] = value.map(swap);
          else if (typeof value === "string") dataset[name] = swap(value);
        }
      }
    }
  };
  const applyChartDefaults = () => {
    const Chart = window.Chart;
    if (!Chart || !Chart.defaults) return;
    Chart.defaults.color = cssVar("--text-secondary") || Chart.defaults.color;
    Chart.defaults.borderColor = cssVar("--border-separator") || Chart.defaults.borderColor;
    const family = cssVar("--font-ui-family");
    if (family && Chart.defaults.font) Chart.defaults.font.family = family;
    for (const chart of Object.values(Chart.instances || {})) chart.update("none");
  };
  window.addEventListener("message", (event) => {
    if (event.source !== parentWindow) return;
    const data = event.data;
    if (!data || data.type !== ${JSON.stringify(GENERATIVE_UI_THEME_MESSAGE)} || !data.vars || typeof data.vars !== "object") return;
    const root = document.documentElement;
    const scheme = data.colorScheme === "dark" ? "dark" : "light";
    const seriesBefore = seriesSlots();
    root.dataset.colorScheme = scheme;
    root.style.colorScheme = scheme;
    for (const [name, value] of Object.entries(data.vars)) {
      if (/^--[a-z0-9-]+$/.test(name) && typeof value === "string" && !/[;{}<>]|url\\(/i.test(value)) {
        root.style.setProperty(name, value);
      }
    }
    remapSeriesColors(seriesBefore, seriesSlots());
    applyChartDefaults();
    window.dispatchEvent(new CustomEvent("aiden:themechange"));
  });
  const names = ${JSON.stringify(GENERATIVE_UI_THEME_VARIABLES)};
  const api = Object.freeze({
    sendPrompt(text) {
      if (typeof text !== "string") return;
      post({ type: ${JSON.stringify(GENERATIVE_UI_PROMPT_MESSAGE)}, text: text.slice(0, ${MAX_GUEST_PROMPT_CHARS + 1}) });
    },
    theme() {
      return Object.fromEntries(names.map((name) => [name, cssVar(name)]));
    },
    series() {
      return [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar("--chart-" + i)).filter(Boolean);
    },
  });
  // Configurable so a guest's own top-level aiden (Design Studio pages, older
  // artifacts) shadows it instead of failing the whole script. Locking it adds
  // no security: a guest can always post to the parent directly.
  Object.defineProperty(window, "aiden", { value: api, writable: false, configurable: true, enumerable: true });
  document.addEventListener("DOMContentLoaded", applyChartDefaults);
  post({ type: ${JSON.stringify(GENERATIVE_UI_READY_MESSAGE)} });
})();
</script>`;
}

const DEFAULT_THEME: GenerativeUiThemeTokens = {
  colorScheme: "light",
  canvas: "#f6f7f9",
  foreground: "#181817",
  secondary: "#6b6b68",
  accent: "#0b7de5",
  vars: GENERATIVE_UI_DEFAULT_THEME_VARS,
};

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

/**
 * Semantic defaults implied by a legacy four-color caller. Only fields the
 * caller supplied as valid hex contribute; explicit `vars` are applied after
 * these and always win.
 */
function legacyDerivedVars(record: Record<string, unknown>): Record<string, string> {
  const hex = (input: unknown): string | undefined =>
    typeof input === "string" && HEX_COLOR.test(input) ? input.toLowerCase() : undefined;
  const derived: Record<string, string> = {};
  const foreground = hex(record.foreground);
  if (foreground) {
    derived["--text-primary"] = foreground;
    derived["--focus-ring"] = foreground;
  }
  const secondary = hex(record.secondary);
  if (secondary) {
    derived["--text-secondary"] = secondary;
    derived["--text-tertiary"] = secondary;
    derived["--text-quaternary"] = secondary;
  }
  const accent = hex(record.accent);
  if (accent) derived["--accent"] = accent;
  return derived;
}

export function parseGenerativeUiTheme(
  value: unknown,
): GenerativeUiThemeTokens {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_THEME;
  // The built-in default keeps its own light token values rather than deriving
  // them from its four legacy colors.
  if (value === DEFAULT_THEME) return DEFAULT_THEME;
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
    vars: {
      ...GENERATIVE_UI_DEFAULT_THEME_VARS,
      ...legacyDerivedVars(record),
      ...sanitizeGenerativeUiThemeVars(record.vars),
    },
  };
}

function themeVariableLines(vars: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(vars ?? {})
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
}

/**
 * The final artifact's content rules, applied to a streaming prefix without
 * throwing. A partial tag is fine; anything the final check would refuse
 * stops the draft early (the draft CSP already blocks scripts and network).
 */
export function isGenerativeUiDraftAcceptable(html: string): boolean {
  if (html.includes("\0") || Buffer.byteLength(html, "utf8") > MAX_HTML_ARTIFACT_BYTES) return false;
  return ![
    FORBIDDEN_OPEN_TAG,
    SCRIPT_WITH_SRC,
    META_HTTP_EQUIV,
    LINK_TAG,
    JAVASCRIPT_URL,
    HTML_DATA_URL,
    HTTP_SRC,
  ].some((pattern) => pattern.test(html));
}

export function validateGenerativeUiHtml(html: string): Buffer {
  if (typeof html !== "string" || html.length === 0) {
    throw new Error("render_artifact requires non-empty HTML.");
  }
  if (html.includes("\0")) {
    throw new Error("Artifact HTML cannot contain NUL bytes.");
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
  if (FORBIDDEN_OPEN_TAG.test(html) || SCRIPT_WITH_SRC.test(html) || META_HTTP_EQUIV.test(html) || LINK_TAG.test(html)) {
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
  const allowed = head[1].match(
    /<(style|script)\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/\1>/giu,
  );
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

function hostLibraryTags(): string {
  return GENERATIVE_UI_HOST_LIBS.map((name) => {
    const href = `${GENERATIVE_UI_PROTOCOL_SCHEME}://${name}`;
    if (name.endsWith(".css")) {
      return `<link rel="stylesheet" href="${href}">`;
    }
    return `<script src="${href}"></script>`;
  }).join("\n");
}

/** Build the main-owned preview document. Renderer must not concatenate guest HTML. */
export function wrapGenerativeUiHtml(
  html: string,
  title: string,
  theme: GenerativeUiThemeTokens = DEFAULT_THEME,
  options: GenerativeUiWrapOptions = {},
): string {
  const bytes = validateGenerativeUiHtml(html);
  const fragment = extractFragment(bytes.toString("utf8"));
  return `${guestDocumentHead(title, theme, options, GENERATIVE_UI_GUEST_CSP)}${fragment}
</body>
</html>
`;
}

/**
 * The opening of a streaming draft document: everything up to `<body>`, with
 * a nonce-only script policy. Main appends the model's partial HTML after it
 * as the tool call streams; the browser's incremental parser renders it.
 */
export function generativeUiDraftDocumentHead(
  title: string,
  theme: GenerativeUiThemeTokens = DEFAULT_THEME,
  nonce: string,
): string {
  if (!NONCE.test(nonce)) throw new Error("Invalid bridge nonce.");
  return guestDocumentHead(
    title,
    theme,
    { inline: true, bridgeNonce: nonce },
    generativeUiDraftCsp(nonce),
  );
}

function guestDocumentHead(
  title: string,
  theme: GenerativeUiThemeTokens,
  options: GenerativeUiWrapOptions,
  csp: string,
): string {
  const safeTitle = escapeHtml(title);
  const tokens = parseGenerativeUiTheme(theme);
  return `<!DOCTYPE html>
<html lang="en" data-color-scheme="${tokens.colorScheme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${safeTitle}</title>
${guestBridgeScript(options.bridgeNonce)}
${hostLibraryTags()}
${options.stillImage ? STILL_IMAGE_SCRIPT : ""}
<style>
:root {
  color-scheme: ${tokens.colorScheme};
  --artifact-canvas: ${tokens.canvas};
  --artifact-text: ${tokens.foreground};
  --artifact-secondary: ${tokens.secondary};
  --artifact-accent: ${tokens.accent};
${themeVariableLines(tokens.vars)}
}
html, body {
  margin: 0;
  ${options.inline ? "" : "min-height: 100%;"}
  background: ${options.inline ? "transparent" : "var(--artifact-canvas)"};
  color: var(--text-primary, var(--artifact-text));
  font-family: var(--font-ui-family, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
}
/* Body only, so rem stays the browser's 16px for authored layouts. Inline
   bodies are positioned flow roots so their scrollHeight is the content,
   absolute and overflowing children included. */
body {
  ${options.inline ? "font-size: var(--ui-font-size, 14px);\n  display: flow-root;\n  position: relative;" : ""}
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
  for (const name of GENERATIVE_UI_HOST_LIBS) {
    const href = `${GENERATIVE_UI_PROTOCOL_SCHEME}://${name}`;
    const source = name === GENERATIVE_UI_KIT_LIB ? generativeUiKitCss() : libraries[name];
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
