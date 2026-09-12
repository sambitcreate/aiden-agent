import * as ts from "typescript";
import type { DesignDirectEditSelectionV1, DesignDirectEditV1 } from "./design-direct-edit-core.js";

const CSS_NUMBER = /^(0|(?:[0-9]{1,4}(?:\.[0-9]{1,3})?)(?:px|rem))$/u;
const CSS_SIZE =
  /^(?:auto|0|(?:[0-9]{1,4}(?:\.[0-9]{1,3})?)(?:px|rem)|(?:[0-9]{1,3}(?:\.[0-9]{1,3})?)%)$/u;
const CSS_TOKEN_VALUE = /^var\(--[a-z][a-z0-9-]{0,62}\)$/u;
const ALIGNMENT_VALUES = new Set([
  "start",
  "center",
  "end",
  "stretch",
  "space-between",
  "space-around",
  "left",
  "right",
]);

function exactStableId(selection: DesignDirectEditSelectionV1): string {
  if (!selection.elementId || selection.selector !== `[data-aiden-id="${selection.elementId}"]`) {
    throw new Error("Direct edits require one exact stable data-aiden-id selector.");
  }
  return selection.elementId;
}

function replacementValue(edit: DesignDirectEditV1): string {
  return edit.kind === "color-token"
    ? `var(${edit.token})`
    : edit.kind === "static-text"
      ? edit.text
      : edit.value;
}

function propertyName(edit: Exclude<DesignDirectEditV1, { kind: "static-text" }>): string {
  return edit.property;
}

function isProvenLiteral(
  edit: Exclude<DesignDirectEditV1, { kind: "static-text" }>,
  value: string,
): boolean {
  if (edit.kind === "spacing" || edit.kind === "radius") return CSS_NUMBER.test(value);
  if (edit.kind === "size") return CSS_SIZE.test(value);
  if (edit.kind === "alignment") return ALIGNMENT_VALUES.has(value);
  return CSS_TOKEN_VALUE.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function openingTagAt(
  html: string,
  attributeStart: number,
): { start: number; end: number; raw: string; tagName: string } {
  const start = html.lastIndexOf("<", attributeStart);
  if (start < 0 || html.slice(start, start + 2) === "</") {
    throw new Error("The selected artifact element could not be proven.");
  }
  let quote = "";
  let end = -1;
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index]!;
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      end = index + 1;
      break;
    } else if (character === "<") {
      break;
    }
  }
  if (end < 0) throw new Error("The selected artifact start tag is malformed.");
  const raw = html.slice(start, end);
  const match = /^<\s*([a-z][a-z0-9-]*)\b/iu.exec(raw);
  if (!match) throw new Error("The selected artifact element is not a literal HTML element.");
  return { start, end, raw, tagName: match[1]!.toLowerCase() };
}

function exactHtmlTarget(html: string, selection: DesignDirectEditSelectionV1) {
  const elementId = exactStableId(selection);
  const expression = new RegExp(
    `\\sdata-aiden-id\\s*=\\s*(["'])${escapeRegExp(elementId)}\\1`,
    "gu",
  );
  const matches = [...html.matchAll(expression)];
  if (matches.length !== 1 || matches[0]?.index === undefined) {
    throw new Error("The stable selector is missing or ambiguous in this artifact revision.");
  }
  const tag = openingTagAt(html, matches[0].index);
  if (
    tag.tagName !== selection.tagName ||
    matches[0].index >= tag.end ||
    [...tag.raw.matchAll(/\sdata-aiden-id\s*=/giu)].length !== 1
  ) {
    throw new Error("The selected artifact tag no longer matches its stable selector.");
  }
  return tag;
}

function replaceHtmlStyle(
  html: string,
  tag: ReturnType<typeof exactHtmlTarget>,
  edit: Exclude<DesignDirectEditV1, { kind: "static-text" }>,
): string {
  const styles = [...tag.raw.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/giu)];
  if (styles.length !== 1 || styles[0]?.index === undefined) {
    throw new Error("The selected element does not have one literal inline style definition.");
  }
  const style = styles[0];
  const value = style[2]!;
  if (/[{}]|\/\*/u.test(value)) {
    throw new Error("Dynamic or structured style definitions cannot be edited directly.");
  }
  const wanted = propertyName(edit);
  const declarations: Array<{ start: number; end: number; value: string }> = [];
  let offset = 0;
  for (const segment of value.split(";")) {
    const colon = segment.indexOf(":");
    if (colon >= 0) {
      const name = segment.slice(0, colon).trim().toLowerCase();
      const current = segment.slice(colon + 1).trim();
      if (name === wanted) {
        const leading = segment.slice(colon + 1).search(/\S/u);
        const trailing = segment.slice(colon + 1).match(/\s*$/u)?.[0].length ?? 0;
        declarations.push({
          start: offset + colon + 1 + leading,
          end: offset + segment.length - trailing,
          value: current,
        });
      }
    }
    offset += segment.length + 1;
  }
  if (declarations.length !== 1 || !isProvenLiteral(edit, declarations[0]!.value)) {
    throw new Error("The style property is missing, repeated, shared, or dynamic.");
  }
  const styleValueStart = tag.start + style.index + style[0].indexOf(value);
  const definition = declarations[0]!;
  return (
    html.slice(0, styleValueStart + definition.start) +
    replacementValue(edit) +
    html.slice(styleValueStart + definition.end)
  );
}

