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
import { FOREIGN_END_LIMIT, HtmlScanner, readExcerpt, SELECT_FOREIGN_LIMIT, SELECT_RAW_TEXT_LIMIT, XML_DECLARATIONS_LIMIT, XML_HTML_TEXT_LIMIT, XML_MARKUP_IN_DECLARATION_LIMIT, type HtmlFindings } from "./generative-ui-html-scan.js";

// The admission check (generative-ui-html-scan.ts) reads the HTML the way a
// browser does and refuses only what would load or run something; the
// sandbox's CSP is what actually blocks loads.
const MAX_QUOTED_MATCH_CHARS = 60;

function quoteMatch(excerpt: string): string {
  const { text, joined } = readExcerpt(excerpt);
  const flat = text.replace(/\s+/gu, " ").trim();
  const quoted = JSON.stringify(flat.length > MAX_QUOTED_MATCH_CHARS ? `${flat.slice(0, MAX_QUOTED_MATCH_CHARS - 1)}…` : flat);
  return joined ? `${quoted}, which a script joins from strings` : quoted;
}

/** What to change for a visual refused as too complex to check. */
function limitAdvice(limit: string): string {
  if (limit === XML_DECLARATIONS_LIMIT) return "Remove the DOCTYPE internal subset and the <!ENTITY> and <!ATTLIST> declarations from the XML the script parses.";
  if (limit === XML_HTML_TEXT_LIMIT) {
    return "Give those elements text only (no child elements, comments or CDATA sections holding < or &), build them with document.createElement, or parse the markup as text/html.";
  }
  if (limit === XML_MARKUP_IN_DECLARATION_LIMIT) return "Remove the < and > from the processing instruction or DOCTYPE in the XML the script parses.";
  if (limit.endsWith(FOREIGN_END_LIMIT)) {
    return "Close the HTML elements in an SVG <foreignObject>, <desc> or <title> or in MathML text before ending the element around them.";
  }
  if (limit.endsWith(SELECT_RAW_TEXT_LIMIT)) return `Move the ${limit.slice(0, limit.indexOf(">") + 1)} out of the <select>.`;
  if (limit.endsWith(SELECT_FOREIGN_LIMIT)) {
    return "Keep only SVG or MathML inside an <svg> or <math> in a <select>, closing each with its own end tag, and move HTML such as <div> out of the select.";
  }
  return "Simplify the markup.";
}

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
  // Configurable so a guest's own top-level aiden (standalone pages, older
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

export interface GenerativeUiDraftCheck {
  /**
   * Adds the next streamed chunk. Returns the text newly checked, which is
   * safe to show (empty while short chunks are held), or false once the
   * draft so far breaks the final artifact's rules.
   */
  append(chunk: string): string | false;
  /** Checks the text still held at the end of the stream: the text, or false. */
  finish(): string | false;
}

/**
 * Chunks are held until there are this many characters, or as many as the
 * token still being read holds, whichever comes first. parse5 copies an
 * unfinished token's text for every chunk written, so feeding it a long tag
 * in tiny chunks would take quadratic time.
 */
const DRAFT_CHECK_BATCH_CHARS = 8192;

/**
 * The final artifact's content rules, applied to a streaming draft chunk by
 * chunk without throwing. Each chunk is read once, so a whole draft costs
 * about what one final check does. A partial tag is fine as far as it goes;
 * anything the final check would refuse stops the draft early (the draft CSP
 * already blocks scripts and network). Only text the check has read is
 * returned, so a caller that shows what `append` returns never shows
 * unchecked markup.
 */
