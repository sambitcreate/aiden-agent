/**
 * The Aiden UI catalog: every component the model may compose, its props,
 * and what it may contain. This is the single source of truth for the
 * compiler (validation), the desktop renderer (component map), and the
 * future native renderers. Prop names avoid the keys Aiden Remote clients
 * treat as private (see `isWireSafeKey`).
 */

export type PropKind =
  | "string"
  | "number"
  | "boolean"
  | "any"
  | "action"
  | "icon"
  | "stateKey"
  | { enum: readonly string[] };

export interface CatalogEntry {
  props: Readonly<Record<string, PropKind>>;
  children: "none" | "text" | "nodes";
  required?: readonly string[];
}

const TONES = { enum: ["primary", "secondary", "tertiary"] } as const;
const STATUS_COLORS = { enum: ["gray", "green", "red", "blue", "warning"] } as const;
const ALIGN = { enum: ["start", "center", "end", "stretch"] } as const;
const VALUE_FORMATS = { enum: ["number", "currency", "percent", "date", "text"] } as const;

export const AIDEN_UI_CATALOG: Readonly<Record<string, CatalogEntry>> = {
  // Layout
  Visual: { props: { title: "string", state: "any" }, children: "nodes" },
  Stack: { props: { gap: "number", align: ALIGN }, children: "nodes" },
  Row: {
    props: { gap: "number", align: ALIGN, wrap: "boolean", justify: { enum: ["start", "center", "end", "between"] } },
    children: "nodes",
  },
  Grid: { props: { columns: "number", gap: "number", minWidth: "number" }, children: "nodes" },
  Card: { props: { title: "string", tone: { enum: ["default", "accent", "green", "red", "warning"] } }, children: "nodes" },
  Section: { props: { title: "string", description: "string" }, children: "nodes" },
  Separator: { props: {}, children: "none" },
  Spacer: { props: { size: "number" }, children: "none" },
  // Text
  Text: {
    props: { tone: TONES, size: { enum: ["small", "regular", "large"] }, weight: { enum: ["regular", "strong"] } },
    children: "text",
  },
  Heading: { props: { level: { enum: ["1", "2", "3"] } }, children: "text" },
  Markdown: { props: {}, children: "text" },
  Code: { props: { lang: "string" }, children: "text" },
  Math: { props: { display: "boolean" }, children: "text" },
  Kbd: { props: {}, children: "text" },
  // Data display
  Stat: {
    props: { label: "string", value: "any", format: VALUE_FORMATS, trend: "number", caption: "string", currency: "string" },
    children: "none",
    required: ["label", "value"],
  },
  Table: { props: { rows: "any", columns: "any", caption: "string" }, children: "none", required: ["rows"] },
  KeyValue: { props: { items: "any" }, children: "none", required: ["items"] },
  List: { props: {}, children: "nodes" },
  ListRow: {
    props: { title: "string", description: "string", icon: "icon", meta: "string", action: "action" },
    children: "none",
    required: ["title"],
  },
  Badge: { props: { color: STATUS_COLORS, icon: "icon" }, children: "text" },
  Callout: { props: { color: STATUS_COLORS, title: "string" }, children: "nodes" },
  Progress: { props: { value: "number", max: "number", label: "string" }, children: "none", required: ["value"] },
  Meter: {
    props: { value: "number", max: "number", label: "string", low: "number", high: "number" },
    children: "none",
    required: ["value"],
  },
  Checklist: { props: { items: "any" }, children: "none", required: ["items"] },
  Timeline: { props: { items: "any" }, children: "none", required: ["items"] },
  Image: { props: { attachment: "string", alt: "string" }, children: "none", required: ["attachment", "alt"] },
  Icon: { props: { name: "icon", tone: TONES }, children: "none", required: ["name"] },
  LinkCard: { props: { url: "string", title: "string", description: "string" }, children: "none", required: ["url", "title"] },
  // Charts
  Chart: {
    props: {
      kind: { enum: ["bar", "line", "area", "pie", "donut", "scatter"] },
      data: "any",
      x: "string",
      y: "any",
      series: "any",
      height: "number",
      stacked: "boolean",
      format: VALUE_FORMATS,
      label: "string",
    },
    children: "none",
    required: ["kind", "data"],
  },
  BarList: {
    props: { items: "any", label: "string", value: "string", format: VALUE_FORMATS },
    children: "none",
    required: ["items"],
  },
  Heatmap: { props: { rows: "any", x: "string", y: "string", value: "string", label: "string" }, children: "none", required: ["rows"] },
  Sparkline: { props: { values: "any", height: "number", label: "string" }, children: "none", required: ["values"] },
  // Input and state
  Segmented: { props: { bind: "stateKey", options: "any", label: "string" }, children: "none", required: ["bind", "options"] },
  Tabs: { props: { bind: "stateKey", options: "any", label: "string" }, children: "none", required: ["bind", "options"] },
  Switch: { props: { bind: "stateKey", label: "string" }, children: "none", required: ["bind", "label"] },
  Checkbox: { props: { bind: "stateKey", label: "string" }, children: "none", required: ["bind", "label"] },
  RadioGroup: { props: { bind: "stateKey", options: "any", label: "string" }, children: "none", required: ["bind", "options"] },
  Select: { props: { bind: "stateKey", options: "any", label: "string" }, children: "none", required: ["bind", "options"] },
  Slider: {
    props: { bind: "stateKey", min: "number", max: "number", step: "number", label: "string", format: VALUE_FORMATS },
    children: "none",
    required: ["bind", "label"],
  },
  TextInput: { props: { bind: "stateKey", label: "string", placeholder: "string" }, children: "none", required: ["bind", "label"] },
  // Actions
  Button: {
    props: { variant: { enum: ["accent", "filled", "muted", "transparent"] }, action: "action", icon: "icon" },
    children: "text",
    required: ["action"],
  },
  ButtonGroup: { props: {}, children: "nodes" },
  // Disclosure
  Disclosure: { props: { title: "string", open: "boolean" }, children: "nodes", required: ["title"] },
  Tooltip: { props: { content: "string" }, children: "nodes", required: ["content"] },
  // Control flow
  Each: { props: { in: "any", as: "string" }, children: "nodes", required: ["in"] },
  If: { props: { test: "any" }, children: "nodes", required: ["test"] },
  Data: { props: { name: "string" }, children: "text", required: ["name"] },
};