function replaceHtmlText(
  html: string,
  tag: ReturnType<typeof exactHtmlTarget>,
  text: string,
): string {
  if (/\/\s*>$/u.test(tag.raw)) throw new Error("A self-closing element has no static text.");
  const close = new RegExp(`^([\\s\\S]*?)<\\/\\s*${escapeRegExp(tag.tagName)}\\s*>`, "iu").exec(
    html.slice(tag.end),
  );
  if (!close || /[<>&]/u.test(close[1]!)) {
    throw new Error("Only one literal, non-rich text node can be edited directly.");
  }
  const end = tag.end + close[1]!.length;
  return html.slice(0, tag.end) + text.replace(/&/gu, "&amp;") + html.slice(end);
}

export function transformPrototypeDirectEdit(input: {
  html: string;
  selection: DesignDirectEditSelectionV1;
  edit: DesignDirectEditV1;
}): string {
  const tag = exactHtmlTarget(input.html, input.selection);
  return input.edit.kind === "static-text"
    ? replaceHtmlText(input.html, tag, input.edit.text)
    : replaceHtmlStyle(input.html, tag, input.edit);
}

function jsxTagName(node: ts.JsxElement | ts.JsxSelfClosingElement): string | undefined {
  const name = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return ts.isIdentifier(name) && /^[a-z][a-z0-9-]*$/u.test(name.text) ? name.text : undefined;
}

function jsxAttributes(node: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttributes {
  return ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
}

function literalJsxAttribute(attribute: ts.JsxAttribute): string | undefined {
  return attribute.initializer && ts.isStringLiteral(attribute.initializer)
    ? attribute.initializer.text
    : undefined;
}

function camelCaseProperty(property: string): string {
  return property.replace(/-([a-z])/gu, (_, character: string) => character.toUpperCase());
}

export function transformConnectedDirectEdit(input: {
  source: string;
  start: number;
  end: number;
  selection: DesignDirectEditSelectionV1;
  edit: DesignDirectEditV1;
}): string {
  const elementId = exactStableId(input.selection);
  const file = ts.createSourceFile(
    "direct-edit.tsx",
    input.source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics && diagnostics.length > 0)
    throw new Error("The connected source is not valid TSX.");
  const matches: Array<ts.JsxElement | ts.JsxSelfClosingElement> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const ids = jsxAttributes(node).properties.filter(
        (property): property is ts.JsxAttribute =>
          ts.isJsxAttribute(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === "data-aiden-id",
      );
      if (ids.length === 1 && literalJsxAttribute(ids[0]!) === elementId) matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (matches.length !== 1) {
    throw new Error("The connected stable selector is missing, duplicated, or dynamic.");
  }
  const node = matches[0]!;
  if (
    node.getStart(file) !== input.start ||
    node.getEnd() !== input.end ||
    jsxTagName(node) !== input.selection.tagName
  ) {
    throw new Error(
      "The connected source binding no longer identifies the exact selected element.",
    );
  }
  if (input.edit.kind === "static-text") {
    if (!ts.isJsxElement(node) || node.children.length !== 1 || !ts.isJsxText(node.children[0]!)) {
      throw new Error("Only one literal, non-rich JSX text node can be edited directly.");
    }
    const child = node.children[0]!;
    return (
      input.source.slice(input.start, child.getStart(file)) +
      input.edit.text.replace(/&/gu, "&amp;") +
      input.source.slice(child.getEnd(), input.end)
    );
  }
  const styleAttributes = jsxAttributes(node).properties.filter(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === "style",
  );
  if (styleAttributes.length !== 1) {
    throw new Error("The selected JSX element does not have one literal inline style object.");
  }
  const initializer = styleAttributes[0]!.initializer;
  const expression =
    initializer && ts.isJsxExpression(initializer) ? initializer.expression : undefined;
  if (!expression || !ts.isObjectLiteralExpression(expression)) {
    throw new Error("Computed, spread, or shared JSX styles cannot be edited directly.");
  }
  if (expression.properties.some((property) => !ts.isPropertyAssignment(property))) {
    throw new Error("Computed, spread, or shared JSX styles cannot be edited directly.");
  }
  const wanted = camelCaseProperty(propertyName(input.edit));
  const definitions = expression.properties.filter(
    (property): property is ts.PropertyAssignment => {
      if (!ts.isPropertyAssignment(property)) return false;
      return (
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === wanted
      );
    },
  );
  if (definitions.length !== 1) {
    throw new Error("The JSX style property is missing, repeated, shared, or dynamic.");
  }
  const definition = definitions[0]!;
  const current =
    ts.isStringLiteral(definition.initializer) ||
    ts.isNoSubstitutionTemplateLiteral(definition.initializer)
      ? definition.initializer.text
      : undefined;
  if (current === undefined || !isProvenLiteral(input.edit, current)) {
    throw new Error("The JSX style value is dynamic or outside the direct-edit matrix.");
  }
  const replacement = JSON.stringify(replacementValue(input.edit));
  return (
    input.source.slice(input.start, definition.initializer.getStart(file)) +
    replacement +
    input.source.slice(definition.initializer.getEnd(), input.end)
  );
}