export function createGenerativeUiDraftCheck(): GenerativeUiDraftCheck {
  // A draft streams in right after the draft head's `<body>`, so it is read there.
  const scanner = new HtmlScanner();
  scanner.write(GUEST_BODY_OPEN);
  // Once a <noscript> tag appears, the draft is also read with scripting off.
  let withoutScripting: HtmlScanner | undefined;
  const written: string[] = [];
  let tail = "";
  let bytes = 0;
  let held = "";
  let refused = false;
  const check = (): string | false => {
    const chunk = held;
    held = "";
    if (chunk.length === 0) return "";
    scanner.write(chunk);
    if (withoutScripting !== undefined) {
      withoutScripting.write(chunk);
    } else {
      written.push(chunk);
      const recent = tail + chunk;
      tail = recent.slice(-(NOSCRIPT_TAG_TEXT.length - 1));
      if (NOSCRIPT_TAG.test(recent)) {
        withoutScripting = new HtmlScanner(0, false);
        withoutScripting.write(GUEST_BODY_OPEN);
        withoutScripting.write(written.join(""));
        written.length = 0;
      }
    }
    const findings = mergeFindings(scanner.findings(), withoutScripting?.findings());
    refused = findings.embed !== undefined || findings.url !== undefined || findings.limit !== undefined;
    return refused ? false : chunk;
  };
  return {
    append(chunk) {
      if (refused) return false;
      bytes += Buffer.byteLength(chunk, "utf8");
      if (chunk.includes("\0") || bytes > MAX_HTML_ARTIFACT_BYTES) {
        refused = true;
        return false;
      }
      held += chunk;
      const unfinished = Math.max(scanner.unfinishedSize(), withoutScripting?.unfinishedSize() ?? 0);
      return held.length >= Math.min(DRAFT_CHECK_BATCH_CHARS, unfinished) ? check() : "";
    },
    finish() {
      return refused ? false : check();
    },
  };
}

/** Whether a streaming prefix still meets the final artifact's content rules. */
export function isGenerativeUiDraftAcceptable(html: string): boolean {
  const check = createGenerativeUiDraftCheck();
  return check.append(html) !== false && check.finish() !== false;
}

/**
 * Where a guest's markup lands: the guest document head ends with `<body>`
 * and the wrapper closes the body after it. Reading markup between these
 * puts the parser in the state a browser is in at that point of the real
 * document, so the check reads exactly the bytes that render.
 */
const GUEST_BODY_OPEN = "<!DOCTYPE html>\n<html><head></head>\n<body>\n";
const GUEST_BODY_CLOSE = "\n</body>\n</html>\n";

/**
 * A `<noscript>` start tag. Markup without one reads the same with scripting
 * on or off; a tag name is never decoded, so this text must be present for
 * the parser to create the element.
 */
const NOSCRIPT_TAG_TEXT = "<noscript";
const NOSCRIPT_TAG = /<noscript/iu;

function mergeFindings(first: HtmlFindings, second: HtmlFindings | undefined): HtmlFindings {
  if (second === undefined) return first;
  return { limit: first.limit ?? second.limit, embed: first.embed ?? second.embed, url: first.url ?? second.url };
}

/**
 * What the HTML check finds in `markup` rendered where a guest's body goes,
 * in a frame that runs scripts and, when it has a `<noscript>`, in a viewer
 * or exported page with scripts off.
 */
function scanGuestBody(markup: string): HtmlFindings {
  const scan = (scripting: boolean) => {
    const scanner = new HtmlScanner(0, scripting);
    scanner.write(GUEST_BODY_OPEN);
    scanner.write(markup);
    scanner.close(GUEST_BODY_CLOSE);
    return scanner.finish();
  };
  const findings = scan(true);
  if (findings.limit !== undefined || (findings.embed !== undefined && findings.url !== undefined) || !NOSCRIPT_TAG.test(markup)) {
    return findings;
  }
  return mergeFindings(findings, scan(false));
}

type Admission = { fragment: string } | { error: string };

/**
 * The last few verdicts, so the stage, the store and the wrapper reading the
 * same visual check it once. Keyed by the HTML itself; an entry holds the
 * fragment the wrapper renders, or why the visual was refused.
 */
const admissions = new Map<string, Admission>();
const MAX_CACHED_ADMISSIONS = 4;

function admit(html: string): { fragment: string } {
  let admission = admissions.get(html);
  if (admission === undefined) {
    try {
      admission = check(html);
    } catch (error) {
      admission = { error: (error as Error).message };
    }
    if (admissions.size >= MAX_CACHED_ADMISSIONS) admissions.delete(admissions.keys().next().value!);
    admissions.set(html, admission);
  }
  if ("error" in admission) throw new Error(admission.error);
  return admission;
}

