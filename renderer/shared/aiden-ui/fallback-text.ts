import { evaluate, formatValue, truthy, type AidenUiScope } from "./evaluate.js";
import { AIDEN_UI_LIMITS, type AidenUiExprV1, type AidenUiNodeV1, type AidenUiPropValueV1 } from "./types.js";

/**
 * Plain-text rendering of a visual at its initial state: Markdown-ish lines
 * for memory, the CLI, and clients that cannot draw the tree. Inputs are
 * skipped; their effect shows through the values they drive.
 *
 * Output goes into one shared accumulator that stops as soon as the text is
 * longer than the fallback cap or the work budget is spent. Expansion (loops,
 * long lists, repeated subtrees) therefore costs about the cap, never the full
 * expansion, and the kept text is the same prefix the uncapped join would give.
 */

const MAX_TABLE_ROWS = 20;
const SKIPPED = new Set(["Segmented", "Tabs", "Switch", "Checkbox", "RadioGroup", "Select", "Slider", "TextInput", "Separator", "Spacer"]);
/** Every visited node and every expanded item costs one unit. Real visuals stay far below this. */
const WORK_BUDGET = AIDEN_UI_LIMITS.nodes * 8;
/** Loop iterations across one fallback (nested loops share it). */
const ITERATION_BUDGET = AIDEN_UI_LIMITS.eachIterations * 4;

type ValueFormat = "number" | "currency" | "percent" | "date" | "text";

class FallbackLines {
  readonly lines: string[] = [];
  /** Length of `lines.join("\n")`, kept as lines are added. */
  private size = 0;
  private work = WORK_BUDGET;
  iterations = ITERATION_BUDGET;
  private prefix = "";

  /** True once the text is known to exceed the cap, or the work budget is spent. */
  get full(): boolean {
    return this.size > AIDEN_UI_LIMITS.fallbackChars || this.work <= 0;
  }

  /** Spends one unit of work; false when no more output can be produced. */
  take(): boolean {
    if (this.full) return false;
    this.work -= 1;
    return true;
  }

  /** Adds one line. A line longer than the cap is clipped: nothing past the cap is ever kept. */
  push(line: string): void {
    if (this.full) return;
    const text = `${this.prefix}${line}`.slice(0, AIDEN_UI_LIMITS.fallbackChars + 1);
    this.size += (this.lines.length > 0 ? 1 : 0) + text.length;
    this.lines.push(text);
  }

  /** Runs `emit` with every line it adds prefixed by `prefix`. */
  quoted(prefix: string, emit: () => void): void {
    const outer = this.prefix;
    this.prefix = `${outer}${prefix}`;
    try {
      emit();
    } finally {
      this.prefix = outer;
    }
  }
}

function isExpr(value: AidenUiPropValueV1 | undefined): value is AidenUiExprV1 {
  return Boolean(value) && "op" in (value as object);
}

function prop(node: AidenUiNodeV1, name: string, scope: AidenUiScope): unknown {
  const value = node.p?.[name];
  return isExpr(value) ? evaluate(value, scope) : undefined;
}

