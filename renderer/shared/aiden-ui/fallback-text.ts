import { evaluate, formatValue, truthy, type AidenUiScope } from "./evaluate.js";
import { AIDEN_UI_LIMITS, type AidenUiExprV1, type AidenUiNodeV1, type AidenUiPropValueV1 } from "./types.js";

/**
 * Plain-text rendering of a visual at its initial state: Markdown-ish lines
 * for memory, the CLI, and clients that cannot draw the tree. Inputs are
 * skipped; their effect shows through the values they drive.
 */

const MAX_TABLE_ROWS = 20;
const SKIPPED = new Set(["Segmented", "Tabs", "Switch", "Checkbox", "RadioGroup", "Select", "Slider", "TextInput", "Separator", "Spacer"]);

type ValueFormat = "number" | "currency" | "percent" | "date" | "text";

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

function table(rows: unknown, columns: unknown, scope: AidenUiScope): string[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const columnList: Record<string, unknown>[] = Array.isArray(columns) && columns.length
    ? columns.map((column) => record(column))
    : Object.keys(record(rows[0])).map((key) => ({ key, label: key }));
  const header = columnList.map((column) => str(column.label) || str(column.key));
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const row of rows.slice(0, MAX_TABLE_ROWS)) {
    const cells = columnList.map((column) => {
      const key = str(column.key);
      return formatted(record(row)[key], column.format, scope).replace(/\|/gu, "\\|");
    });
    lines.push(`| ${cells.join(" | ")} |`);
  }
  if (rows.length > MAX_TABLE_ROWS) lines.push(`(${rows.length - MAX_TABLE_ROWS} more rows)`);
  return lines;
}

function lines(node: AidenUiNodeV1, scope: AidenUiScope, budget: { each: number }): string[] {
  const children = () => (node.c ?? []).flatMap((child) => lines(child, scope, budget));
  if (SKIPPED.has(node.t)) return [];
  switch (node.t) {
    case "#text":
    case "#expr": {
      const text = inline(node, scope).trim();
      return text ? [text] : [];
    }
    case "Text":
    case "Markdown":
    case "Code":
    case "Math":
    case "Kbd":
    case "Badge": {
      const text = inline(node, scope).trim();
      return text ? [text] : [];
    }
    case "Heading": {
      const level = Number(str(prop(node, "level", scope)) || "2");
      const text = inline(node, scope).trim();
      return text ? [`${"#".repeat(Math.min(Math.max(level, 1), 3))} ${text}`] : [];
    }
    case "Stat": {
      const label = str(prop(node, "label", scope));
      const value = formatted(prop(node, "value", scope), prop(node, "format", scope) as ValueFormat, scope);
      const caption = str(prop(node, "caption", scope));
      return [`${label}: ${value}${caption ? ` (${caption})` : ""}`];
    }
    case "Table":
      return table(prop(node, "rows", scope), prop(node, "columns", scope), scope);
    case "KeyValue": {
      const items = prop(node, "items", scope);
      return Array.isArray(items) ? items.map((item) => `${str(record(item).label)}: ${str(record(item).value)}`) : [];
    }
    case "ListRow": {
      const title = str(prop(node, "title", scope));
      const description = str(prop(node, "description", scope));
      const meta = str(prop(node, "meta", scope));
      return [`- ${title}${description ? ` — ${description}` : ""}${meta ? ` (${meta})` : ""}`];
    }
    case "Checklist": {
      const items = prop(node, "items", scope);
      return Array.isArray(items) ? items.map((item) => `- [${truthy(record(item).done) ? "x" : " "}] ${str(record(item).label)}`) : [];
    }
    case "Timeline": {
      const items = prop(node, "items", scope);
      if (!Array.isArray(items)) return [];
      return items.map((item) => {
        const entry = record(item);
        const time = str(entry.time);
        const description = str(entry.description);
        return `- ${time ? `${time}: ` : ""}${str(entry.title)}${description ? ` — ${description}` : ""}`;
      });
    }
    case "Callout": {
      const title = str(prop(node, "title", scope));
      const body = children();
      return [title, ...body].filter(Boolean).map((line) => `> ${line}`);
    }
    case "Progress":
    case "Meter": {
      const label = str(prop(node, "label", scope));
      const value = prop(node, "value", scope);
      const max = prop(node, "max", scope);
      return [`${label || node.t}: ${str(value)}${max !== undefined ? ` of ${str(max)}` : ""}`];
    }
    case "Chart": {
      const data = prop(node, "data", scope);
      const label = str(prop(node, "label", scope));
      const kind = str(prop(node, "kind", scope));
      return [`${label || "Chart"} (${kind ? `${kind} chart` : "chart"}, ${Array.isArray(data) ? data.length : 0} points)`];
    }
    case "BarList": {
      const items = prop(node, "items", scope);
      const labelKey = str(prop(node, "label", scope)) || "label";
      const valueKey = str(prop(node, "value", scope)) || "value";
      const format = prop(node, "format", scope);
      return Array.isArray(items)
        ? items.map((item) => `${str(record(item)[labelKey])}: ${formatted(record(item)[valueKey], format, scope)}`)
        : [];
    }
    case "Sparkline":
    case "Heatmap": {
      const label = str(prop(node, "label", scope));
      return label ? [`${label} (${node.t.toLowerCase()})`] : [];
    }
    case "Button": {
      const text = inline(node, scope).trim();
      return text ? [`[${text}]`] : [];
    }
    case "Image":
      return [`[Image: ${str(prop(node, "alt", scope))}]`];
    case "Icon":
      return [];
    case "LinkCard":
      return [`${str(prop(node, "title", scope))} (${str(prop(node, "url", scope))})`];
    case "Card":
    case "Section":
    case "Disclosure": {
      const title = str(prop(node, "title", scope));
      return [...(title ? [`**${title}**`] : []), ...children()];
    }
    case "If":
      return truthy(prop(node, "test", scope)) ? children() : [];
    case "Each": {
      const list = prop(node, "in", scope);
      if (!Array.isArray(list)) return [];
      const name = str(prop(node, "as", scope)) || "item";
      const out: string[] = [];
      for (const item of list.slice(0, AIDEN_UI_LIMITS.eachIterations)) {
        if (budget.each <= 0) break;
        budget.each -= 1;
        const local: AidenUiScope = { ...scope, vars: { ...scope.vars, [name]: item } };
        out.push(...(node.c ?? []).flatMap((child) => lines(child, local, budget)));
      }
      return out;
    }
    default:
      return children();
  }
}

export function fallbackTextFor(tree: AidenUiNodeV1, scope: AidenUiScope): string {
  const text = lines(tree, scope, { each: AIDEN_UI_LIMITS.eachIterations * 4 }).join("\n");
  return text.length > AIDEN_UI_LIMITS.fallbackChars ? `${text.slice(0, AIDEN_UI_LIMITS.fallbackChars - 1)}…` : text;
}