function check(html: string): { fragment: string } {
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
  // The wrapper renders the fragment it cuts out of a full document; a
  // streaming draft rendered the visual as written. Both are read where
  // they render, so a <body> inside a comment, a <textarea> or a script
  // string can't hide what the cut-out fragment does.
  const fragment = extractFragment(html);
  let findings = scanGuestBody(fragment);
  if (fragment !== html && findings.limit === undefined && (findings.embed === undefined || findings.url === undefined)) {
    const written = scanGuestBody(html);
    findings = { limit: written.limit, embed: findings.embed ?? written.embed, url: findings.url ?? written.url };
  }
  const { embed, url, limit } = findings;
  if (limit !== undefined) {
    throw new Error(`Artifact HTML is too complex to check: ${limit}. ${limitAdvice(limit)}`);
  }
  if (embed !== undefined) {
    throw new Error(
      `Artifact HTML cannot include iframes, embedded documents, <base>, <link> or external scripts (found ${quoteMatch(embed)}). Use inline JavaScript and CSS; Chart.js, Plotly, and KaTeX are provided by Aiden.`,
    );
  }
  if (url !== undefined) {
    throw new Error(
      `Artifact HTML cannot load remote images or scripts, or use javascript: or data:text/html URLs (found ${quoteMatch(url)}). Draw with inline SVG, CSS or a canvas instead.`,
    );
  }
  return { fragment };
}

export function validateGenerativeUiHtml(html: string): Buffer {
  if (typeof html !== "string" || html.length === 0) {
    throw new Error("render_artifact requires non-empty HTML.");
  }
  admit(html);
  return Buffer.from(html, "utf8");
}

export function requireGenerativeUiTitle(value: unknown): string {
  if (!isHtmlArtifactTitle(value)) {
    throw new Error("render_artifact requires a 1–120 character title without control characters.");
  }
  return value;
}

// The fragment helpers below find tags with plain searches that never rescan
// text: each one picks up where the last stopped, and once no `>` (or no
// closing tag) is left, no later candidate can match either, so they stop.
// The regexes they replaced retried at every `<` and took minutes on
// 512 KiB of `<script ` or `<html `.

/** Where `pattern` (a global regex) next matches at or after `from`, or -1. */
function searchFrom(html: string, pattern: RegExp, from: number): number {
  pattern.lastIndex = from;
  return pattern.exec(html)?.index ?? -1;
}

const HEAD_OPEN = /<head\b/giu;
const HEAD_CLOSE = /<\/head>/giu;
const BODY_OPEN = /<body\b/giu;
const BODY_CLOSE = /<\/body>/giu;

/** The first `<name ...>...</name>` element: its span and its content. */
function firstElement(
  html: string,
  open: RegExp,
  close: RegExp,
  nameLength: number,
): { start: number; end: number; content: string } | undefined {
  const start = searchFrom(html, open, 0);
  if (start < 0) return undefined;
  const contentStart = html.indexOf(">", start + 1 + nameLength) + 1;
  if (contentStart === 0) return undefined;
  const closeAt = searchFrom(html, close, contentStart);
  if (closeAt < 0) return undefined;
  return { start, end: closeAt + nameLength + 3, content: html.slice(contentStart, closeAt) };
}

/** Remove every `<name ...>` and `</name ...>` tag that has its closing `>`. */
function stripTags(html: string, pattern: RegExp): string {
  let out = "";
  let from = 0;
  for (let at = searchFrom(html, pattern, 0); at >= 0; at = searchFrom(html, pattern, from)) {
    const gt = html.indexOf(">", at + 1);
    if (gt < 0) break;
    out += html.slice(from, at);
    from = gt + 1;
  }
  return out + html.slice(from);
}

const INLINE_HEAD_TAG = /<(style|script)\b/giu;
const SRC_ATTRIBUTE = /\bsrc\s*=/giu;
const INLINE_CLOSE: Readonly<Record<string, RegExp>> = { style: /<\/style>/giu, script: /<\/script>/giu };

