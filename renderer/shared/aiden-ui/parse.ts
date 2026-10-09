import type { AidenUiDiagnostic } from "./types.js";

/**
 * Tolerant parser for Aiden UI Markup (AUM): JSX-like elements, quoted or
 * `{expression}` attribute values, `{expression}` children, and raw `<Data>`
 * bodies. It never throws. A stream cut auto-closes open elements, drops an
 * unfinished tag or attribute, and keeps text, so every prefix of a valid
 * document yields a usable (shorter) tree.
 */

export interface AumAttr {
  name: string;
  value: { kind: "string"; text: string } | { kind: "expr"; source: string } | { kind: "bare" };
}

export interface AumElement {
  kind: "element";
  name: string;
  attrs: AumAttr[];
  children: AumNode[];
  /** False when the element was still open at the end of the input. */
  closed: boolean;
}

export type AumNode = AumElement | { kind: "text"; text: string } | { kind: "expr"; source: string };

const NAME_START = /[A-Za-z]/u;
const NAME_CHAR = /[A-Za-z0-9_.-]/u;
const RAW_TEXT_ELEMENTS = new Set(["Data"]);

interface Frame {
  element: AumElement | null;
  children: AumNode[];
}

export function parseAum(markup: string): { nodes: AumNode[]; diagnostics: AidenUiDiagnostic[] } {
  const diagnostics: AidenUiDiagnostic[] = [];
  const root: Frame = { element: null, children: [] };
  const stack: Frame[] = [root];
  let index = 0;
  let text = "";

  const top = () => stack[stack.length - 1]!;
  const flushText = () => {
    if (text.length > 0) top().children.push({ kind: "text", text });
    text = "";
  };
  const recovered = (message: string, at?: string) => {
    diagnostics.push({ code: "recovered", message, ...(at ? { at } : {}) });
  };

  /** Reads `{…}` starting at `start` (the `{`); returns the inner source and end, or null at EOF. */
  const readBraced = (start: number): { source: string; end: number } | null => {
    let depth = 0;
    let quote: string | null = null;
    for (let cursor = start; cursor < markup.length; cursor += 1) {
      const char = markup[cursor]!;
      if (quote) {
        if (char === "\\") cursor += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return { source: markup.slice(start + 1, cursor), end: cursor + 1 };
      }
    }
    return null;
  };

  const readName = (start: number): { name: string; end: number } => {
    let end = start;
    while (end < markup.length && NAME_CHAR.test(markup[end]!)) end += 1;
    return { name: markup.slice(start, end), end };
  };

  const skipSpace = (start: number): number => {
    let cursor = start;
    while (cursor < markup.length && /\s/u.test(markup[cursor]!)) cursor += 1;
    return cursor;
  };

  /** Parses an open tag at `start` (the `<`). Returns null when the input ends before the name is known. */
  const readOpenTag = (start: number): { element: AumElement; end: number; selfClosing: boolean } | null => {
    const { name, end: nameEnd } = readName(start + 1);
    // A name running into EOF may still be growing (`<Sta` → `<Stat`).
    if (nameEnd >= markup.length) return null;
    const element: AumElement = { kind: "element", name, attrs: [], children: [], closed: false };
    let cursor = nameEnd;
    while (true) {
      cursor = skipSpace(cursor);
      if (cursor >= markup.length) return { element, end: cursor, selfClosing: false };
      const char = markup[cursor]!;
      if (char === ">") return { element, end: cursor + 1, selfClosing: false };
      if (char === "/" && markup[cursor + 1] === ">") return { element, end: cursor + 2, selfClosing: true };
      if (char === "/" && cursor + 1 >= markup.length) return { element, end: cursor + 1, selfClosing: false };
      if (!NAME_START.test(char)) {
        recovered(`Unexpected "${char}" in <${name}>`, name);
        cursor += 1;
        continue;
      }
      const attr = readName(cursor);
      cursor = skipSpace(attr.end);
      if (attr.end >= markup.length) return { element, end: markup.length, selfClosing: false };
      if (markup[cursor] !== "=") {
        element.attrs.push({ name: attr.name, value: { kind: "bare" } });
        continue;
      }
      cursor = skipSpace(cursor + 1);
      const opener = markup[cursor];
      if (opener === '"' || opener === "'") {
        const close = markup.indexOf(opener, cursor + 1);
        if (close < 0) {
          recovered(`Unterminated value for ${attr.name}`, name);
          return { element, end: markup.length, selfClosing: false };
        }
        element.attrs.push({ name: attr.name, value: { kind: "string", text: markup.slice(cursor + 1, close) } });
        cursor = close + 1;
      } else if (opener === "{") {
        const braced = readBraced(cursor);
        if (!braced) {
          recovered(`Unterminated expression for ${attr.name}`, name);
          return { element, end: markup.length, selfClosing: false };
        }
        element.attrs.push({ name: attr.name, value: { kind: "expr", source: braced.source.trim() } });
        cursor = braced.end;
      } else if (opener === undefined) {
        return { element, end: markup.length, selfClosing: false };
      } else {
        recovered(`Unquoted value for ${attr.name}`, name);
        const valueEnd = readName(cursor).end;
        element.attrs.push({ name: attr.name, value: { kind: "string", text: markup.slice(cursor, valueEnd) } });
        cursor = Math.max(valueEnd, cursor + 1);
      }
    }
  };

  const closeTo = (name: string): boolean => {
    for (let depth = stack.length - 1; depth > 0; depth -= 1) {
      if (stack[depth]!.element?.name !== name) continue;
      // Elements opened inside the match close with it (a missing closer).
      while (stack.length > depth) stack.pop()!.element!.closed = true;
      return true;
    }
    return false;
  };

  while (index < markup.length) {
    const char = markup[index]!;
    if (char === "<") {
      if (markup.startsWith("<!--", index)) {
        const end = markup.indexOf("-->", index + 4);
        flushText();
        index = end < 0 ? markup.length : end + 3;
        continue;
      }
      if (markup[index + 1] === "/") {
        const { name, end } = readName(index + 2);
        const gt = markup.indexOf(">", end);
        flushText();
        if (gt < 0) {
          index = markup.length;
          continue;
        }
        if (!closeTo(name)) recovered(`Stray </${name}>`, name);
        index = gt + 1;
        continue;
      }
      if (index + 1 < markup.length && NAME_START.test(markup[index + 1]!)) {
        flushText();
        const tag = readOpenTag(index);
        if (!tag) {
          index = markup.length;
          continue;
        }
        const parent = top();
        parent.children.push(tag.element);
        index = tag.end;
        if (tag.selfClosing) {
          tag.element.closed = true;
          continue;
        }
        if (index >= markup.length) continue;
        if (RAW_TEXT_ELEMENTS.has(tag.element.name)) {
          const closer = `</${tag.element.name}>`;
          const end = markup.indexOf(closer, index);
          const body = markup.slice(index, end < 0 ? markup.length : end);
          if (body.trim()) tag.element.children.push({ kind: "text", text: body.trim() });
          tag.element.closed = end >= 0;
          index = end < 0 ? markup.length : end + closer.length;
          continue;
        }
        stack.push({ element: tag.element, children: tag.element.children });
        continue;
      }
      if (index + 1 >= markup.length) {
        index += 1;
        continue;
      }
      text += char;
      index += 1;
      continue;
    }
    if (char === "{") {
      flushText();
      const braced = readBraced(index);
      if (!braced) {
        recovered("Unterminated expression");
        index = markup.length;
        continue;
      }
      if (braced.source.trim()) top().children.push({ kind: "expr", source: braced.source.trim() });
      index = braced.end;
      continue;
    }
    text += char;
    index += 1;
  }
  flushText();
  if (stack.length > 1) {
    recovered(`Auto-closed ${stack.length - 1} open element(s)`);
    stack.length = 1;
  }
  return { nodes: root.children, diagnostics };
}
