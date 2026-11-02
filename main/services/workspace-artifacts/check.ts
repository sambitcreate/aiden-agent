import { evaluate, truthy, type AidenUiRead, type AidenUiScope } from "../../../renderer/shared/aiden-ui/evaluate.js";
import { AIDEN_UI_LIMITS, type AidenUiActionV1, type AidenUiExprV1, type AidenUiNodeV1 } from "../../../renderer/shared/aiden-ui/types.js";
import {
  workspaceArtifactDataJson,
  type WorkspaceArtifactSourceResultV1,
  type WorkspaceArtifactV1,
} from "../../../renderer/shared/workspace-artifacts.js";

/**
 * Checks a saved page against the data its first refresh returned, the way
 * the Artifacts tab would draw it, so the model learns about reads that come
 * back empty without seeing the tab. The evaluator never fails, so a typo'd
 * field or `$list.length` would otherwise just render blank.
 */

const MAX_FINDINGS = 10;
const MAX_FIELDS_SHOWN = 12;
const NODE_BUDGET = AIDEN_UI_LIMITS.nodes * 2;
const ITERATION_BUDGET = AIDEN_UI_LIMITS.eachIterations * 4;

type GetExpr = Extract<AidenUiExprV1, { op: "get" }>;

interface MemberTally {
  expr: GetExpr;
  key: unknown;
  found: number;
  missing: number;
  onList: number;
  fields: Set<string>;
}

