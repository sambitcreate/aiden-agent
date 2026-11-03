import { AIDEN_UI_CATALOG, PRESERVE_WHITESPACE } from "../../../renderer/shared/aiden-ui/catalog.js";
import { evaluate, truthy, type AidenUiRead, type AidenUiScope } from "../../../renderer/shared/aiden-ui/evaluate.js";
import { hasOwn, ownEntry } from "../../../renderer/shared/aiden-ui/own.js";
import { asString, isAction, isExpr, parseAidenUiData } from "../../../renderer/shared/aiden-ui/props.js";
import {
  AIDEN_UI_LIMITS,
  AIDEN_UI_RENDER_BUDGET,
  type AidenUiActionV1,
  type AidenUiExprV1,
  type AidenUiNodeV1,
} from "../../../renderer/shared/aiden-ui/types.js";
import {
  workspaceArtifactDataJson,
  type WorkspaceArtifactSourceResultV1,
  type WorkspaceArtifactV1,
} from "../../../renderer/shared/workspace-artifacts.js";

const MAX_FINDINGS = 10;
const MAX_NAMES_SHOWN = 12;
const MAX_OUTPUT_CHARS = 3_000;
/** The check runs in the main process, so a hostile page or huge data must not stall the app. */
const DEADLINE_MS = 250;
/** Names from the data are shown only when they look like plain identifiers. */
const SHOWABLE_NAME = /^[\w$-]{1,40}$/u;

type GetExpr = Extract<AidenUiExprV1, { op: "get" }>;

interface MemberTally {
  expr: GetExpr;
  key: unknown;
  found: number;
  missing: number;
  /** A named member read on a list. */
  onList: number;
  /** `.length` read on text. */
  onText: number;
  fields: Set<string>;
}

class OutOfTime extends Error {}

