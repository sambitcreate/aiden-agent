import { evaluate, formatValue, truthy, type AidenUiScope } from "./evaluate.js";
import { ownRecord } from "./own.js";
import { isExpr } from "./props.js";
import { AIDEN_UI_LIMITS, type AidenUiNodeV1 } from "./types.js";

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
const SKIPPED = new Set([
  "Segmented",
  "Tabs",
  "Switch",
  "Checkbox",
  "RadioGroup",
  "Select",
  "Slider",
  "TextInput",
  "Separator",
  "Spacer",
]);
/** Every visited node and every expanded item costs one unit. Real visuals stay far below this. */
const WORK_BUDGET = AIDEN_UI_LIMITS.nodes * 8;
/** Loop iterations across one fallback (nested loops share it). */
const ITERATION_BUDGET = AIDEN_UI_LIMITS.eachIterations * 4;

type ValueFormat = "number" | "currency" | "percent" | "date" | "text";

export interface FallbackTextOptions {
  /**
   * Also print each chart's data as a table under its summary line. For
   * readers that see only the text (a phone paired to `aiden serve`), where
   * the chart itself is never drawn.
   */
  chartTables?: boolean;
  /**
   * Write each table row as one plain line of `Label: value` pairs joined by
   * ` · ` instead of Markdown pipes, for readers that show the text as-is in
   * a proportional font (a phone's visual row), where pipes would show raw
   * and space-padded columns could never line up.
   */
  plainTables?: boolean;
}

/** A plain table cell is clipped to this many characters so one long cell cannot make its row unreadable. */
const MAX_PLAIN_CELL = 40;
/** The latest values listed for a sparkline; an older first value is kept before them. */
const MAX_SPARKLINE_VALUES = 30;
/** A chart, sparkline or heatmap label is one line of at most this many characters. */
const MAX_CHART_LABEL = 120;
/** A plain table row is clipped to this many characters, so a table of many columns stays readable on a phone. */
const MAX_PLAIN_ROW = 400;

class FallbackLines {
  readonly lines: string[] = [];
  chartTables = false;
  plainTables = false;
  /** Length of `lines.join("\n")`, kept as lines are added. */
  private size = 0;
  private work = WORK_BUDGET;
  iterations = ITERATION_BUDGET;
  private prefix = "";
  /** Cells already cleaned in this fallback, by how they were cleaned, then by their text. */
  readonly cells = new Map<string, Map<string, string>>();

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
  if (typeof value === "number" && format !== "text")
    return formatValue(value, "number", scope.locale);
  return str(value);
}

/** Own entries only: a model-written column or label key never reads an inherited member. */
const record = ownRecord;

function inline(node: AidenUiNodeV1, scope: AidenUiScope): string {
  if (node.t === "#text") return node.s ?? "";
  if (node.t === "#expr") return node.e ? str(evaluate(node.e, scope)) : "";
  return (node.c ?? []).map((child) => inline(child, scope)).join("");
}

// Unicode direction marks, embeddings, overrides and isolates, which could reorder
// the rest of a cell's line, and characters drawn as nothing that could hide or
// split a word: the zero-width space, the word joiner and invisible operators
// U+2060-U+2064, the BOM, the interlinear annotation marks U+FFF9-U+FFFB, and a
// lone half of a surrogate pair. The zero-width joiner and non-joiner stay: they
// shape emoji and the spelling of Persian and Indic words.
const INVISIBLE_IN_CELL =
  /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]|\p{Cs}/gu;

const SPACE_RUN_IN_CELL = /[\p{Cc}\s]+/gu;

/** The first `max` UTF-16 units of `text`, never ending halfway through a character. */
export function clipUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** UTF-16 units read at a time by {@link cleanPrefix}. */
const CLEAN_SLICE = 1024;

/**
 * The start of `text` with every match of `hidden` removed and, when `spaces`
 * is given, each run of its matches made one space, as replacing them in the
 * whole text would give. `text` is read in slices that never split a
 * character, and reading stops once more than `keep` units are kept, so the
 * cost follows the text actually needed: removed characters never count
 * toward `keep`, and nothing past it is read once it is reached. Both
 * patterns must be global and `hidden` must match single characters.
 */
export function cleanPrefix(text: string, hidden: RegExp, keep: number, spaces?: RegExp): string {
  let kept = "";
  for (let start = 0; start < text.length && kept.length <= keep; ) {
    let end = Math.min(start + CLEAN_SLICE, text.length);
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    // Keep a surrogate pair in one slice; a lone high surrogate stays alone.
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end += 1;
    let piece = text.slice(start, end).replace(hidden, "");
    start = end;
    if (spaces) {
      piece = piece.replace(spaces, " ");
      // A run cut by the slice edge is still one run.
      if (piece.startsWith(" ") && kept.endsWith(" ")) piece = piece.slice(1);
    }
    kept += piece;
  }
  return kept;
}