function str(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function formatted(value: unknown, format: unknown, scope: AidenUiScope): string {
  if (format === "number" || format === "currency" || format === "percent" || format === "date") {
    return formatValue(value, format, scope.locale);
  }
  if (typeof value === "number" && format !== "text") return formatValue(value, "number", scope.locale);
  return str(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function inline(node: AidenUiNodeV1, scope: AidenUiScope): string {
  if (node.t === "#text") return node.s ?? "";
  if (node.t === "#expr") return node.e ? str(evaluate(node.e, scope)) : "";
  return (node.c ?? []).map((child) => inline(child, scope)).join("");
}

function table(rows: unknown, columns: unknown, scope: AidenUiScope, out: FallbackLines): void {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const columnList: Record<string, unknown>[] = Array.isArray(columns) && columns.length
    ? columns.map((column) => record(column))
    : Object.keys(record(rows[0])).map((key) => ({ key, label: key }));
  const header = columnList.map((column) => str(column.label) || str(column.key));
  out.push(`| ${header.join(" | ")} |`);
  out.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const row of rows.slice(0, MAX_TABLE_ROWS)) {
    // A row is kept whole or not at all, so every kept line is complete.
    const cells: string[] = [];
    for (const column of columnList) {
      if (!out.take()) return;
      const key = str(column.key);
      // Cells are clipped before escaping: nothing past the cap is ever kept.
      cells.push(formatted(record(row)[key], column.format, scope).slice(0, AIDEN_UI_LIMITS.fallbackChars + 1).replace(/\|/gu, "\\|"));
    }
    out.push(`| ${cells.join(" | ")} |`);
  }
  if (rows.length > MAX_TABLE_ROWS) out.push(`(${rows.length - MAX_TABLE_ROWS} more rows)`);
}

function lines(node: AidenUiNodeV1, scope: AidenUiScope, out: FallbackLines): void {
  if (!out.take()) return;
  if (SKIPPED.has(node.t)) return;
  const children = () => {
    for (const child of node.c ?? []) lines(child, scope, out);
  };
  switch (node.t) {
    case "#text":
    case "#expr":
    case "Text":
    case "Markdown":
    case "Code":
    case "Math":
    case "Kbd":
    case "Badge": {
      const text = inline(node, scope).trim();
      if (text) out.push(text);
      return;
    }
    case "Heading": {
      const level = Number(str(prop(node, "level", scope)) || "2");
      const text = inline(node, scope).trim();
      if (text) out.push(`${"#".repeat(Math.min(Math.max(level, 1), 3))} ${text}`);
      return;
    }
    case "Stat": {
      const label = str(prop(node, "label", scope));
      const value = formatted(prop(node, "value", scope), prop(node, "format", scope) as ValueFormat, scope);
      const caption = str(prop(node, "caption", scope));
      out.push(`${label}: ${value}${caption ? ` (${caption})` : ""}`);
      return;
    }
    case "Table":
      table(prop(node, "rows", scope), prop(node, "columns", scope), scope, out);
      return;
    case "KeyValue": {
      const items = prop(node, "items", scope);
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (!out.take()) return;
        out.push(`${str(record(item).label)}: ${str(record(item).value)}`);
      }
      return;
    }
    case "ListRow": {
      const title = str(prop(node, "title", scope));
      const description = str(prop(node, "description", scope));
      const meta = str(prop(node, "meta", scope));
      out.push(`- ${title}${description ? ` — ${description}` : ""}${meta ? ` (${meta})` : ""}`);
      return;
    }
    case "Checklist": {
      const items = prop(node, "items", scope);
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (!out.take()) return;
        out.push(`- [${truthy(record(item).done) ? "x" : " "}] ${str(record(item).label)}`);
      }
      return;
    }
    case "Timeline": {
      const items = prop(node, "items", scope);
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (!out.take()) return;
        const entry = record(item);
        const time = str(entry.time);
        const description = str(entry.description);
        out.push(`- ${time ? `${time}: ` : ""}${str(entry.title)}${description ? ` — ${description}` : ""}`);
      }
      return;
    }
    case "Callout": {
      const title = str(prop(node, "title", scope));
      out.quoted("> ", () => {
        if (title) out.push(title);
        children();
      });
      return;
    }
    case "Progress":
    case "Meter": {
      const label = str(prop(node, "label", scope));
      const value = prop(node, "value", scope);
      const max = prop(node, "max", scope);
      out.push(`${label || node.t}: ${str(value)}${max !== undefined ? ` of ${str(max)}` : ""}`);
      return;
    }
    case "Chart": {
      const data = prop(node, "data", scope);
      const label = str(prop(node, "label", scope));
      const kind = str(prop(node, "kind", scope));
      out.push(`${label || "Chart"} (${kind ? `${kind} chart` : "chart"}, ${Array.isArray(data) ? data.length : 0} points)`);
      return;
    }
    case "BarList": {
      const items = prop(node, "items", scope);
      if (!Array.isArray(items)) return;
      const labelKey = str(prop(node, "label", scope)) || "label";
      const valueKey = str(prop(node, "value", scope)) || "value";
      const format = prop(node, "format", scope);
      for (const item of items) {
        if (!out.take()) return;
        out.push(`${str(record(item)[labelKey])}: ${formatted(record(item)[valueKey], format, scope)}`);
      }
      return;
    }
    case "Sparkline":
    case "Heatmap": {
      const label = str(prop(node, "label", scope));
      if (label) out.push(`${label} (${node.t.toLowerCase()})`);
      return;
    }
    case "Button": {
      const text = inline(node, scope).trim();
      if (text) out.push(`[${text}]`);
      return;
    }
    case "Image":
      out.push(`[Image: ${str(prop(node, "alt", scope))}]`);
      return;
    case "Icon":
      return;
    case "LinkCard":
      out.push(`${str(prop(node, "title", scope))} (${str(prop(node, "url", scope))})`);
      return;
    case "Card":
    case "Section":
    case "Disclosure": {
      const title = str(prop(node, "title", scope));
      if (title) out.push(`**${title}**`);
      children();
      return;
    }
    case "If":
      if (truthy(prop(node, "test", scope))) children();
      return;
    case "Each": {
      const list = prop(node, "in", scope);
      if (!Array.isArray(list)) return;
      const name = str(prop(node, "as", scope)) || "item";
      for (const item of list.slice(0, AIDEN_UI_LIMITS.eachIterations)) {
        if (out.iterations <= 0 || out.full) break;
        out.iterations -= 1;
        const local: AidenUiScope = { ...scope, vars: { ...scope.vars, [name]: item } };
        for (const child of node.c ?? []) lines(child, local, out);
      }
      return;
    }
    default:
      children();
  }
}

export function fallbackTextFor(tree: AidenUiNodeV1, scope: AidenUiScope): string {
  const out = new FallbackLines();
  lines(tree, scope, out);
  const text = out.lines.join("\n");
  return text.length > AIDEN_UI_LIMITS.fallbackChars ? `${text.slice(0, AIDEN_UI_LIMITS.fallbackChars - 1)}…` : text;
}
