import * as React from "react";
import { evaluate, type AidenUiScope } from "../../shared/aiden-ui/evaluate";
import { ownRecord } from "../../shared/aiden-ui/own";
import { asString, isAction, isExpr } from "../../shared/aiden-ui/props";
import type { AidenUiActionV1, AidenUiNodeV1 } from "../../shared/aiden-ui/types";

/** What a catalog component may ask the block to do. */
export interface AidenUiRenderContext {
  /** Evaluation scope: data bindings, state, and any `<Each>` locals. */
  scope: AidenUiScope;
  draft: boolean;
  /** Shared by one whole render, so nested loops cannot multiply past it. */
  budget: { iterations: number; nodes: number };
  state: Readonly<Record<string, unknown>>;
  setState: (key: string, value: unknown) => void;
  runAction: (action: AidenUiActionV1, scope: AidenUiScope) => void;
  /** Image attachments of the message, by id, as data URLs. */
  attachmentSource: (id: string) => string | undefined;
  /** Renders child nodes in a (possibly extended) scope. */
  renderChildren: (nodes: readonly AidenUiNodeV1[] | undefined, scope?: AidenUiScope) => React.ReactNode;
}

export const AidenUiContext = React.createContext<AidenUiRenderContext | null>(null);

export { asString, isAction, isExpr };

/** Reads a prop of `node` in `scope`. */
export function readProp(node: AidenUiNodeV1, name: string, scope: AidenUiScope): unknown {
  const value = node.p?.[name];
  return isExpr(value) ? evaluate(value, scope) : undefined;
}


export function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

/** Own entries only, so a model-written key never reads an inherited member such as `constructor`. */
export const asRecord = ownRecord;

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
