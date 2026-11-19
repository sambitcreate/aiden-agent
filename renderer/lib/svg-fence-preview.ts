// Decides whether a fenced ```svg block in a chat reply can be shown as a
// drawing, and builds the `data:` URL an <img> draws it from (adding the SVG
// namespace when the root leaves it out). An <img> runs no
// script and loads nothing else, so the drawing stays inert. This is only a
// cheap shape check: whether the browser can actually decode the SVG is found
// out by the <img> itself (its error event shows a note instead).

/** Larger sources are not offered as drawings, so a huge fence never stalls the chat. */
export const SVG_PREVIEW_MAX_BYTES = 1_048_576;

const DATA_URL_PREFIX = "data:image/svg+xml;charset=utf-8,";
// An optional XML declaration, comments, and an optional doctype (with or
// without an internal subset, as Illustrator and Inkscape export) before the
// root element.
const COMMENTS = String.raw`(?:<!--[\s\S]*?-->\s*)*`;
const LEADING_PROLOG = new RegExp(
  String.raw`^(?:<\?xml[\s\S]*?\?>\s*)?` +
    COMMENTS +
    String.raw`(?:<!DOCTYPE[^>\[]*(?:\[[\s\S]*?\])?\s*>\s*)?` +
    COMMENTS,
  "u",
);
const SVG_ROOT_START = /^<svg[\s>/]/u;
// The root start tag, allowing ">" inside quoted attribute values.
const ROOT_START_TAG = /^<svg(?:"[^"]*"|'[^']*'|[^'">])*>/u;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export function svgPreviewSource(code: string, lang: string | undefined): string | null {
  if (lang?.toLowerCase() !== "svg") return null;
  // A UTF-16 code unit never encodes to fewer than one UTF-8 byte, so this
  // rejects oversized sources before encoding them.
  if (code.length > SVG_PREVIEW_MAX_BYTES) return null;
  // The cap counts the fence as written, surrounding whitespace included, as
  // the iPhone's View does, so both offer a drawing for the same sources.
  if (new TextEncoder().encode(code).length > SVG_PREVIEW_MAX_BYTES) return null;
  const source = code.trim();
  const body = source.replace(LEADING_PROLOG, "");
  if (!SVG_ROOT_START.test(body) || !body.endsWith("</svg>")) return null;
  return `${DATA_URL_PREFIX}${encodeURIComponent(withSvgNamespace(source, body))}`;
}

// Browsers decode an SVG image only in the SVG namespace, and agent-written SVG
// often leaves it out. Add it when the root start tag names no default
// namespace at all; an explicit one (even xmlns="") is left for the browser.
function withSvgNamespace(source: string, body: string): string {
  const startTag = ROOT_START_TAG.exec(body)?.[0] ?? "";
  const unquoted = startTag.replace(/"[^"]*"|'[^']*'/gu, "");
  if (/\sxmlns\s*=/u.test(unquoted)) return source;
  const rootAt = source.length - body.length + "<svg".length;
  return `${source.slice(0, rootAt)} xmlns="${SVG_NAMESPACE}"${source.slice(rootAt)}`;
}
