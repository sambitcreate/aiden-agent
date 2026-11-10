import { AIDEN_UI_CATALOG, isAidenUiIcon, type CatalogEntry, type PropKind } from "./catalog.js";
import { INLINE_ELEMENTS, MAX_RUN_ARGUMENTS, MAX_TEXT_CHARS, RESERVED_DATA_NAMES, RUN_ACTION_NAME } from "./compile.js";
import { AIDEN_UI_BINARY_OPERATORS, AIDEN_UI_FUNCTIONS, AIDEN_UI_NAME } from "./expression.js";
import { hasOwn, ownEntry } from "./own.js";
import {
  AIDEN_UI_LIMITS,
  type AidenUiActionV1,
  type AidenUiExprV1,
  type AidenUiNodeV1,
  type AidenUiPropValueV1,
} from "./types.js";
import { isWireSafeKey, parseAidenUiState } from "./visual.js";

/**
 * Checks an already-compiled page from outside Aiden (an imported file)
 * against everything `compileAum` enforces when it builds one: catalog
 * components with their own props, each prop's kind, required props, the
 * children each component takes, the expression grammar, actions (https-only
 * literal links, declared state keys, run names and value counts) and the
 * `<Data>` bindings. Unlike the compiler it repairs nothing: the first
 * problem refuses the page. The result is rebuilt from known keys only.
 */

export interface ValidateCompiledAumOptions {
  /** Accept compose() and run(), as workspace artifacts do. */
  artifactActions?: boolean;
}

export interface CompiledAumParts {
  tree: unknown;
  dataJson?: unknown;
  state?: unknown;
}

export type ValidatedCompiledAum =
  | { ok: true; tree: AidenUiNodeV1; dataJson?: string; state?: Record<string, unknown> }
  | { ok: false; error: string };

class Invalid extends Error {}