/**
 * A table cell on one line, without control, direction or invisible characters
 * (a line or paragraph separator becomes a space), and clipped (nothing past
 * `max` is kept). Characters are removed before the cell is clipped, so they
 * never use up its length, and the clip never ends inside a character.
 *
 * Only as much of the cell is read as the clip can show, and a cell already
 * cleaned the same way in the same fallback is reused, so a long cell that
 * many columns point at is read once, not once per column. `escapePipes`
 * escapes the kept text's pipes for a Markdown table.
 */
function cleanCell(text: string, max: number, out: FallbackLines, escapePipes = false): string {
  const how = `${max}${escapePipes ? "|" : ""}`;
  let cleaned = out.cells.get(how);
  if (!cleaned) out.cells.set(how, (cleaned = new Map()));
  const known = cleaned.get(text);
  if (known !== undefined) return known;
  // Past 2 × max + 2 units, at least max + 1 characters are left after trimming
  // the one space a collapsed run can leave at either end, so the clip is decided.
  const units = Math.min(max, AIDEN_UI_LIMITS.fallbackChars + 1);
  const flat = clipUnits(
    cleanPrefix(text, INVISIBLE_IN_CELL, units * 2 + 2, SPACE_RUN_IN_CELL).trim(),
    AIDEN_UI_LIMITS.fallbackChars + 1,
  );
  const characters = [...flat];
  const clipped = characters.length > max ? `${characters.slice(0, max - 1).join("")}…` : flat;
  // Cells are clipped before escaping: nothing past the cap is ever kept.
  const cell = escapePipes ? clipped.replace(/\|/gu, "\\|") : clipped;
  cleaned.set(text, cell);
  return cell;
}

function plainCell(text: string, out: FallbackLines): string {
  return cleanCell(text, MAX_PLAIN_CELL, out);
}

/** A chart's own label on one line, without control or direction characters. */
function chartLabel(node: AidenUiNodeV1, scope: AidenUiScope, out: FallbackLines): string {
  return cleanCell(str(prop(node, "label", scope)), MAX_CHART_LABEL, out);
}

/** One table row as plain `Label: value` pairs, readable in any font with nothing to line up. */
function plainRow(labels: readonly string[], cells: readonly string[]): string {
  const row = cells
    .map((cell, index) => {
      const value = cell || "—";
      return labels[index] ? `${labels[index]}: ${value}` : value;
    })
    .join(" · ");
  const characters = [...row];
  return characters.length > MAX_PLAIN_ROW
    ? `${characters.slice(0, MAX_PLAIN_ROW - 1).join("")}…`
    : row;
}

function table(rows: unknown, columns: unknown, scope: AidenUiScope, out: FallbackLines): void {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const columnList: Record<string, unknown>[] =
    Array.isArray(columns) && columns.length
      ? columns.map((column) => record(column))
      : Object.keys(record(rows[0])).map((key) => ({ key, label: key }));
  const header = columnList.map((column) => str(column.label) || str(column.key));
  const labels = out.plainTables ? header.map((cell) => plainCell(cell, out)) : [];
  if (!out.plainTables) {
    out.push(`| ${header.map((cell) => markdownCell(cell, out)).join(" | ")} |`);
    out.push(`| ${header.map(() => "---").join(" | ")} |`);
  }
  for (const row of rows.slice(0, MAX_TABLE_ROWS)) {
    // A row is kept whole or not at all, so every kept line is complete.
    const cells: string[] = [];
    for (const column of columnList) {
      if (!out.take()) return;
      const value = formatted(record(row)[str(column.key)], column.format, scope);
      cells.push(out.plainTables ? plainCell(value, out) : markdownCell(value, out));
    }
    out.push(out.plainTables ? plainRow(labels, cells) : `| ${cells.join(" | ")} |`);
  }
  if (rows.length > MAX_TABLE_ROWS) out.push(`(${rows.length - MAX_TABLE_ROWS} more rows)`);
}

/** A Markdown table cell: one line, no control or direction characters, its own pipes escaped. */
function markdownCell(text: string, out: FallbackLines): string {
  return cleanCell(text, AIDEN_UI_LIMITS.fallbackChars + 1, out, true);
}

/**
 * A chart's columns as the chart reads them: its x field, then its series
 * (`series`, else `y`, else the first other numeric field), in the chart's
 * format. A scatter chart with no `x` keeps every numeric field, since its
 * points need at least two.
 */