export interface WorkspaceArtifactPageCheck {
  /** Problems to fix, one sentence each. */
  findings: string[];
  /** What could not be checked, such as a source that did not load or an empty list. */
  unchecked: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExpr(value: unknown): value is AidenUiExprV1 {
  return isRecord(value) && typeof value.op === "string";
}

function isAction(value: unknown): value is AidenUiActionV1 {
  return isRecord(value) && typeof value.act === "string";
}

/** `$pulls.items[0].title`, as the model wrote it, for messages. */
function describe(expr: AidenUiExprV1): string {
  if (expr.op === "var") return `$${expr.name}`;
  if (expr.op === "get") {
    const key = expr.key;
    if (key.op === "lit" && typeof key.v === "string" && /^[A-Za-z_][\w]*$/u.test(key.v)) return `${describe(expr.of)}.${key.v}`;
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

function exprVars(expr: AidenUiExprV1, into: Set<string>): void {
  switch (expr.op) {
    case "var":
      into.add(expr.name);
      return;
    case "get":
      exprVars(expr.of, into);
      exprVars(expr.key, into);
      return;
    case "not":
      exprVars(expr.e, into);
      return;
    case "if":
      exprVars(expr.test, into);
      exprVars(expr.then, into);
      exprVars(expr.else, into);
      return;
    case "bin":
      exprVars(expr.l, into);
      exprVars(expr.r, into);
      return;
    case "call":
      for (const arg of expr.a) exprVars(arg, into);
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

function parseVars(dataJson: string | undefined, state: Record<string, unknown> | undefined): Record<string, unknown> {
  let data: Record<string, unknown> = {};
  if (dataJson) {
    try {
      const parsed = JSON.parse(dataJson) as unknown;
      if (isRecord(parsed)) data = parsed;
    } catch {
      data = {};
    }
  }
  return { ...data, ...(state ?? {}) };
}

export function checkWorkspaceArtifactPage(
  artifact: Pick<WorkspaceArtifactV1, "visual" | "sources" | "actions">,
  results: Record<string, WorkspaceArtifactSourceResultV1> | undefined,
): WorkspaceArtifactPageCheck {
  const findings: string[] = [];
  const add = (message: string) => {
    if (!findings.includes(message)) findings.push(message);
  };

  // What the markup names, whether or not it renders: every `$name` read and
  // every run() call.
  const named = new Set<string>();
  const runs: { name: string; args: number }[] = [];
  forEachNode([artifact.visual.tree], (node) => {
    if (node.e) exprVars(node.e, named);
    for (const value of Object.values(node.p ?? {})) {
      if (isAction(value)) {
        if (value.act === "run") runs.push({ name: value.name, args: value.a.length });
        for (const expr of actionExprs(value)) exprVars(expr, named);
      } else if (isExpr(value)) {
        exprVars(value, named);
      }
    }
  });

  for (const call of runs) {
    const action = artifact.actions.find((entry) => entry.name === call.name);
    if (!action) {
      const declared = artifact.actions.map((entry) => entry.name).join(", ");
      add(`run("${call.name}") names no action on this page${declared ? ` (actions: ${declared})` : ""}.`);
    } else if (call.args !== action.params.length) {
      add(`run("${call.name}") passes ${call.args} value${call.args === 1 ? "" : "s"}, but the action takes ${action.params.length}.`);
    }
  }
  for (const source of artifact.sources) {
    if (!named.has(source.name)) add(`Source "${source.name}" is never read; bind it in markup as $${source.name}.`);
  }

  const loaded = new Set(
    artifact.sources.filter((source) => results?.[source.name]?.status === "ok").map((source) => source.name),
  );
  const notLoaded = new Set(artifact.sources.map((source) => source.name).filter((name) => !loaded.has(name)));
  const unchecked = [...notLoaded].filter((name) => named.has(name)).map((name) => `$${name} did not load`);

  // Draw the page once with the real data, the way the Artifacts tab does.
  const snapshot = results ? { revision: 0, refreshedAt: 0, sources: results } : undefined;
  const vars = parseVars(workspaceArtifactDataJson(artifact, snapshot), artifact.visual.state);
  const missingVars = new Set<string>();
  const members = new Map<GetExpr, MemberTally>();
  const onRead = (read: AidenUiRead) => {
    if (read.kind === "var") {
      if (!read.found) missingVars.add(read.expr.name);
      return;
    }
    const root = rootName(read.expr);
    if (root !== undefined && notLoaded.has(root)) return;
    let tally = members.get(read.expr);
    if (!tally) {
      tally = { expr: read.expr, key: read.key, found: 0, missing: 0, onList: 0, fields: new Set() };
      members.set(read.expr, tally);
    }
    if (Array.isArray(read.object)) {
      if (typeof read.key === "string") tally.onList += 1;
      else tally.found += 1;
    } else if (isRecord(read.object) && (typeof read.key === "string" || typeof read.key === "number")) {
      if (Object.prototype.hasOwnProperty.call(read.object, String(read.key))) {
        tally.found += 1;
      } else {
        tally.missing += 1;
        for (const field of Object.keys(read.object)) tally.fields.add(field);
      }
    }
  };

  const budget = { nodes: NODE_BUDGET, iterations: ITERATION_BUDGET };
  const read = (expr: AidenUiExprV1, scope: AidenUiScope) => evaluate(expr, { ...scope, onRead });
  const walk = (nodes: readonly AidenUiNodeV1[] | undefined, scope: AidenUiScope): void => {
    for (const node of nodes ?? []) {
      if (budget.nodes <= 0) return;
      budget.nodes -= 1;
      if (node.t === "#expr") {
        if (node.e) read(node.e, scope);
        continue;
      }
      if (node.t === "If") {
        const test = node.p?.test;
        if (isExpr(test) && truthy(read(test, scope))) walk(node.c, scope);
        continue;
      }
      if (node.t === "Each") {
        const source = node.p?.in;
        const list = isExpr(source) ? read(source, scope) : undefined;
        if (!Array.isArray(list)) {
          if (isExpr(source) && isRecord(list)) {
            const lists = Object.keys(list).filter((key) => Array.isArray(list[key]));
            add(
              `<Each in={${describe(source)}}> got an object, not a list${lists.length ? `; its list fields are ${lists.join(", ")}` : ""}.`,
            );
          }
          continue;
        }
        if (list.length === 0 && node.c?.length) {
          // Rows of an empty list never draw, so nothing inside them was read.
          const note = `the rows of <Each in={${isExpr(source) ? describe(source) : "…"}}> (the list was empty)`;
          if (!unchecked.includes(note)) unchecked.push(note);
          continue;
        }
        const as = node.p?.as;
        const asName = isExpr(as) ? evaluate(as, scope) : undefined;
        const name = (typeof asName === "string" || typeof asName === "number" ? String(asName) : "") || "item";
        for (const [index, item] of list.slice(0, AIDEN_UI_LIMITS.eachIterations).entries()) {
          if (budget.iterations <= 0 || budget.nodes <= 0) break;
          budget.iterations -= 1;
          walk(node.c, { ...scope, vars: { ...scope.vars, [name]: item, [`${name}Index`]: index } });
        }
        continue;
      }
      for (const value of Object.values(node.p ?? {})) {
        if (isAction(value)) for (const expr of actionExprs(value)) read(expr, scope);
        else if (isExpr(value)) read(value, scope);
      }
      walk(node.c, scope);
    }
  };
  walk([artifact.visual.tree], { vars });

  for (const name of missingVars) {
    add(`$${name} is not a source, a <Data> value or a state key, so it is always empty.`);
  }
  for (const tally of members.values()) {
    if (tally.found > 0) continue;
    const where = describe(tally.expr);
    if (tally.onList > 0) {
      add(
        tally.key === "length"
          ? `${where} is always empty: lists have no .length; use len(${describe(tally.expr.of)}).`
          : `${where} is always empty: ${describe(tally.expr.of)} is a list; loop over it with <Each> or pick one item by index.`,
      );
    } else if (tally.missing > 0) {
      const fields = [...tally.fields];
      const shown = fields.slice(0, MAX_FIELDS_SHOWN).join(", ");
      add(
        `${where} is always empty: the data has no "${String(tally.key)}" field${fields.length ? ` (it has ${shown}${fields.length > MAX_FIELDS_SHOWN ? ", …" : ""})` : ""}.`,
      );
    }
  }

  return { findings: findings.slice(0, MAX_FINDINGS), unchecked };
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
  return lines.join("\n");
}