/** The head's inline `<style>` and `<script>` elements (no `src`), in order. */
function extractHeadInline(html: string): string {
  const head = firstElement(html, HEAD_OPEN, HEAD_CLOSE, 4)?.content;
  if (!head) return "";
  const kept: string[] = [];
  const unclosed = new Set<string>();
  // Candidates before one `>` share it, so the last `src=` before it is
  // found once for all of them.
  let tagEnd = -1;
  let lastSrc = -1;
  let from = 0;
  for (;;) {
    INLINE_HEAD_TAG.lastIndex = from;
    const tag = INLINE_HEAD_TAG.exec(head);
    if (!tag) break;
    const at = tag.index;
    // By length: under `iu`, "ſcript" (long s) also matches.
    const name = tag[1]!.length === 5 ? "style" : "script";
    from = at + 1;
    if (unclosed.has(name)) continue;
    if (at >= tagEnd) {
      tagEnd = head.indexOf(">", at + 1);
      if (tagEnd < 0) break;
      const tagText = head.slice(at, tagEnd);
      lastSrc = -1;
      SRC_ATTRIBUTE.lastIndex = 0;
      for (let src = SRC_ATTRIBUTE.exec(tagText); src; src = SRC_ATTRIBUTE.exec(tagText)) lastSrc = at + src.index;
    }
    if (lastSrc > at + name.length) continue;
    const closeAt = searchFrom(head, INLINE_CLOSE[name]!, tagEnd + 1);
    if (closeAt < 0) {
      unclosed.add(name);
      continue;
    }
    from = closeAt + name.length + 3;
    kept.push(head.slice(at, from));
  }
  return kept.join("\n");
}

function extractFragment(html: string): string {
  const trimmed = html.trim();
  const body = firstElement(trimmed, BODY_OPEN, BODY_CLOSE, 4);
  const headInline = extractHeadInline(trimmed);
  if (body !== undefined) {
    return [headInline, body.content].filter(Boolean).join("\n");
  }
  if (/^\s*<(!doctype|html)\b/iu.test(trimmed)) {
    let stripped = stripTags(trimmed.replace(/^\s*<!doctype[^>]*>/iu, ""), /<\/?html\b/giu);
    const head = firstElement(stripped, HEAD_OPEN, HEAD_CLOSE, 4);
    if (head) stripped = stripped.slice(0, head.start) + stripped.slice(head.end);
    stripped = stripTags(stripped, /<\/?body\b/giu);
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
  if (typeof html !== "string" || html.length === 0) {
    throw new Error("render_artifact requires non-empty HTML.");
  }
  const { fragment } = admit(html);
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

/**
 * Swaps a wrapped guest's `aiden-genui:` library tags for the sources
 * themselves, so it runs with no custom protocol (exports, the phone viewer).
 * Libraries `include` rejects are dropped instead, which keeps a phone document
 * free of the large ones a visual never calls.
 */
export function inlineGenerativeUiHostLibraries(
  guestDocument: string,
  libraries: Readonly<Record<string, string>>,
  include: (name: (typeof GENERATIVE_UI_HOST_LIBS)[number]) => boolean = () => true,
): string {
  let inlined = guestDocument.replace(GENERATIVE_UI_GUEST_CSP, GENERATIVE_UI_EXPORT_CSP);
  for (const name of GENERATIVE_UI_HOST_LIBS) {
    const href = `${GENERATIVE_UI_PROTOCOL_SCHEME}://${name}`;
    const tag = name.endsWith(".css") ? `<link rel="stylesheet" href="${href}">` : `<script src="${href}"></script>`;
    if (!include(name)) {
      inlined = inlined.replace(tag, "");
      continue;
    }
    const source = name === GENERATIVE_UI_KIT_LIB ? generativeUiKitCss() : libraries[name];
    if (!source) {
      throw new Error(`Export is missing host library ${name}.`);
    }
    // A function replacement, so `$&` and friends in library source stay literal.
    inlined = inlined.replace(tag, () => (name.endsWith(".css") ? `<style>\n${source}\n</style>` : `<script>\n${source}\n</script>`));
  }
  return inlined;
}

export function generativeUiExportDocument(
  html: string,
  title: string,
  libraries: Readonly<Record<string, string>>,
  theme?: GenerativeUiThemeTokens,
): string {
  const guestDocument = inlineGenerativeUiHostLibraries(wrapGenerativeUiHtml(html, title, theme), libraries);
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