function chartColumns(
  rows: unknown[],
  kind: string,
  x: unknown,
  y: unknown,
  series: unknown,
  format: unknown,
): Record<string, unknown>[] {
  const first = record(rows[0]);
  const xKey = str(x) || Object.keys(first).find((key) => typeof first[key] === "string") || "";
  const allNumeric = kind === "scatter" && !str(x);
  const keys: { key: string; label: string }[] = allNumeric
    ? Object.keys(first)
        .filter((key) => key !== xKey && typeof first[key] === "number")
        .map((key) => ({ key, label: key }))
    : Array.isArray(series) && series.length
      ? series.map((entry) =>
          typeof entry === "string"
            ? { key: entry, label: entry }
            : {
                key: str(record(entry).key),
                label: str(record(entry).label) || str(record(entry).key),
              },
        )
      : Array.isArray(y)
        ? y
            .filter((key): key is string => typeof key === "string")
            .map((key) => ({ key, label: key }))
        : typeof y === "string" && y
          ? [{ key: y, label: y }]
          : Object.keys(first)
              .filter((key) => key !== xKey && typeof first[key] === "number")
              .slice(0, 1)
              .map((key) => ({ key, label: key }));
  const values = keys
    .filter((entry) => entry.key && entry.key !== xKey)
    .slice(0, 8)
    .map((entry) => ({ ...entry, ...(format !== undefined ? { format } : {}) }));
  return [...(xKey ? [{ key: xKey, label: xKey, format: "text" }] : []), ...values];
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
      const value = formatted(
        prop(node, "value", scope),
        prop(node, "format", scope) as ValueFormat,
        scope,
      );
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
        out.push(
          `- ${time ? `${time}: ` : ""}${str(entry.title)}${description ? ` — ${description}` : ""}`,
        );
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
      const label = chartLabel(node, scope, out);
      const kind = str(prop(node, "kind", scope));
      out.push(
        `${label || "Chart"} (${kind ? `${kind} chart` : "chart"}, ${Array.isArray(data) ? data.length : 0} points)`,
      );
      if (out.chartTables && Array.isArray(data) && data.length) {
        table(
          data,
          chartColumns(
            data,
            kind,
            prop(node, "x", scope),
            prop(node, "y", scope),
            prop(node, "series", scope),
            prop(node, "format", scope),
          ),
          scope,
          out,
        );
      }
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
        out.push(
          `${str(record(item)[labelKey])}: ${formatted(record(item)[valueKey], format, scope)}`,
        );
      }
      return;
    }
    case "Sparkline": {
      const label = chartLabel(node, scope, out);
      const values = prop(node, "values", scope);
      const numbers = Array.isArray(values)
        ? values.filter(
            (value): value is number => typeof value === "number" && Number.isFinite(value),
          )
        : [];
      if (out.chartTables && numbers.length) {
        // A trend's latest values matter most: past the cap, the first value
        // is kept for where it started, then the latest ones, with the count.
        // The "…" stands for at least two values; one would fit in its place.
        const number = (value: number) => formatValue(value, "number", scope.locale);
        const clipped = numbers.length > MAX_SPARKLINE_VALUES + 2;
        const shown = clipped
          ? `${number(numbers[0]!)}, …, ${numbers.slice(-MAX_SPARKLINE_VALUES).map(number).join(", ")}`
          : numbers.map(number).join(", ");
        const count = clipped ? `, ${numbers.length} values` : "";
        out.push(`${label || "Trend"} (sparkline${count}): ${shown}`);
      } else if (label) {
        out.push(`${label} (sparkline)`);
      }
      return;
    }
    case "Heatmap": {
      const label = chartLabel(node, scope, out);
      const rows = prop(node, "rows", scope);
      if (out.chartTables && Array.isArray(rows) && rows.length) {
        out.push(`${label || "Heatmap"} (heatmap, ${rows.length} cells)`);
        // Each cell is named by its own row and column, as the drawn heatmap
        // labels it, rather than by the field names that hold them.
        const field = (name: string) => str(prop(node, name, scope)) || name;
        const [x, y, value] = [field("x"), field("y"), field("value")];
        for (const row of rows.slice(0, MAX_TABLE_ROWS)) {
          if (!out.take()) return;
          const cell = record(row);
          const where = [cell[y], cell[x]]
            .map((part) => plainCell(formatted(part, "text", scope), out))
            .filter(Boolean)
            .join(" · ");
          out.push(
            `${where || "—"}: ${plainCell(formatted(cell[value], undefined, scope), out) || "—"}`,
          );
        }
        if (rows.length > MAX_TABLE_ROWS) out.push(`(${rows.length - MAX_TABLE_ROWS} more cells)`);
      } else if (label) {
        out.push(`${label} (heatmap)`);
      }
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

export function fallbackTextFor(
  tree: AidenUiNodeV1,
  scope: AidenUiScope,
  options: FallbackTextOptions = {},
): string {
  const out = new FallbackLines();
  out.chartTables = options.chartTables === true;
  out.plainTables = options.plainTables === true;
  lines(tree, scope, out);
  const text = out.lines.join("\n");
  return text.length > AIDEN_UI_LIMITS.fallbackChars
    ? `${clipUnits(text, AIDEN_UI_LIMITS.fallbackChars - 1)}…`
    : text;
}
