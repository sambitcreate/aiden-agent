// One stack of the surfaces open over the page, so a key handler can ask
// whether something sits above it instead of searching the DOM for open
// dialogs. Radix overlays in `components/ui.tsx` join it while open and keep
// handling their own Escape; custom layers pass `onEscape` and hear an Escape
// only while nothing covers them.
import * as React from "react";
import { isDismissKey } from "./dismiss-key";

/**
 * - `modal`: a dialog that owns the window (Dialog, AlertDialog, the command palette, onboarding).
 * - `menu`: a DropdownMenu, ContextMenu or Select.
 * - `popover`: a Popover.
 * - `sheet`: a custom overlay over the page, like the compact sidebar.
 * - `panel`: a docked surface that stays open beside the page (Quick View, tools, the Bot panel).
 *
 * Layers stack in three tiers, whatever order they opened in: panels, then
 * sheets, then the Radix overlays (which also sit above a sheet on screen).
 * Within a tier the newer layer covers the older, except that panels never
 * cover each other: focus decides which one an Escape closes.
 */
export type LayerKind = "modal" | "menu" | "popover" | "sheet" | "panel";

export interface Layer {
  readonly kind: LayerKind;
  /** Tells one layer apart from others of its kind, like the command palette among dialogs. */
  readonly name?: string;
}

export interface LayerOptions {
  name?: string;
  /** Called for an unhandled, non-composing Escape while nothing covers the layer; call `preventDefault()` when it acted. */
  onEscape?: (event: KeyboardEvent) => void;
}

export interface LayerHandle {
  /** Open, with nothing covering it. */
  isTop(): boolean;
  /** Leaves the stack; calling it again does nothing. */
  close(): void;
}

interface Entry extends Layer {
  order: number;
  onEscape?: (event: KeyboardEvent) => void;
}

const stack: Entry[] = [];
let opened = 0;
let escapeLayers = 0;

const TIER: Record<LayerKind, number> = { panel: 0, sheet: 1, menu: 2, popover: 2, modal: 2 };

function covers(other: Entry, layer: Entry): boolean {
  if (other === layer || other.kind === "panel") return false;
  const above = TIER[other.kind] - TIER[layer.kind];
  return above > 0 || (above === 0 && other.order > layer.order);
}

function uncovered(layer: Entry): boolean {
  return !stack.some((other) => covers(other, layer));
}

function onDocumentKeyDown(event: KeyboardEvent): void {
  // Radix marks the Escape it handles, so an open Radix layer stops it here.
  if (!isDismissKey(event)) return;
  for (const layer of [...stack].reverse()) {
    if (!layer.onEscape || !uncovered(layer)) continue;
    layer.onEscape(event);
    if (event.defaultPrevented) return;
  }
}

export function openLayer(kind: LayerKind, options: LayerOptions = {}): LayerHandle {
  const layer: Entry = { kind, name: options.name, order: (opened += 1), onEscape: options.onEscape };
  stack.push(layer);
  if (layer.onEscape && (escapeLayers += 1) === 1) document.addEventListener("keydown", onDocumentKeyDown);
  let closed = false;
  return {
    isTop: () => !closed && uncovered(layer),
    close: () => {
      if (closed) return;
      closed = true;
      stack.splice(stack.indexOf(layer), 1);
      if (layer.onEscape && (escapeLayers -= 1) === 0) document.removeEventListener("keydown", onDocumentKeyDown);
    },
  };
}

/** Whether any open layer, or one that `match` accepts, is on the stack. */
export function hasOpenLayer(match?: (layer: Layer) => boolean): boolean {
  return match ? stack.some(match) : stack.length > 0;
}

/** Dialogs, menus and popovers: the Radix overlays that own the keyboard while open. */
export function isOverlayLayer(layer: Layer): boolean {
  return layer.kind === "modal" || layer.kind === "menu" || layer.kind === "popover";
}

/**
 * Keeps a layer on the stack while `open`. The result is stable; read
 * `isTop()` when a key arrives, not during render.
 *
 * Order within a tier is the order layers joined, and React runs layout
 * effects child first: a layer nested in another that opens in the same
 * commit (a Popover rendered open inside a Dialog that is opening) joins
 * first and sits below its parent. Layers that open one after another, the
 * usual case, are ordered correctly.
 */
export function useLayer(open: boolean, kind: LayerKind, options: LayerOptions = {}): Pick<LayerHandle, "isTop"> {
  const { name, onEscape } = options;
  const onEscapeRef = React.useRef(onEscape);
  React.useLayoutEffect(() => {
    onEscapeRef.current = onEscape;
  });
  const listens = onEscape !== undefined;
  const handleRef = React.useRef<LayerHandle | null>(null);
  React.useLayoutEffect(() => {
    if (!open) return;
    const handle = openLayer(kind, {
      name,
      onEscape: listens ? (event) => onEscapeRef.current?.(event) : undefined,
    });
    handleRef.current = handle;
    return () => {
      handle.close();
      if (handleRef.current === handle) handleRef.current = null;
    };
  }, [open, kind, name, listens]);
  return React.useMemo(() => ({ isTop: () => handleRef.current?.isTop() ?? false }), []);
}