function fail(message: string): never {
  throw new Invalid(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A name from the page, shown only when it reads as one. */
function shown(name: unknown): string {
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,39}$/u.test(name) ? `<${name}>` : "a component";
}

function keysAreWireSafe(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (Array.isArray(value)) return value.every((item) => keysAreWireSafe(item, depth + 1));
  if (!isRecord(value)) return true;
  return Object.entries(value).every(([key, inner]) => isWireSafeKey(key) && keysAreWireSafe(inner, depth + 1));
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (isRecord(value)) return Object.values(value).every((item) => isJsonValue(item, depth + 1));
  return false;
}

interface Walk {
  stateKeys: ReadonlySet<string>;
  artifactActions: boolean;
  nodes: number;
}

function expression(value: unknown, depth: number): AidenUiExprV1 {
  if (depth > 1_000) fail("an expression is nested too deeply.");
  if (!isRecord(value) || typeof value.op !== "string") fail("it has a value that isn’t an expression.");
  const sub = (inner: unknown) => expression(inner, depth + 1);
  switch (value.op) {
    case "lit": {
      const v = value.v;
      if (v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) {
        return { op: "lit", v };
      }
      return fail("it has a literal that isn’t text, a number, true, false or null.");
    }
    case "var":
      if (typeof value.name !== "string" || !AIDEN_UI_NAME.test(value.name)) fail("it reads a name that isn’t valid.");
      return { op: "var", name: value.name };
    case "get":
      return { op: "get", of: sub(value.of), key: sub(value.key) };
    case "bin":
      if (typeof value.o !== "string" || !AIDEN_UI_BINARY_OPERATORS.has(value.o)) fail("it uses an operator Aiden doesn’t have.");
      return { op: "bin", o: value.o as Extract<AidenUiExprV1, { op: "bin" }>["o"], l: sub(value.l), r: sub(value.r) };
    case "not":
      return { op: "not", e: sub(value.e) };
    case "if":
      return { op: "if", test: sub(value.test), then: sub(value.then), else: sub(value.else) };
    case "call":
      if (typeof value.fn !== "string" || !AIDEN_UI_FUNCTIONS.has(value.fn)) fail("it calls a function Aiden doesn’t have.");
      if (!Array.isArray(value.a)) fail("a function call has no argument list.");
      return { op: "call", fn: value.fn as Extract<AidenUiExprV1, { op: "call" }>["fn"], a: value.a.map(sub) };
    case "json":
      if (!isJsonValue(value.v) || !keysAreWireSafe(value.v)) fail("it has a constant that isn’t plain data, or uses a reserved key.");
      return { op: "json", v: value.v };
    default:
      return fail("it has an expression Aiden doesn’t understand.");
  }
}

function action(value: Record<string, unknown>, walk: Walk): AidenUiActionV1 {
  const sub = (inner: unknown) => expression(inner, 1);
  switch (value.act) {
    case "send":
      return { act: "send", text: sub(value.text) };
    case "copy":
      return { act: "copy", text: sub(value.text) };
    case "open": {
      const url = sub(value.url);
      if (url.op === "lit" && !(typeof url.v === "string" && url.v.startsWith("https://"))) fail("openUrl only accepts https:// links.");
      return { act: "open", url };
    }
    case "compose":
      if (!walk.artifactActions) fail("compose() works only in workspace artifacts.");
      return { act: "compose", text: sub(value.text) };
    case "run":
      if (!walk.artifactActions) fail("run() works only in workspace artifacts.");
      if (typeof value.name !== "string" || !RUN_ACTION_NAME.test(value.name)) fail("a button runs an action whose name isn’t valid.");
      if (!Array.isArray(value.a) || value.a.length > MAX_RUN_ARGUMENTS) {
        fail(`a button passes more than ${MAX_RUN_ARGUMENTS} values, or none in a list.`);
      }
      return { act: "run", name: value.name, a: value.a.map(sub) };
    case "set":
      if (typeof value.key !== "string" || !walk.stateKeys.has(value.key)) fail("setState() names a key the page doesn’t declare.");
      return { act: "set", key: value.key, value: sub(value.value) };
    default:
      return fail("it has an action Aiden doesn’t have.");
  }
}

/** One prop, held to its catalog kind the way `compileProp` builds it. */
function prop(component: string, kind: PropKind, value: unknown, walk: Walk): AidenUiPropValueV1 {
  if (!isRecord(value)) fail(`${shown(component)} has a setting that isn’t a value.`);
  if (kind === "action") {
    if (typeof value.act !== "string" || value.op !== undefined) fail(`${shown(component)} has an action that isn’t one.`);
    return action(value, walk);
  }
  if (value.act !== undefined) fail(`${shown(component)} has an action where a value belongs.`);
  const expr = expression(value, 0);
  if (kind === "stateKey") {
    if (expr.op !== "lit" || typeof expr.v !== "string" || !walk.stateKeys.has(expr.v)) {
      fail(`${shown(component)} binds a key the page doesn’t declare.`);
    }
    return expr;
  }
  if (expr.op === "lit") {
    if (kind === "number" && typeof expr.v !== "number") fail(`${shown(component)} expects a number.`);
    if (kind === "boolean" && typeof expr.v !== "boolean") fail(`${shown(component)} expects true or false.`);
    if (kind === "icon" && !isAidenUiIcon(expr.v)) fail(`${shown(component)} names an icon Aiden doesn’t have.`);
    if (typeof kind === "object" && !(typeof expr.v === "string" && kind.enum.includes(expr.v))) {
      fail(`${shown(component)} has a choice that isn’t one of its options.`);
    }
  }
  return expr;
}

/** The children a parent of `policy` may hold, rebuilt. */
function children(value: unknown, policy: CatalogEntry["children"], parent: string, depth: number, walk: Walk): AidenUiNodeV1[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(`${shown(parent)} has children that aren’t a list.`);
  if (value.length === 0) return undefined;
  if (policy === "none") fail(`${shown(parent)} cannot hold anything.`);
  return value.map((child) => node(child, policy, parent, depth + 1, walk));
}

function node(value: unknown, policy: CatalogEntry["children"], parent: string, depth: number, walk: Walk): AidenUiNodeV1 {
  if (!isRecord(value) || typeof value.t !== "string") fail("it has a component that isn’t one.");
  walk.nodes += 1;
  if (walk.nodes > AIDEN_UI_LIMITS.nodes || depth > AIDEN_UI_LIMITS.depth) fail("it is larger or deeper than a page may be.");
  if (value.t === "#text" || value.t === "#expr") {
    if (value.p !== undefined || value.c !== undefined) fail("inline text cannot hold settings or children.");
    if (value.t === "#text") {
      if (typeof value.s !== "string" || value.s.length > MAX_TEXT_CHARS) fail("it has inline text that is missing or too long.");
      return { t: "#text", k: "", s: value.s };
    }
    return { t: "#expr", k: "", e: expression(value.e, 0) };
  }
  const entry = ownEntry(AIDEN_UI_CATALOG, value.t);
  // The compiler folds <Data> into the page's data and allows <Visual> only at the root.
  if (!entry || value.t === "Data" || value.t === "Visual") fail(`it uses ${shown(value.t)}, which isn’t one of Aiden’s components here.`);
  if (policy === "text" && !INLINE_ELEMENTS.has(value.t)) fail(`${shown(value.t)} cannot go inside ${shown(parent)}.`);
  return element(value, value.t, entry, depth, walk);
}

function element(value: Record<string, unknown>, name: string, entry: CatalogEntry, depth: number, walk: Walk): AidenUiNodeV1 {
  if (value.s !== undefined || value.e !== undefined) fail(`${shown(name)} carries inline content it can’t have.`);
  let props: Record<string, AidenUiPropValueV1> | undefined;
  if (value.p !== undefined) {
    if (!isRecord(value.p)) fail(`${shown(name)} has settings that aren’t a list of values.`);
    props = {};
    for (const [key, inner] of Object.entries(value.p)) {
      const kind = ownEntry(entry.props, key);
      // <Visual state> is read into the visual's state, never kept as a prop.
      if (!kind || (name === "Visual" && key === "state")) fail(`${shown(name)} has a setting Aiden doesn’t know.`);
      props[key] = prop(name, kind, inner, walk);
    }
  }
  for (const required of entry.required ?? []) {
    if (!props || !hasOwn(props, required)) fail(`${shown(name)} is missing a setting it needs.`);
  }
  const c = children(value.c, entry.children, name, depth, walk);
  return { t: name, k: "", ...(props && Object.keys(props).length ? { p: props } : {}), ...(c ? { c } : {}) };
}

function assignKeys(tree: AidenUiNodeV1, key: string): void {
  tree.k = key;
  tree.c?.forEach((child, index) => assignKeys(child, `${key}.${index}`));
}

function dataBindings(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail("its data isn’t JSON text.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail("its data isn’t valid JSON.");
  }
  if (!isRecord(parsed)) fail("its data must be an object of named values.");
  for (const name of Object.keys(parsed)) {
    if (!AIDEN_UI_NAME.test(name) || RESERVED_DATA_NAMES.has(name)) fail("its data uses a name that isn’t valid.");
  }
  const serialized = JSON.stringify(parsed);
  if (new TextEncoder().encode(serialized).length > AIDEN_UI_LIMITS.dataBytes) fail("its data is larger than a page may hold.");
  return serialized;
}

export function validateCompiledAum(parts: CompiledAumParts, options: ValidateCompiledAumOptions = {}): ValidatedCompiledAum {
  try {
    let state: Record<string, unknown> | undefined;
    if (parts.state !== undefined) {
      state = parseAidenUiState(parts.state);
      if (!state) fail("its state is too large or uses a reserved key name.");
    }
    const walk: Walk = { stateKeys: new Set(Object.keys(state ?? {})), artifactActions: options.artifactActions === true, nodes: 1 };
    const root = parts.tree;
    if (!isRecord(root) || root.t !== "Visual") fail("the page must start with <Visual>.");
    const tree = element(root, "Visual", AIDEN_UI_CATALOG.Visual!, 0, walk);
    if (!tree.c?.length) fail("the page is empty.");
    assignKeys(tree, "0");
    if (new TextEncoder().encode(JSON.stringify(tree)).length > AIDEN_UI_LIMITS.treeBytes) fail("the page is larger than it may be.");
    const dataJson = dataBindings(parts.dataJson);
    return { ok: true, tree, ...(dataJson !== undefined ? { dataJson } : {}), ...(state ? { state } : {}) };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message };
    // A tree deep enough to exhaust the stack is refused too.
    return { ok: false, error: "the page is invalid." };
  }
}
