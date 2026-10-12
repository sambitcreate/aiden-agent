import { AIDEN_UI_CATALOG, isAidenUiIcon, PRESERVE_WHITESPACE, type CatalogEntry, type PropKind } from "./catalog.js";
import { parseExpression } from "./expression.js";
import { fallbackTextFor } from "./fallback-text.js";
import { parseAum, type AumAttr, type AumElement, type AumNode } from "./parse.js";
import {
  AIDEN_UI_LIMITS,
  type AidenUiDiagnostic,
  type AidenUiNodeV1,
  type AidenUiPropValueV1,
} from "./types.js";
import { isWireSafeKey } from "./visual.js";

/**
 * Compiles AUM markup into a normalized, validated, size-capped tree. Bad
 * input is never fatal: unknown elements are dropped but their content kept,
 * bad props are dropped, and every repair is reported as a diagnostic that
 * goes back to the model.
 */

export interface CompiledAum {
  tree?: AidenUiNodeV1;
  dataJson?: string;
  state?: Record<string, unknown>;
  title?: string;
  diagnostics: AidenUiDiagnostic[];
  fallbackText: string;
}

/** Elements that may sit inside text-only components (`<Text>Press <Kbd>⌘</Kbd></Text>`). */
const INLINE_ELEMENTS = new Set(["Kbd", "Badge", "Icon", "Math"]);
const EVENT_OR_STYLE_PROP = /^(on[A-Z]|className$|style$|class$)/u;
const RESERVED_DATA_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const MAX_TEXT_CHARS = 8000;

interface Context {
  diagnostics: AidenUiDiagnostic[];
  draft: boolean;
  nodes: number;
  limitReported: boolean;
  data: Record<string, unknown>;
  stateKeys: Set<string>;
  /** Unknown tag names already reported, so one repeated tag is one diagnostic. */
  unknownReported: Set<string>;
}

function report(context: Context, diagnostic: AidenUiDiagnostic): void {
  if (context.diagnostics.length < 200) context.diagnostics.push(diagnostic);
}

function reportLimit(context: Context, message: string): void {
  if (context.limitReported) return;
  context.limitReported = true;
  // Always recorded, even past the diagnostic cap: it explains a cut visual.
  context.diagnostics.push({ code: "limit", message });
}

function keysAreWireSafe(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(keysAreWireSafe);
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(([key, inner]) => isWireSafeKey(key) && keysAreWireSafe(inner));
}

function collapseText(text: string): string {
  return text.replace(/\s+/gu, " ");
}

