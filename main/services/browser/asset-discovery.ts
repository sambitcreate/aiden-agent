import { parse as parseHtml, type DefaultTreeAdapterTypes } from "parse5";
import { parse as parseModule } from "acorn";
import postcss from "postcss";
import valueParser from "postcss-value-parser";

export const BROWSER_DISCOVERY_LIMITS = Object.freeze({ files: 64, sourceBytes: 1024 * 1024, totalSourceBytes: 4 * 1024 * 1024, depth: 8, references: 512, warnings: 20 });
export type BrowserAssetSourceKind = "html" | "css" | "module";
export interface BrowserAssetReferences {
  urls: string[];
  baseHref?: string;
  incomplete: boolean;
}

/** CSS escaping is decoded after tokenization, so escaped delimiters remain data. */
function cssUnescape(value: string): string {
  return value.replace(/\\([0-9a-f]{1,6})(?:\r\n|[\t\n\f\r ])?|\\([^\r\n\f])/gi, (_match, hex: string | undefined, character: string | undefined) => {
    if (!hex) return character ?? "";
    const code = Number.parseInt(hex, 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\uFFFD" : String.fromCodePoint(code);
  });
}

/** Parses references only. No source is evaluated, transformed, or fetched. */
export function browserAssetReferences(source: string, kind: BrowserAssetSourceKind): BrowserAssetReferences {
  const result: BrowserAssetReferences = { urls: [], incomplete: false };
  const seen = new Set<string>();
  const add = (url: string | undefined) => {
    if (!url || seen.has(url)) return;
    if (url.length > 8192 || result.urls.length >= BROWSER_DISCOVERY_LIMITS.references) { result.incomplete = true; return; }
    seen.add(url);
    result.urls.push(url);
  };
  const cssValue = (value: string, isImport = false) => {
    const parsed = valueParser(value);
    if (isImport) {
      const first = parsed.nodes.find(node => node.type !== "space" && node.type !== "comment");
      if (first?.type === "string" && !first.unclosed) add(cssUnescape(first.value));
    }
    parsed.walk(node => {
      if (node.type === "function" && ["image-set", "-webkit-image-set"].includes(cssUnescape(node.value).toLowerCase()))
        for (const child of node.nodes) if (child.type === "string" && !child.unclosed) add(cssUnescape(child.value));
      if (node.type !== "function" || cssUnescape(node.value).toLowerCase() !== "url" || node.unclosed) return;
      const tokens = node.nodes.filter(child => child.type !== "space" && child.type !== "comment");
      if (tokens.length === 1 && (tokens[0]!.type === "word" || tokens[0]!.type === "string")) add(cssUnescape(tokens[0]!.value));
      return false;
    });
  };
  const css = (text: string) => {
    try {
      const root = postcss.parse(text);
      root.walkDecls(declaration => { cssValue(declaration.value); });
      root.walkAtRules(rule => { if (rule.name.toLowerCase() === "import") cssValue(rule.params, true); });
    } catch { result.incomplete = true; }
  };
  const module = (text: string) => {
    try {
      const root = parseModule(text, { ecmaVersion: "latest", sourceType: "module" });
      for (const statement of root.body) {
        if (statement.type !== "ImportDeclaration" && statement.type !== "ExportNamedDeclaration" && statement.type !== "ExportAllDeclaration") continue;
        const imported = statement.source?.value;
        // Bare imports require a resolver/import map. Never invent filesystem authority.
        if (typeof imported === "string" && (imported.startsWith(".") || imported.startsWith("/"))) add(imported);
      }
      const nodes: unknown[] = [root];
      let count = 0;
      while (nodes.length) {
        if (++count > 50_000) { result.incomplete = true; break; }
        const next = nodes.pop();
        if (!next || typeof next !== "object") continue;
        const node = next as Record<string, unknown>;
        if (node.type === "ImportExpression") {
          const imported = node.source as { type?: string; value?: unknown };
          if (imported.type === "Literal" && typeof imported.value === "string" && (imported.value.startsWith(".") || imported.value.startsWith("/"))) add(imported.value);
        }
        for (const value of Object.values(node)) if (Array.isArray(value)) nodes.push(...value); else if (value && typeof value === "object") nodes.push(value);
      }
    } catch { result.incomplete = true; }
  };
  const srcset = (value: string) => {
    let offset = 0;
    while (offset < value.length) {
      while (offset < value.length && /[\t\n\f\r ,]/.test(value[offset]!)) offset++;
      const start = offset;
      while (offset < value.length && !/[\t\n\f\r ]/.test(value[offset]!)) offset++;
      const url = value.slice(start, offset);
      add(url.replace(/,+$/, ""));
      if (url.endsWith(",")) continue;
      let parentheses = 0;
      while (offset < value.length) {
        const character = value[offset++]!;
        if (character === "(") parentheses++;
        else if (character === ")") parentheses = Math.max(0, parentheses - 1);
        else if (character === "," && parentheses === 0) break;
      }
    }
  };
  if (kind === "css") css(source);
  else if (kind === "module") module(source);
  else {
    const document = parseHtml(source);
    const nodes: DefaultTreeAdapterTypes.Node[] = [document];
    let count = 0;
    while (nodes.length) {
      if (++count > 50_000) { result.incomplete = true; break; }
      const node = nodes.pop()!;
      if ("tagName" in node) {
        const attributes = new Map(node.attrs.map(attribute => [attribute.name, attribute.value]));
        const tag = node.tagName;
        if (tag === "base" && result.baseHref === undefined && attributes.has("href")) result.baseHref = attributes.get("href");
        const src = attributes.get("src");
        if (tag === "script" || tag === "img" || tag === "source" || (tag === "input" && attributes.get("type")?.toLowerCase() === "image")) add(src);
        if ((tag === "img" || tag === "source") && attributes.has("srcset")) srcset(attributes.get("srcset")!);
        if (tag === "video") add(attributes.get("poster"));
        if (tag === "link") {
          const rel = new Set((attributes.get("rel") ?? "").toLowerCase().split(/\s+/));
          if (rel.has("stylesheet") || rel.has("icon") || rel.has("modulepreload") || (rel.has("preload") && ["image", "font", "script", "style"].includes(attributes.get("as") ?? ""))) add(attributes.get("href"));
        }
        const inlineText = node.childNodes.filter((child): child is DefaultTreeAdapterTypes.TextNode => child.nodeName === "#text").map(child => child.value).join("");
        if (tag === "style") css(inlineText);
        if (tag === "script" && !src && attributes.get("type")?.toLowerCase() === "module") module(inlineText);
        const style = attributes.get("style");
        if (style) { try { cssValue(style); } catch { result.incomplete = true; } }
      }
      // Templates are inert until page code activates them; dynamic work stays explicit.
      if ("childNodes" in node) nodes.push(...[...node.childNodes].reverse());
    }
  }
  return result;
}
