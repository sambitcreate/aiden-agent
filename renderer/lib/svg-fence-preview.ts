// Decides whether a fenced ```svg block in a chat reply can be shown as a
// drawing, and builds the `data:` URL an <img> draws it from. An <img> runs no
// script and loads nothing else, so the drawing stays inert. This is only a
// cheap shape check: whether the browser can actually decode the SVG is found
// out by the <img> itself (its error event shows a note instead).

/** Larger sources are not offered as drawings, so a huge fence never stalls the chat. */
export const SVG_PREVIEW_MAX_BYTES = 1_048_576;

const DATA_URL_PREFIX = "data:image/svg+xml;charset=utf-8,";
// An optional XML prolog, then any comments, before the root element.
const LEADING_PROLOG = /^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*/u;
const SVG_ROOT_START = /^<svg[\s>/]/u;

export function svgPreviewSource(code: string, lang: string | undefined): string | null {
  if (lang?.toLowerCase() !== "svg") return null;
  // A UTF-16 code unit never encodes to fewer than one UTF-8 byte, so this
  // rejects oversized sources before encoding them.
  if (code.length > SVG_PREVIEW_MAX_BYTES) return null;
  const source = code.trim();
  const body = source.replace(LEADING_PROLOG, "");
  if (!SVG_ROOT_START.test(body) || !body.endsWith("</svg>")) return null;
  if (new TextEncoder().encode(source).length > SVG_PREVIEW_MAX_BYTES) return null;
  return `${DATA_URL_PREFIX}${encodeURIComponent(source)}`;
}