function compileProp(
  element: string,
  attr: AumAttr,
  kind: PropKind,
  context: Context,
): AidenUiPropValueV1 | undefined {
  const invalid = (message: string) => {
    report(context, { code: "invalid_literal", message: `${element}.${attr.name}: ${message}`, at: element });
    return undefined;
  };
  const { value } = attr;
  if (kind === "action") {
    if (value.kind !== "expr") return invalid('actions are written as {sendPrompt("…")}, {setState("key", value)}, {openUrl("https://…")} or {copy(…)}');
    const parsed = parseExpression(value.source);
    if (!parsed.action) {
      report(context, {
        code: "invalid_expression",
        message: `${element}.${attr.name}: ${parsed.error ?? "expected an action"}`,
        at: element,
      });
      return undefined;
    }
    const action = parsed.action;
    if (action.act === "open" && action.url.op === "lit" && !(typeof action.url.v === "string" && action.url.v.startsWith("https://"))) {
      return invalid("openUrl only accepts https:// links");
    }
    if (action.act === "set" && !context.stateKeys.has(action.key)) {
      return invalid(`setState("${action.key}") needs "${action.key}" declared in <Visual state={{…}}>`);
    }
    return action;
  }
  if (kind === "stateKey") {
    if (value.kind !== "string") return invalid('bind takes a state key name, like bind="tab"');
    if (!context.stateKeys.has(value.text)) {
      return invalid(`bind="${value.text}" needs "${value.text}" declared in <Visual state={{…}}>`);
    }
    return { op: "lit", v: value.text };
  }
  if (value.kind === "bare") {
    if (kind === "boolean") return { op: "lit", v: true };
    return invalid("needs a value");
  }
  if (value.kind === "string") {
    if (kind === "number") {
      const number = Number(value.text);
      return value.text.trim() !== "" && Number.isFinite(number) ? { op: "lit", v: number } : invalid(`"${value.text}" is not a number`);
    }
    if (kind === "boolean") {
      if (value.text === "true" || value.text === "false") return { op: "lit", v: value.text === "true" };
      return invalid(`"${value.text}" is not true or false`);
    }
    if (kind === "icon") {
      return isAidenUiIcon(value.text) ? { op: "lit", v: value.text } : invalid(`unknown icon "${value.text}"`);
    }
    if (typeof kind === "object" && !kind.enum.includes(value.text)) {
      return invalid(`"${value.text}" is not one of ${kind.enum.join(", ")}`);
    }
    return { op: "lit", v: value.text };
  }
  const parsed = parseExpression(value.source);
  if (parsed.action) return invalid("an action is only allowed in action props");
  if (!parsed.expr) {
    report(context, {
      code: "invalid_expression",
      message: `${element}.${attr.name}: ${parsed.error ?? "invalid expression"}`,
      at: element,
    });
    return undefined;
  }
  const expr = parsed.expr;
  if (expr.op === "json" && !keysAreWireSafe(expr.v)) return invalid("uses a reserved key name");
  if (expr.op === "lit") {
    if (kind === "number" && typeof expr.v !== "number") return invalid("expected a number");
    if (kind === "boolean" && typeof expr.v !== "boolean") return invalid("expected true or false");
    if (kind === "icon" && !isAidenUiIcon(expr.v)) return invalid(`unknown icon "${String(expr.v)}"`);
    if (typeof kind === "object" && !(typeof expr.v === "string" && kind.enum.includes(expr.v))) {
      return invalid(`${JSON.stringify(expr.v)} is not one of ${kind.enum.join(", ")}`);
    }
  }
  return expr;
}

function compileProps(element: AumElement, entry: CatalogEntry, context: Context): Record<string, AidenUiPropValueV1> | undefined {
  const props: Record<string, AidenUiPropValueV1> = {};
  for (const attr of element.attrs) {
    const kind = entry.props[attr.name];
    if (!kind) {
      const hint = EVENT_OR_STYLE_PROP.test(attr.name) ? " (use catalog props and actions; styling and handlers are not supported)" : "";
      report(context, { code: "unknown_prop", message: `${element.name}.${attr.name} is not a known prop${hint}`, at: element.name });
      continue;
    }
    if (element.name === "Visual" && attr.name === "state") continue;
    const value = compileProp(element.name, attr, kind, context);
    if (value) props[attr.name] = value;
  }
  if (!context.draft && entry.required) {
    for (const name of entry.required) {
      if (!(name in props)) {
        report(context, { code: "invalid_literal", message: `${element.name} needs the ${name} prop`, at: element.name });
      }
    }
  }
  return Object.keys(props).length ? props : undefined;
}

function readState(visual: AumElement, context: Context): Record<string, unknown> | undefined {
  const attr = visual.attrs.find((candidate) => candidate.name === "state");
  if (!attr) return undefined;
  const parsed = attr.value.kind === "expr" ? parseExpression(attr.value.source) : undefined;
  const state = parsed?.expr?.op === "json" ? parsed.expr.v : undefined;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    report(context, { code: "invalid_literal", message: "Visual.state must be a constant object like state={{tab: \"a\"}}", at: "Visual" });
    return undefined;
  }
  if (!keysAreWireSafe(state) || new TextEncoder().encode(JSON.stringify(state)).length > AIDEN_UI_LIMITS.stateBytes) {
    report(context, { code: "invalid_literal", message: "Visual.state is too large or uses a reserved key name", at: "Visual" });
    return undefined;
  }
  for (const key of Object.keys(state)) context.stateKeys.add(key);
  return state as Record<string, unknown>;
}

