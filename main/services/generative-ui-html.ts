import {
  GENERATIVE_UI_EXPORT_CSP,
  GENERATIVE_UI_EXPORT_HOST_CSP,
  GENERATIVE_UI_GUEST_CSP,
  GENERATIVE_UI_HOST_LIBS,
  GENERATIVE_UI_IFRAME_SANDBOX,
  GENERATIVE_UI_PROTOCOL_SCHEME,
  HTML_ARTIFACT_MIME_TYPE,
  MAX_HTML_ARTIFACT_BYTES,
  isHtmlArtifactTitle,
} from "../../renderer/shared/generative-ui.js";

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
}

const DEFAULT_THEME: GenerativeUiThemeTokens = {
  colorScheme: "light",
  canvas: "#f6f7f9",
  foreground: "#181817",
  secondary: "#6b6b68",
  accent: "#0b7de5",
};

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

export function parseGenerativeUiTheme(
  value: unknown,
): GenerativeUiThemeTokens {
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
): string {
  const bytes = validateGenerativeUiHtml(html);
  const fragment = extractFragment(bytes.toString("utf8"));
  const safeTitle = escapeHtml(title);
  const tokens = parseGenerativeUiTheme(theme);
  return `<!DOCTYPE html>
<html lang="en" data-color-scheme="${tokens.colorScheme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${GENERATIVE_UI_GUEST_CSP}">
<title>${safeTitle}</title>
${hostLibraryTags()}
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
  for (const name of GENERATIVE_UI_HOST_LIBS) {
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
