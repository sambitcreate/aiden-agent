import { createHash } from "node:crypto";
import type { ChatUiVisualV1 } from "../../renderer/shared/aiden-ui/types.js";
import { THEME_PRESETS, type AppearanceScheme, type ThemePresetId } from "../../renderer/shared/appearance.js";
import type { GENERATIVE_UI_HOST_LIBS } from "../../renderer/shared/generative-ui.js";
import {
  VISUAL_VIEWER_CSP,
  VISUAL_VIEWER_PAYLOAD_ELEMENT_ID,
  type VisualViewerPayload,
} from "../../renderer/shared/visual-viewer.js";
import { inlineGenerativeUiHostLibraries, wrapGenerativeUiHtml } from "./generative-ui-html.js";

/**
 * Builds the self-contained document phones open for one visual (Remote
 * contract revision 35, `chat-visual-viewer-v1`). Electron-free: the viewer
 * bundle and host libraries are passed in.
 */

/** The built viewer page (`build/renderer/visual-viewer/`), read once by main. */
export interface VisualViewerBundle {
  script: string;
  style: string;
}

export const MAX_VISUAL_VIEWER_DOCUMENT_BYTES = 12 * 1024 * 1024;

export interface VisualViewerAppearance {
  scheme: AppearanceScheme;
  preset: ThemePresetId;
}

export type VisualViewerSource =
  | { kind: "html"; title: string; html: string; layout?: "wide" }
  | {
      kind: "ui";
      title: string;
      visual: ChatUiVisualV1;
      attachments: readonly { id: string; mimeType: string; data: string }[];
      layout?: "wide";
    };

const PRESET_IDS = new Set<string>(THEME_PRESETS.map((preset) => preset.id));

/**
 * Reads the document query. Both keys are optional; a preset this host does
 * not know falls back to Aiden's own, so a phone with a newer catalog still
 * gets a document. Anything else is a bad request.
 */
export function parseVisualViewerQuery(query: URLSearchParams): VisualViewerAppearance {
  for (const key of query.keys()) {
    if (key !== "scheme" && key !== "theme") throw new Error(`Unknown visual document parameter ${key}.`);
  }
  if (query.getAll("scheme").length > 1 || query.getAll("theme").length > 1) {
    throw new Error("Visual document parameters may appear once.");
  }
  const scheme = query.get("scheme") ?? "light";
  if (scheme !== "light" && scheme !== "dark") throw new Error("Visual document scheme must be light or dark.");
  const theme = query.get("theme") ?? "aiden";
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(theme)) throw new Error("Visual document theme is invalid.");
  return { scheme, preset: PRESET_IDS.has(theme) ? (theme as ThemePresetId) : "aiden" };
}

/**
 * Host libraries an HTML visual can reach. Each one is large (Plotly alone is
 * several MB), so a phone document carries only those its source names. The
 * component kit stylesheet is small and always included.
 */
function referencedLibrary(html: string): (name: (typeof GENERATIVE_UI_HOST_LIBS)[number]) => boolean {
  const usesChart = /\bChart\b/u.test(html);
  const usesPlotly = /\bPlotly\b/u.test(html);
  const usesKatex = /katex/iu.test(html);
  return (name) => {
    switch (name) {
      case "chart.js":
        return usesChart;
      case "plotly.js":
        return usesPlotly;
      case "katex.js":
      case "katex.css":
        return usesKatex;
      case "aiden-ui.css":
        return true;
    }
  };
}

/** JSON that is safe inside `<script type="application/json">`. */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/&/gu, "\\u0026")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

function escapeText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

export function buildVisualViewerDocument(
  source: VisualViewerSource,
  appearance: VisualViewerAppearance,
  bundle: VisualViewerBundle,
  libraries: Readonly<Record<string, string>>,
): string {
  // The bundle is inlined verbatim, so it must not be able to end its own element.
  if (/<\/script/iu.test(bundle.script) || /<\/style/iu.test(bundle.style)) {
    throw new Error("The visual viewer bundle cannot be inlined.");
  }
  const base = {
    version: 1 as const,
    title: source.title,
    scheme: appearance.scheme,
    preset: appearance.preset,
    ...(source.layout === "wide" ? { layout: "wide" as const } : {}),
  };
  const payload: VisualViewerPayload = source.kind === "ui"
    ? { ...base, kind: "ui", visual: source.visual, attachments: source.attachments.map(({ id, mimeType, data }) => ({ id, mimeType, data })) }
    : {
        ...base,
        kind: "html",
        guest: inlineGenerativeUiHostLibraries(
          wrapGenerativeUiHtml(source.html, source.title, undefined, { inline: true }),
          libraries,
          referencedLibrary(source.html),
        ),
      };
  const document = `<!DOCTYPE html>
<html lang="en" data-color-scheme="${appearance.scheme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${VISUAL_VIEWER_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="${appearance.scheme}">
<title>${escapeText(source.title)}</title>
<style>
${bundle.style}
</style>
</head>
<body>
<div id="root"></div>
<script type="application/json" id="${VISUAL_VIEWER_PAYLOAD_ELEMENT_ID}">${scriptSafeJson(payload)}</script>
<script>
${bundle.script}
</script>
</body>
</html>
`;
  if (Buffer.byteLength(document, "utf8") > MAX_VISUAL_VIEWER_DOCUMENT_BYTES) {
    throw new Error("This visual is too large to open on a phone.");
  }
  return document;
}

/** A strong validator for the exact document bytes. */
export function visualViewerDocumentEtag(document: string): string {
  return `"${createHash("sha256").update(document).digest("base64url")}"`;
}