function textOf(nodes: readonly AumNode[]): string {
  return nodes.map((node) => (node.kind === "text" ? node.text : node.kind === "element" ? textOf(node.children) : "")).join("");
}

function collectData(element: AumElement, context: Context): void {
  const nameAttr = element.attrs.find((attr) => attr.name === "name");
  const name = nameAttr?.value.kind === "string" ? nameAttr.value.text : undefined;
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || RESERVED_DATA_NAMES.has(name)) {
    report(context, { code: "data_invalid", message: 'Data needs a name like <Data name="data">', at: "Data" });
    return;
  }
  const body = textOf(element.children).trim();
  try {
    context.data[name] = JSON.parse(body);
  } catch {
    context.data[name] = null;
    if (!context.draft || element.closed) {
      report(context, { code: "data_invalid", message: `Data "${name}" is not valid JSON`, at: "Data" });
    }
  }
}

/** Compiles `nodes` into children of a parent that accepts `policy`. */
function compileChildren(
  nodes: readonly AumNode[],
  policy: CatalogEntry["children"],
  parent: string,
  depth: number,
  context: Context,
): AidenUiNodeV1[] {
  const children: AidenUiNodeV1[] = [];
  const preserve = PRESERVE_WHITESPACE.has(parent);
  const push = (node: AidenUiNodeV1) => {
    if (depth > AIDEN_UI_LIMITS.depth) {
      reportLimit(context, `Visuals nest at most ${AIDEN_UI_LIMITS.depth} levels deep; deeper content was dropped`);
      return;
    }
    if (context.nodes >= AIDEN_UI_LIMITS.nodes) {
      reportLimit(context, `Visuals hold at most ${AIDEN_UI_LIMITS.nodes} components; the rest were dropped`);
      return;
    }
    context.nodes += 1;
    children.push(node);
  };
  /** Text and `{expr}` children go in directly, or wrapped in Text under a layout parent. */
  const pushInline = (node: AidenUiNodeV1) => {
    if (policy === "none") {
      report(context, { code: "bad_child", message: `${parent} does not take content`, at: parent });
      return;
    }
    if (policy === "text") {
      push(node);
      return;
    }
    if (depth + 1 > AIDEN_UI_LIMITS.depth || context.nodes + 2 > AIDEN_UI_LIMITS.nodes) {
      push(node);
      return;
    }
    context.nodes += 1;
    children.push({ t: "Text", k: "", c: [node] });
    context.nodes += 1;
  };
  for (const node of nodes) {
    if (node.kind === "text") {
      const text = (preserve ? node.text : collapseText(node.text)).slice(0, MAX_TEXT_CHARS);
      if (!text.trim()) continue;
      pushInline({ t: "#text", k: "", s: text });
      continue;
    }
    if (node.kind === "expr") {
      const parsed = parseExpression(node.source);
      if (!parsed.expr) {
        report(context, {
          code: "invalid_expression",
          message: `{${node.source.slice(0, 60)}}: ${parsed.error ?? "expected an expression"}`,
          at: parent,
        });
        continue;
      }
      pushInline({ t: "#expr", k: "", e: parsed.expr });
      continue;
    }
    if (node.name === "Data") {
      collectData(node, context);
      continue;
    }
    const entry = AIDEN_UI_CATALOG[node.name];
    if (!entry || node.name === "Visual") {
      // Unknown element: drop it but keep what it contained.
      if (!context.unknownReported.has(node.name)) {
        context.unknownReported.add(node.name);
        report(context, {
          code: "unknown_element",
          message: `<${node.name}> is not a catalog component; its content was kept`,
          at: node.name,
        });
      }
      // Flattened content still counts toward the depth cap.
      children.push(...compileChildren(node.children, policy, parent, depth + 1, context));
      continue;
    }
    if (policy === "none" || (policy === "text" && !INLINE_ELEMENTS.has(node.name))) {
      report(context, { code: "bad_child", message: `<${node.name}> cannot go inside ${parent}`, at: node.name });
      if (policy === "text") children.push(...compileChildren(node.children, policy, parent, depth + 1, context));
      continue;
    }
    const props = compileProps(node, entry, context);
    const compiled: AidenUiNodeV1 = { t: node.name, k: "", ...(props ? { p: props } : {}) };
    const before = children.length;
    push(compiled);
    if (children.length === before) continue;
    const grandchildren = compileChildren(node.children, entry.children, node.name, depth + 1, context);
    if (grandchildren.length) compiled.c = grandchildren;
  }
  return children;
}