export interface WorkspaceArtifactPageCheck {
  /** Problems to fix, one sentence each. */
  findings: string[];
  /** What could not be checked, such as a source that did not load or an empty list. */
  unchecked: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Up to a dozen names that came from data, quoted; the rest are counted, never echoed. */
function listNames(names: Iterable<string>): string {
  const all = [...names];
  const shown = all.filter((name) => SHOWABLE_NAME.test(name)).slice(0, MAX_NAMES_SHOWN);
  const rest = all.length - shown.length;
  return `${shown.map((name) => JSON.stringify(name)).join(", ")}${rest > 0 ? `${shown.length ? " and " : ""}${rest} more` : ""}`;
}

/** `$pulls.items[0].title`, as the model wrote it, for messages. */
function describe(expr: AidenUiExprV1): string {
  if (expr.op === "var") return `$${expr.name}`;
  if (expr.op === "get") {
    const key = expr.key;
    if (key.op === "lit" && typeof key.v === "string" && /^[A-Za-z_]\w{0,39}$/u.test(key.v)) return `${describe(expr.of)}.${key.v}`;
    if (key.op === "lit" && typeof key.v === "number") return `${describe(expr.of)}[${key.v}]`;
    return `${describe(expr.of)}[…]`;
  }
  if (expr.op === "call") return `${expr.fn}(…)`;
  return "a value";
}

function rootName(expr: AidenUiExprV1): string | undefined {
  if (expr.op === "var") return expr.name;
  if (expr.op === "get") return rootName(expr.of);
  return undefined;
}

function actionExprs(action: AidenUiActionV1): AidenUiExprV1[] {
  switch (action.act) {
    case "set":
      return [action.value];
    case "open":
      return [action.url];
    case "run":
      return action.a;
    default:
      return [action.text];
  }
}

function isNull(expr: AidenUiExprV1): boolean {
  return expr.op === "lit" && expr.v === null;
}

/**
 * Collects every `$name` an expression reads, and the member reads whose value
 * only decides a test (`<If test>`, `a ? … : …`, `!a`, `a && …`, `a || …`,
 * `a == null`). Those guard fields that may be absent, so one refresh without
 * the field says nothing about whether the page is wrong.
 */
function scanExpr(expr: AidenUiExprV1, test: boolean, names: Set<string>, guards: Set<GetExpr>): void {
  switch (expr.op) {
    case "var":
      names.add(expr.name);
      return;
    case "get":
      if (test) guards.add(expr);
      scanExpr(expr.of, false, names, guards);
      scanExpr(expr.key, false, names, guards);
      return;
    case "not":
      scanExpr(expr.e, true, names, guards);
      return;
    case "if":
      scanExpr(expr.test, true, names, guards);
      scanExpr(expr.then, test, names, guards);
      scanExpr(expr.else, test, names, guards);
      return;
    case "bin": {
      const logical = expr.o === "&&" || expr.o === "||";
      const nullCheck = (expr.o === "==" || expr.o === "!=") && (isNull(expr.l) || isNull(expr.r));
      scanExpr(expr.l, logical || nullCheck, names, guards);
      scanExpr(expr.r, logical ? test : nullCheck, names, guards);
      return;
    }
    case "call":
      for (const arg of expr.a) scanExpr(arg, false, names, guards);
      return;
    default:
      return;
  }
}

function forEachNode(nodes: readonly AidenUiNodeV1[] | undefined, visit: (node: AidenUiNodeV1) => void): void {
  for (const node of nodes ?? []) {
    visit(node);
    forEachNode(node.c, visit);
  }
}

function readsAnything(nodes: readonly AidenUiNodeV1[] | undefined): boolean {
  let found = false;
  forEachNode(nodes, (node) => {
    if (node.e || Object.values(node.p ?? {}).some((value) => isExpr(value) && value.op !== "lit")) found = true;
  });
  return found;
}

/**
 * Checks a saved page against the data its first refresh returned, so the
 * model learns about reads that come back empty without seeing the tab (the
 * evaluator never fails, so a misspelled field just renders blank). It draws
 * the page the way the tab does: from the root's children, following `If`
 * and `Each`, skipping names outside the catalog and the text-only children of
 * Markdown, Code and Math, within the tab's node and loop budgets. Unlike the
 * tab it also evaluates every button's values, with the page's initial state.
 */
export function checkWorkspaceArtifactPage(
  artifact: Pick<WorkspaceArtifactV1, "visual" | "sources" | "actions">,
  results: Record<string, WorkspaceArtifactSourceResultV1> | undefined,
  now: () => number = Date.now,
): WorkspaceArtifactPageCheck {
  const findings: string[] = [];
  const unchecked: string[] = [];
  const add = (into: string[], message: string) => {
    if (!into.includes(message)) into.push(message);
  };

  // What the markup names, whether or not it draws: every `$name`, the reads
  // that only guard a test, and every run() call.
  const named = new Set<string>();
  const guards = new Set<GetExpr>();
  const runs: { name: string; args: number }[] = [];
  forEachNode([artifact.visual.tree], (node) => {
    if (node.e) scanExpr(node.e, false, named, guards);
    for (const [prop, value] of Object.entries(node.p ?? {})) {
      if (isAction(value)) {
        if (value.act === "run") runs.push({ name: value.name, args: value.a.length });
        for (const expr of actionExprs(value)) scanExpr(expr, false, named, guards);
      } else if (isExpr(value)) {
        scanExpr(value, node.t === "If" && prop === "test", named, guards);
      }
    }
  });

  for (const call of runs) {
    const action = artifact.actions.find((entry) => entry.name === call.name);
    if (!action) {
      const declared = artifact.actions.map((entry) => entry.name).join(", ");
      add(findings, `run("${call.name}") names no action on this page${declared ? ` (actions: ${declared})` : ""}.`);
    } else if (call.args !== action.params.length) {
      add(findings, `run("${call.name}") passes ${call.args} value${call.args === 1 ? "" : "s"}, but the action takes ${action.params.length}.`);
    }
  }
  for (const source of artifact.sources) {
    if (!named.has(source.name)) add(findings, `Source "${source.name}" is never read; bind it in markup as $${source.name}.`);
  }

  const notLoaded = new Set(artifact.sources.filter((source) => results?.[source.name]?.status !== "ok").map((source) => source.name));
  for (const name of notLoaded) if (named.has(name)) add(unchecked, `$${name} did not load`);

  const snapshot = results ? { revision: 0, refreshedAt: 0, sources: results } : undefined;
  const vars = { ...parseAidenUiData(workspaceArtifactDataJson(artifact, snapshot)), ...(artifact.visual.state ?? {}) };
  // When the sources' data together is over the cap, the tab binds none of them.
  const dropped = artifact.sources.filter((source) => !notLoaded.has(source.name) && !hasOwn(vars, source.name));
  if (dropped.length) {
    add(
      findings,
      `The sources' data is too large to show together, so the tab shows none of it; select fewer fields or rows in ${dropped.map((source) => `"${source.name}"`).join(", ")}.`,
    );
  }
  const droppedNames = new Set(dropped.map((source) => source.name));

  const deadline = now() + DEADLINE_MS;
  const missingVars = new Set<string>();
  const members = new Map<GetExpr, MemberTally>();
  const onRead = (read: AidenUiRead) => {
    // The evaluator turns this into an empty value; the walk stops at its next node.
    if (now() > deadline) throw new OutOfTime();
    if (read.kind === "var") {
      if (!read.found && !droppedNames.has(read.expr.name)) missingVars.add(read.expr.name);
      return;
    }
    const root = rootName(read.expr);
    if (root !== undefined && notLoaded.has(root)) return;
    let tally = members.get(read.expr);
    if (!tally) {
      tally = { expr: read.expr, key: read.key, found: 0, missing: 0, onList: 0, onText: 0, fields: new Set() };
      members.set(read.expr, tally);
    }
    if (read.value !== undefined) {
      tally.found += 1;
    } else if (Array.isArray(read.object)) {
      if (typeof read.key === "string") tally.onList += 1;
    } else if (typeof read.object === "string") {
      if (read.key === "length") tally.onText += 1;
    } else if (isRecord(read.object) && (typeof read.key === "string" || typeof read.key === "number")) {
      tally.missing += 1;
      for (const field of Object.keys(read.object)) {
        if (tally.fields.size >= MAX_NAMES_SHOWN * 4) break;
        tally.fields.add(field);
      }
    }
  };

  let hiddenBranches = 0;
  let cutShort = false;
  const budget = { nodes: AIDEN_UI_RENDER_BUDGET.nodes, iterations: AIDEN_UI_RENDER_BUDGET.iterations };
  const read = (expr: AidenUiExprV1, scope: AidenUiScope) => evaluate(expr, { ...scope, onRead });
  const walk = (nodes: readonly AidenUiNodeV1[] | undefined, scope: AidenUiScope): void => {
    for (const node of nodes ?? []) {
      if (now() > deadline) throw new OutOfTime();
      if (budget.nodes <= 0) {
        cutShort = true;
        return;
      }
      budget.nodes -= 1;
      if (node.t === "#text") continue;
      if (node.t === "#expr") {
        if (node.e) read(node.e, scope);
        continue;
      }
      if (node.t === "If") {
        const test = node.p?.test;
        if (isExpr(test) && truthy(read(test, scope))) walk(node.c, scope);
        else if (readsAnything(node.c)) hiddenBranches += 1;
        continue;
      }
      if (node.t === "Each") {
        const source = node.p?.in;
        const list = isExpr(source) ? read(source, scope) : undefined;
        if (!Array.isArray(list)) {
          if (isExpr(source) && isRecord(list)) {
            const lists = Object.keys(list).filter((key) => Array.isArray(list[key]));
            add(findings, `<Each in={${describe(source)}}> got an object, not a list${lists.length ? `; its list fields are ${listNames(lists)}` : ""}.`);
          }
          continue;
        }
        if (list.length === 0) {
          if (readsAnything(node.c)) add(unchecked, `the rows of <Each in={${isExpr(source) ? describe(source) : "…"}}> (the list was empty)`);
          continue;
        }
        const as = node.p?.as;
        const name = (isExpr(as) ? asString(evaluate(as, scope)) : "") || "item";
        for (const [index, item] of list.slice(0, AIDEN_UI_LIMITS.eachIterations).entries()) {
          if (budget.iterations <= 0 || budget.nodes <= 0) {
            cutShort = true;
            break;
          }
          budget.iterations -= 1;
          walk(node.c, { ...scope, vars: { ...scope.vars, [name]: item, [`${name}Index`]: index } });
        }
        continue;
      }
      // The tab draws only catalog components; anything else draws nothing.
      if (!ownEntry(AIDEN_UI_CATALOG, node.t)) continue;
      for (const value of Object.values(node.p ?? {})) {
        if (isAction(value)) for (const expr of actionExprs(value)) read(expr, scope);
        else if (isExpr(value)) read(value, scope);
      }
      // Markdown, Code and Math show their text as written, without evaluating it.
      if (!PRESERVE_WHITESPACE.has(node.t)) walk(node.c, scope);
    }
  };
  try {
    walk(artifact.visual.tree.c, { vars });
  } catch (error) {
    if (!(error instanceof OutOfTime)) throw error;
    add(unchecked, "the rest of the page (the check ran out of time)");
  }
  if (cutShort) add(unchecked, "the rest of the page (too large to draw in full)");
  if (hiddenBranches) {
    add(unchecked, `${hiddenBranches} <If> branch${hiddenBranches === 1 ? "" : "es"} hidden with this data`);
  }

  for (const name of missingVars) {
    add(findings, `$${name} is not a source, a <Data> value or a state key, so it is always empty.`);
  }
  for (const tally of members.values()) {
    if (tally.found > 0 || guards.has(tally.expr)) continue;
    const where = describe(tally.expr);
    const of = describe(tally.expr.of);
    if (tally.onList > 0) {
      add(
        findings,
        tally.key === "length"
          ? `${where} is always empty: lists have no .length; use len(${of}).`
          : `${where} is always empty: ${of} is a list; loop over it with <Each> or pick one item by index.`,
      );
    } else if (tally.onText > 0) {
      add(findings, `${where} is always empty: text has no .length; use len(${of}).`);
    } else if (tally.missing > 0) {
      const key = typeof tally.key === "string" && SHOWABLE_NAME.test(tally.key) ? `"${tally.key}"` : "that";
      add(findings, `${where} is always empty: the data has no ${key} field${tally.fields.size ? ` (it has ${listNames(tally.fields)})` : ""}.`);
    }
  }

  if (findings.length > MAX_FINDINGS) {
    const extra = findings.length - MAX_FINDINGS;
    findings.splice(MAX_FINDINGS, extra, `…and ${extra} more`);
  }
  return { findings, unchecked };
}

/** The check as text for the end of the tool result. */
export function describeWorkspaceArtifactPageCheck(check: WorkspaceArtifactPageCheck): string {
  const lines: string[] = [];
  if (check.findings.length) {
    lines.push("\nPage check (fix these, then update the page):");
    for (const finding of check.findings) lines.push(`- ${finding}`);
  } else if (!check.unchecked.length) {
    lines.push("\nPage check: every value the page reads was found.");
  } else {
    lines.push("\nPage check: no problems in what was drawn.");
  }
  if (check.unchecked.length) lines.push(`Not checked: ${check.unchecked.join("; ")}.`);
  const text = lines.join("\n");
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}…` : text;
}
