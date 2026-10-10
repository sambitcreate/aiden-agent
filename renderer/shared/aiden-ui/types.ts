/**
 * Aiden UI ("Tier A") visual contract: a normalized component tree the model
 * composes from Aiden's own catalog, with expressions kept as data (never
 * code). Key names here are chosen so a tree can cross the Aiden Remote wire
 * without tripping the phones' private-key validators.
 */

export const AIDEN_UI_CATALOG_VERSION = 1;

export const AIDEN_UI_LIMITS = {
  nodes: 2000,
  depth: 24,
  dataBytes: 64 * 1024,
  treeBytes: 256 * 1024,
  perResponse: 8,
  perChat: 60,
  eachIterations: 500,
  stateBytes: 4096,
  fallbackChars: 4000,
} as const;

export type AidenUiBinaryOperator = "+" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||";

export type AidenUiFunctionName = "fmt" | "len" | "sum" | "max" | "min" | "round" | "filter" | "sort";

export type AidenUiExprV1 =
  | { op: "lit"; v: string | number | boolean | null }
  /** `$name`: a `<Data>` binding, a state key, or an `<Each>` local. */
  | { op: "var"; name: string }
  /** `a.b` and `a[b]`. */
  | { op: "get"; of: AidenUiExprV1; key: AidenUiExprV1 }
  | { op: "bin"; o: AidenUiBinaryOperator; l: AidenUiExprV1; r: AidenUiExprV1 }
  | { op: "not"; e: AidenUiExprV1 }
  | { op: "if"; test: AidenUiExprV1; then: AidenUiExprV1; else: AidenUiExprV1 }
  | { op: "call"; fn: AidenUiFunctionName; a: AidenUiExprV1[] }
  /** A literal object or array prop (options, columns, rows written inline). */
  | { op: "json"; v: unknown };

export type AidenUiActionV1 =
  | { act: "send"; text: AidenUiExprV1 }
  | { act: "set"; key: string; value: AidenUiExprV1 }
  | { act: "open"; url: AidenUiExprV1 }
  | { act: "copy"; text: AidenUiExprV1 };

export type AidenUiPropValueV1 = AidenUiExprV1 | AidenUiActionV1;

export interface AidenUiNodeV1 {
  /** Catalog component name, or `#text` / `#expr` for inline content. */
  t: string;
  /** Stable key: the node's index path from the root (`"0.2.1"`). */
  k: string;
  p?: Record<string, AidenUiPropValueV1>;
  c?: AidenUiNodeV1[];
  /** Text for `#text`. */
  s?: string;
  /** Expression for `#expr`. */
  e?: AidenUiExprV1;
}

export interface ChatUiVisualV1 {
  version: 1;
  kind: "ui";
  id: string;
  /** Public timeline id (`call-N`) of the render_ui call that produced it. */
  toolCallId?: string;
  title: string;
  catalogVersion: number;
  tree: AidenUiNodeV1;
  /**
   * The visual's `<Data>` bindings as one JSON object string. Kept as a string
   * so model-chosen data keys are never wire keys.
   */
  dataJson?: string;
  /** Last local state snapshot (bound inputs, setState), at most 4 KiB. */
  state?: Record<string, unknown>;
  /** Plain-text rendering for memory, the CLI, and clients without a renderer. */
  fallbackText: string;
  layout?: "wide";
}

export type AidenUiDiagnosticCode =
  | "unknown_element"
  | "unknown_prop"
  | "invalid_literal"
  | "invalid_expression"
  | "limit"
  | "recovered"
  | "data_invalid"
  | "bad_child";

export interface AidenUiDiagnostic {
  code: AidenUiDiagnosticCode;
  message: string;
  /** Element name or node key the diagnostic refers to. */
  at?: string;
}