function assignKeys(node: AidenUiNodeV1, key: string): void {
  node.k = key;
  node.c?.forEach((child, index) => assignKeys(child, `${key}.${index}`));
}

/** Never throws: anything unexpected becomes a limit diagnostic and no tree. */
export function compileAum(markup: string, options: { draft?: boolean } = {}): CompiledAum {
  try {
    return compileUnchecked(markup, options);
  } catch {
    return {
      diagnostics: [{ code: "limit", message: "This markup is too deeply nested or too large to compile; simplify it" }],
      fallbackText: "",
    };
  }
}

function compileUnchecked(markup: string, options: { draft?: boolean }): CompiledAum {
  const parsed = parseAum(markup);
  const context: Context = {
    diagnostics: options.draft ? [] : [...parsed.diagnostics],
    draft: Boolean(options.draft),
    nodes: 0,
    limitReported: false,
    data: {},
    stateKeys: new Set(),
    unknownReported: new Set(),
  };
  const meaningful = parsed.nodes.filter((node) => node.kind !== "text" || node.text.trim());
  const rootElement =
    meaningful.length === 1 && meaningful[0]!.kind === "element" && meaningful[0]!.name === "Visual"
      ? meaningful[0]!
      : undefined;
  if (!rootElement && meaningful.length > 0 && !options.draft) {
    report(context, { code: "recovered", message: "The markup was wrapped in <Visual>; start visuals with <Visual title=\"…\">" });
  }
  const state = rootElement ? readState(rootElement, context) : undefined;
  const rootProps = rootElement ? compileProps(rootElement, AIDEN_UI_CATALOG.Visual!, context) : undefined;
  context.nodes = 1;
  const children = compileChildren(rootElement ? rootElement.children : parsed.nodes, "nodes", "Visual", 1, context);
  const titleProp = rootProps?.title;
  const title = titleProp && "op" in titleProp && titleProp.op === "lit" && typeof titleProp.v === "string" ? titleProp.v : undefined;

  let dataJson: string | undefined;
  if (Object.keys(context.data).length > 0) {
    const serialized = JSON.stringify(context.data);
    if (new TextEncoder().encode(serialized).length > AIDEN_UI_LIMITS.dataBytes) {
      report(context, { code: "limit", message: `Data is limited to ${AIDEN_UI_LIMITS.dataBytes / 1024} KiB per visual; it was dropped` });
    } else {
      dataJson = serialized;
    }
  }
  if (children.length === 0) {
    return { diagnostics: context.diagnostics, fallbackText: "", ...(title ? { title } : {}) };
  }
  const tree: AidenUiNodeV1 = { t: "Visual", k: "0", ...(rootProps ? { p: rootProps } : {}), c: children };
  assignKeys(tree, "0");
  if (new TextEncoder().encode(JSON.stringify(tree)).length > AIDEN_UI_LIMITS.treeBytes) {
    report(context, { code: "limit", message: `The visual exceeds ${AIDEN_UI_LIMITS.treeBytes / 1024} KiB; simplify it or move rows into <Data>` });
    return { diagnostics: context.diagnostics, fallbackText: "", ...(title ? { title } : {}) };
  }
  const vars: Record<string, unknown> = { ...(dataJson ? (JSON.parse(dataJson) as Record<string, unknown>) : {}), ...(state ?? {}) };
  return {
    tree,
    ...(dataJson ? { dataJson } : {}),
    ...(state ? { state } : {}),
    ...(title ? { title } : {}),
    diagnostics: context.diagnostics,
    fallbackText: fallbackTextFor(tree, { vars }),
  };
}

