import * as React from "react";
import { evaluate, type AidenUiScope } from "../../shared/aiden-ui/evaluate";
import type { AidenUiActionV1, AidenUiExprV1, AidenUiNodeV1, AidenUiPropValueV1 } from "../../shared/aiden-ui/types";

/** What a catalog component may ask the block to do. */
export interface AidenUiRenderContext {
  /** Evaluation scope: data bindings, state, and any `<Each>` locals. */
  scope: AidenUiScope;
  draft: boolean;
  state: Readonly<Record<string, unknown>>;
  setState: (key: string, value: unknown) => void;
  runAction: (action: AidenUiActionV1, scope: AidenUiScope) => void;
  /** Image attachments of the message, by id, as data URLs. */
  attachmentSource: (id: string) => string | undefined;
  /** Renders child nodes in a (possibly extended) scope. */
  renderChildren: (nodes: readonly AidenUiNodeV1[] | undefined, scope?: AidenUiScope) => React.ReactNode;
}

export const AidenUiContext = React.createContext<AidenUiRenderContext | null>(null);

export function isExpr(value: AidenUiPropValueV1 | undefined): value is AidenUiExprV1 {
  return Boolean(value) && typeof value === "object" && "op" in value;
}

export function isAction(value: AidenUiPropValueV1 | undefined): value is AidenUiActionV1 {
  return Boolean(value) && typeof value === "object" && "act" in value;
}

/** Reads a prop of `node` in `scope`. */
export function readProp(node: AidenUiNodeV1, name: string, scope: AidenUiScope): unknown {
  const value = node.p?.[name];
  return isExpr(value) ? evaluate(value, scope) : undefined;
}

export function asString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

export function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export interface NormalizedOption {
  /** String identity for primitives that only take string values. */
  key: string;
  value: unknown;
  label: string;
}

/** Options may be `[{value,label}]`, plain strings, or numbers; values keep their type. */
export function normalizeOptions(raw: unknown): NormalizedOption[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const options: NormalizedOption[] = [];
  for (const entry of raw.slice(0, 50)) {
    const record = asRecord(entry);
    const value = typeof entry === "object" && entry !== null ? record.value : entry;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    const key = `${typeof value}:${String(value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = asString(typeof entry === "object" && entry !== null ? record.label ?? value : value);
    options.push({ key, value, label: label || String(value) });
  }
  return options;
}

export function optionKey(options: readonly NormalizedOption[], value: unknown): string {
  return options.find((option) => option.value === value)?.key ?? "";
}