/** Lucide icons a visual may name (kebab-case, as in the Lucide docs). No brain glyphs. */
export const AIDEN_UI_ICONS = [
  "activity", "alert-triangle", "archive", "arrow-down", "arrow-right", "arrow-up", "bar-chart", "battery",
  "book-open", "bug", "calendar", "camera", "check", "circle-alert", "circle-check", "circle-x", "clock",
  "cloud", "code", "coffee", "cpu", "credit-card", "database", "dollar-sign", "download", "file-text", "flag",
  "folder", "git-branch", "globe", "graduation-cap", "heart", "home", "image", "info", "leaf", "lightbulb",
  "line-chart", "link", "lock", "mail", "map-pin", "message-square", "minus", "moon", "music", "package",
  "phone", "pie-chart", "plus", "rocket", "search", "server", "settings", "shield", "shopping-cart",
  "sparkles", "star", "sun", "target", "terminal", "thumbs-down", "thumbs-up", "timer", "trending-down",
  "trending-up", "truck", "upload", "user", "users", "video", "wifi", "wrench", "x", "zap",
] as const;

export type AidenUiIconName = (typeof AIDEN_UI_ICONS)[number];

const ICON_SET = new Set<string>(AIDEN_UI_ICONS);

export function isAidenUiIcon(value: unknown): value is AidenUiIconName {
  return typeof value === "string" && ICON_SET.has(value);
}

/** Components whose text children keep their line breaks (code, math, markdown, data). */
export const PRESERVE_WHITESPACE = new Set(["Code", "Markdown", "Math", "Data"]);

/** Components that only draw from data and state and do not render children. */
export const CONTROL_FLOW = new Set(["Each", "If"]);
