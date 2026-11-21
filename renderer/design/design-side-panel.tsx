// The side panel at the canvas's right edge: Properties of the selected item,
// the page's Layers, the Code of a selected page or artifact (read only, with
// Copy), and its Tweaks (the Dark switch and the page's own controls). It
// opens with the panel button at the top right or the I key.

import {
  ArrowRight,
  Circle,
  Eye,
  EyeOff,
  File,
  Frame,
  GripVertical,
  Group,
  Image as ImageIcon,
  Lock,
  LockOpen,
  Minus,
  PanelRight,
  PenLine,
  RectangleHorizontal,
  Sparkles,
  StickyNote,
  Type,
  X,
  type LucideIcon,
} from "lucide-react";
import * as React from "react";
import { CopyButton } from "../components/copy-button";
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui";
import { Segmented } from "../components/ui-primitives";
import {
  highlightCode,
  highlightLanguagesVersion,
  loadHighlightLanguage,
  subscribeHighlightLanguages,
} from "../lib/syntax-highlight";
import { cn } from "../lib/ui-utils";
import { useTrailingWindowControlsClearance } from "../lib/window-chrome";
import {
  canDesignGuide,
  DESIGN_CANVAS_LIMITS,
  DESIGN_COLORS,
  DESIGN_WIDTHS,
  isDesignContainer,
  isDesignLine,
  isDesignPrintable,
  type DesignCanvas,
  type DesignColor,
  type DesignFrame,
  type DesignGuide,
  type DesignWidth,
} from "../shared/design-canvas/schema";
import { DesignTweakDark, DesignTweaksEditor, useDesignTweakControls, type DesignTweakOps } from "./design-tweaks-panel";
import { useFrameSource, type DesignReadSource } from "./frame-source";
import { designLayers, type DesignLayer, type DesignLayerPlace } from "./layers-core";
import { designColorVar, designFillVar, DESIGN_COLOR_NAMES } from "./nodes/draw-style";
import { DESIGN_DEFAULT_WIDTH, type DesignFramePatch } from "./nodes/design-node-context";
import { isEscapeKey } from "../lib/dismiss-key";
import { arrangeByDraft, ReorderAnnouncer, scrollParentOf, usePointerReorder, useReorderDraft } from "../lib/reorder-draft";

export type DesignPanelTab = "properties" | "layers" | "code" | "tweaks";

/** The height of the top bar Aiden's own window buttons sit in (h-13). */
const WINDOW_CONTROLS_HEIGHT = 52;

const TABS = [
  { value: "properties", label: "Properties" },
  { value: "layers", label: "Layers" },
  { value: "code", label: "Code" },
  { value: "tweaks", label: "Tweaks" },
] as const satisfies readonly { value: DesignPanelTab; label: string }[];

/** Every tab, in order; a tab remembered from last time is kept only if it is one of these. */
export const DESIGN_PANEL_TABS: readonly DesignPanelTab[] = TABS.map((entry) => entry.value);

/** What a person calls each kind of item. */
export function designKindName(frame: Pick<DesignFrame, "kind" | "shape" | "arrow">): string {
  switch (frame.kind) {
    case "file":
      return "Page";
    case "artifact":
      return "Artifact";
    case "image":
      return "Image";
    case "note":
      return "Note";
    case "group":
      return "Group";
    case "text":
      return "Text";
    case "shape":
      return frame.shape === "oval" ? "Oval" : "Rectangle";
    case "connector":
      return frame.arrow ? "Arrow" : "Line";
    case "stroke":
      return "Drawing";
    case "frame":
      return "Artboard";
  }
}

function kindIcon(frame: DesignFrame): LucideIcon {
  switch (frame.kind) {
    case "file":
      return File;
    case "artifact":
      return Sparkles;
    case "image":
      return ImageIcon;
    case "note":
      return StickyNote;
    case "group":
      return Group;
    case "text":
      return Type;
    case "shape":
      return frame.shape === "oval" ? Circle : RectangleHorizontal;
    case "connector":
      return frame.arrow ? ArrowRight : Minus;
    case "stroke":
      return PenLine;
    case "frame":
      return Frame;
  }
}

/**
 * An item's name in the panel: its title, or what it is. A note or text item
 * that was never renamed goes by its first words.
 */
export function designItemName(frame: DesignFrame): string {
  const title = frame.title.trim();
  if ((frame.kind === "note" || frame.kind === "text") && (title === "" || title === designKindName(frame))) {
    const words = (frame.text ?? "")
      .split("\n")
      .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/u, "").replace(/<\/?u>|\*\*?|\[|\]\([^)]*\)/gu, "").trim())
      .find((line) => line.length > 0);
    if (words) return words.length > 40 ? `${words.slice(0, 39)}…` : words;
  }
  return title || designKindName(frame);
}

export type { DesignFrameSourceResult } from "./frame-source";

export type DesignSidePanelProps = {
  /** Reads a page's file or an artifact's HTML; the canvas saves first, since main reads the stored frame. */
  readSource: DesignReadSource;
  doc: DesignCanvas;
  selection: ReadonlySet<string>;
  tab: DesignPanelTab;
  onTab(tab: DesignPanelTab): void;
  onClose(): void;
  /** How many times a workspace file changed since the canvas opened, so the Code tab reloads. */
  versionOf(path: string | undefined): number;
  onSelect(ids: string[]): void;
  update(id: string, patch: DesignFramePatch, options: { record: boolean }): void;
  moveTo(id: string, x: number, y: number): void;
  resizeTo(id: string, w: number, h: number): void;
  reorder(id: string, targetId: string, place: DesignLayerPlace): void;
  step(id: string, direction: "forward" | "backward"): void;
  /** What the Tweaks tab asks of the canvas. */
  tweaks: DesignTweakOps;
};

export function DesignSidePanel(props: DesignSidePanelProps) {
  const { doc, selection, tab, onTab, onClose } = props;
  const selected = doc.frames.filter((frame) => selection.has(frame.id) && frame.pageId === doc.activePageId);
  // On Linux without a desktop title bar, Aiden's window buttons sit at the top
  // right; the panel starts below them instead of under them.
  const asideRef = React.useRef<HTMLElement>(null);
  const underControls = useTrailingWindowControlsClearance(asideRef) > 0;
  return (
    <aside
      ref={asideRef}
      aria-label="Side panel"
      className="flex h-full w-88 shrink-0 flex-col border-l border-separator bg-background"
      style={underControls ? { paddingTop: WINDOW_CONTROLS_HEIGHT } : undefined}
      data-typing-surface="canvas"
    >
      <div className="flex shrink-0 items-center gap-1 p-2">
        <Segmented value={tab} onValueChange={onTab} options={TABS} aria-label="Side panel" className="min-w-0 flex-1 [&>*]:flex-auto [&>*]:px-2" />
        <Button iconOnly size="small" variant="transparent" aria-label="Close side panel" title="Close (I)" onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {tab === "properties" ? (
          <PropertiesTab {...props} selected={selected} />
        ) : tab === "layers" ? (
          <LayersTab {...props} />
        ) : tab === "code" ? (
          <CodeTab {...props} selected={selected} />
        ) : (
          <TweaksTab {...props} selected={selected} />
        )}
      </div>
    </aside>
  );
}

function PanelNote({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-6 text-center text-small text-secondary">{children}</p>;
}

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  const id = React.useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 border-t border-separator py-3 first:border-t-0">
      <h3 id={id} className="text-small-strong text-secondary">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** The canvas's top-right button that shows or hides the panel. */
export function DesignPanelButton({ open, onToggle }: { open: boolean; onToggle(): void }) {
  return (
    <div className="glass-surface rounded-button p-1 shadow-control">
      <Button
        iconOnly
        variant={open ? "muted" : "transparent"}
        aria-label={open ? "Hide side panel" : "Show side panel"}
        aria-pressed={open}
        aria-keyshortcuts="I"
        title="Side panel (I)"
        onClick={onToggle}
      >
        <PanelRight aria-hidden />
      </Button>
    </div>
  );
}

// ---- Properties -----------------------------------------------------------

function PropertiesTab({
  doc,
  selected,
  update,
  moveTo,
  resizeTo,
}: DesignSidePanelProps & { selected: DesignFrame[] }) {
  if (selected.length === 0) {
    const page = doc.pages.find((entry) => entry.id === doc.activePageId);
    const count = doc.frames.filter((frame) => frame.pageId === doc.activePageId).length;
    return (
      <PanelNote>
        {page?.name ?? "This page"} has {count === 1 ? "1 item" : `${count} items`}. Select one to see its properties.
      </PanelNote>
    );
  }
  if (selected.length > 1) return <PanelNote>{selected.length} items selected. Select one to change it.</PanelNote>;
  const frame = selected[0]!;
  const locked = frame.locked === true;
  const set = (patch: DesignFramePatch) => update(frame.id, patch, { record: true });
  const line = isDesignLine(frame.kind);
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 py-2">
        <span className="min-w-0 flex-1 truncate text-strong text-primary">{designItemName(frame)}</span>
        {designItemName(frame).toLowerCase() !== designKindName(frame).toLowerCase() ? (
          <span className="shrink-0 text-small text-secondary">{designKindName(frame)}</span>
        ) : null}
      </div>
      {locked ? <p className="pb-2 text-small text-secondary">Locked. Unlock it in Layers to change it.</p> : null}

      <PanelSection title={frame.kind === "connector" ? "Position" : "Position and size"}>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="X" value={frame.x} disabled={locked} onCommit={(x) => moveTo(frame.id, x, frame.y)} />
          <NumberField label="Y" value={frame.y} disabled={locked} onCommit={(y) => moveTo(frame.id, frame.x, y)} />
          {frame.kind === "connector" ? null : (
            <>
              <NumberField label="W" title="Width" value={frame.w} min={1} disabled={locked} onCommit={(w) => resizeTo(frame.id, w, frame.h)} />
              <NumberField label="H" title="Height" value={frame.h} min={1} disabled={locked} onCommit={(h) => resizeTo(frame.id, frame.w, h)} />
            </>
          )}
        </div>
      </PanelSection>

      {frame.kind === "file" ? (
        <PanelSection title="Design width">
          <Segmented
            value={String(frame.designWidth ?? DESIGN_DEFAULT_WIDTH)}
            onValueChange={(value) => {
              const width = Number(value) as DesignWidth;
              const from = frame.designWidth ?? DESIGN_DEFAULT_WIDTH;
              // The page keeps its scale on the canvas, so a phone width makes a narrower frame.
              set({ designWidth: width, w: Math.max(DESIGN_CANVAS_LIMITS.minSize, Math.round((frame.w * width) / from)) });
            }}
            options={DESIGN_WIDTHS.map((width) => ({ value: String(width), label: String(width) }))}
            aria-label="Design width"
            disabled={locked}
            className="w-full [&>*]:flex-1"
          />
        </PanelSection>
      ) : null}

      {frame.kind === "frame" || (frame.kind === "shape" && frame.shape === "rect") ? (
        <PanelSection title={frame.kind === "frame" ? "Background" : "Corners"}>
          {frame.kind === "frame" ? (
            <ColorField label="Background" value={frame.fill} swatch={designFillVar} allowNone noneLabel="Plain" disabled={locked} onChange={(fill) => set({ fill })} />
          ) : null}
          <NumberField
            label="Radius"
            value={frame.radius ?? (frame.kind === "frame" ? 4 : 8)}
            min={0}
            max={DESIGN_CANVAS_LIMITS.maxRadius}
            disabled={locked}
            onCommit={(radius) => set({ radius })}
          />
        </PanelSection>
      ) : null}

      {frame.kind === "shape" || line ? (
        <PanelSection title={frame.kind === "shape" ? "Fill and outline" : "Stroke"}>
          {frame.kind === "shape" ? (
            <ColorField label="Fill" value={frame.fill} swatch={designFillVar} allowNone noneLabel="None" disabled={locked} onChange={(fill) => set({ fill })} />
          ) : null}
          <ColorField
            label={frame.kind === "shape" ? "Outline" : "Colour"}
            value={frame.color}
            swatch={designColorVar}
            allowNone={frame.kind === "shape"}
            noneLabel="None"
            disabled={locked}
            onChange={(color) => set({ color })}
          />
          <NumberField
            label="Width"
            title="Stroke width"
            value={frame.strokeWidth ?? 2}
            min={DESIGN_CANVAS_LIMITS.minStrokeWidth}
            max={DESIGN_CANVAS_LIMITS.maxStrokeWidth}
            disabled={locked}
            onCommit={(strokeWidth) => set({ strokeWidth })}
          />
        </PanelSection>
      ) : null}

      {isDesignPrintable(frame.kind) ? (
        <PanelSection title="PDF">
          <Segmented
            value={frame.paper ?? "letter"}
            onValueChange={(paper) => set({ paper: paper === "a4" ? "a4" : undefined })}
            options={[
              { value: "letter", label: "Letter" },
              { value: "a4", label: "A4" },
            ]}
            aria-label="PDF paper"
            disabled={locked}
            className="w-full [&>*]:flex-1"
          />
          <Segmented
            value={frame.printMode ?? "flow"}
            onValueChange={(mode) => set({ printMode: mode === "fixed" ? "fixed" : undefined })}
            options={[
              { value: "flow", label: "Flow" },
              { value: "fixed", label: "Fixed" },
            ]}
            aria-label="PDF layout"
            disabled={locked}
            className="w-full [&>*]:flex-1"
          />
          <p className="text-small text-secondary">
            {frame.printMode === "fixed"
              ? "Laid out at its design width and scaled to fit the paper."
              : "Laid out again to the paper's width."}
          </p>
        </PanelSection>
      ) : null}

      {canDesignGuide(frame.kind) ? (
        <PanelSection title="Layout guide">
          <GuideField value={frame.guide} disabled={locked} onChange={(guide) => set({ guide })} />
        </PanelSection>
      ) : null}
    </div>
  );
}

function NumberField({
  label,
  title,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string;
  title?: string;
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onCommit(value: number): void;
}) {
  const id = React.useId();
  const shown = String(Math.round(value));
  const [draft, setDraft] = React.useState(shown);
  React.useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const parsed = Number(draft.trim());
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(shown);
      return;
    }
    const next = Math.round(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed)));
    setDraft(String(next));
    if (next !== Math.round(value)) onCommit(next);
  };
  return (
    <label htmlFor={id} className="flex min-w-0 items-center gap-2" title={title ?? label}>
      <span className="w-10 shrink-0 text-small text-secondary">{label}</span>
      <Input
        id={id}
        inputMode="numeric"
        aria-label={title ?? label}
        value={draft}
        disabled={disabled}
        className="h-7 min-w-0 px-2 tabular-nums"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (isEscapeKey(event)) {
            event.preventDefault();
            setDraft(shown);
          }
        }}
      />
    </label>
  );
}

function ColorField({
  label,
  value,
  swatch,
  allowNone,
  noneLabel,
  disabled,
  onChange,
}: {
  label: string;
  value: DesignColor | undefined;
  swatch(color: DesignColor): string;
  allowNone: boolean;
  noneLabel: string;
  disabled?: boolean;
  onChange(color: DesignColor | undefined): void;
}) {
  const id = React.useId();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span id={id} className="w-10 shrink-0 text-small text-secondary">
        {label}
      </span>
      <Select
        value={value ?? "none"}
        disabled={disabled}
        onValueChange={(next) => onChange(next === "none" ? undefined : (next as DesignColor))}
      >
        <SelectTrigger size="small" aria-labelledby={id} className="min-w-0 flex-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allowNone ? (
            <SelectItem value="none">
              <span className="flex items-center gap-2">
                <span aria-hidden className="size-3.5 rounded-full bg-popover shadow-control" />
                {noneLabel}
              </span>
            </SelectItem>
          ) : null}
          {DESIGN_COLORS.map((color) => (
            <SelectItem key={color} value={color}>
              <span className="flex items-center gap-2">
                <span aria-hidden className="size-3.5 rounded-full" style={{ background: swatch(color) }} />
                {DESIGN_COLOR_NAMES[color]}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const GUIDE_LABELS: Readonly<Record<DesignGuide | "none", string>> = {
  none: "None",
  "columns-4": "4 columns",
  "columns-8": "8 columns",
  "columns-12": "12 columns",
  "grid-8": "8 px grid",
};

function GuideField({
  value,
  disabled,
  onChange,
}: {
  value: DesignGuide | undefined;
  disabled?: boolean;
  onChange(guide: DesignGuide | undefined): void;
}) {
  return (
    <Select value={value ?? "none"} disabled={disabled} onValueChange={(next) => onChange(next === "none" ? undefined : (next as DesignGuide))}>
      <SelectTrigger size="small" aria-label="Layout guide">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(GUIDE_LABELS) as (DesignGuide | "none")[]).map((guide) => (
          <SelectItem key={guide} value={guide}>
            {GUIDE_LABELS[guide]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ---- Layers ---------------------------------------------------------------

/** Each layer's siblings, the rows it trades places with, in list order. */
function layerGroups(layers: readonly DesignLayer[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const visit = (list: readonly DesignLayer[]) => {
    for (const container of [false, true]) {
      const ids = list.filter((layer) => isDesignContainer(layer.frame.kind) === container).map((layer) => layer.frame.id);
      for (const id of ids) groups.set(id, ids);
    }
    for (const layer of list) visit(layer.children);
  };
  visit(layers);
  return groups;
}

function LayersTab({ doc, selection, onSelect, update, reorder, step }: DesignSidePanelProps) {
  const layers = React.useMemo(() => designLayers(doc), [doc]);
  const groups = React.useMemo(() => layerGroups(layers), [layers]);
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const rowsById = () =>
    new Map([...(listRef.current?.querySelectorAll<HTMLElement>("[data-layer-id]") ?? [])].map((row) => [row.dataset.layerId, row]));
  const keyboard = useReorderDraft({
    groupOf: (id) => groups.get(id) ?? [],
    label: (id) => {
      const frame = doc.frames.find((entry) => entry.id === id);
      return frame ? designItemName(frame) : id;
    },
    handle: (id) => rowsById().get(id)?.querySelector<HTMLElement>("[data-layer-grip]"),
    // One drop is one reorder, so one undo step: behind the row now above it, or in front of the one below.
    onCommit: (order, id) => {
      const at = order.indexOf(id);
      if (at > 0) reorder(id, order[at - 1]!, "below");
      else if (order[1]) reorder(id, order[1], "above");
    },
  });
  const pointer = usePointerReorder({
    targets: (id) => {
      const rows = rowsById();
      return (groups.get(id) ?? []).flatMap((target) => {
        const element = rows.get(target);
        return element ? [{ id: target, element }] : [];
      });
    },
    onDrop: (id, target) => reorder(id, target.id, target.place === "before" ? "above" : "below"),
    scroller: () => scrollParentOf(listRef.current),
  });
  if (layers.length === 0) return <PanelNote>Nothing on this page yet.</PanelNote>;
  const drop = pointer.drag?.over ?? null;

  const row = (layer: DesignLayer, depth: number): React.ReactNode => {
    const { frame } = layer;
    const name = designItemName(frame);
    const Icon = kindIcon(frame);
    const active = selection.has(frame.id);
    return (
      <li key={frame.id}>
        <div
          data-layer-id={frame.id}
          data-dragging={pointer.drag?.id === frame.id ? "" : undefined}
          onPointerDown={(event) => {
            if (renaming === frame.id || (event.target as Element).closest("input")) return;
            pointer.onPointerDown(frame.id, event);
          }}
          className={cn(
            "group/layer relative flex h-8 items-center gap-1 rounded-control pr-1 text-regular data-dragging:opacity-50",
            active ? "bg-list-selection" : "hover:bg-list-hover",
            frame.hidden && "text-secondary",
          )}
          style={{ paddingLeft: 4 + depth * 16 }}
        >
          {drop?.id === frame.id ? (
            <span
              aria-hidden
              className={cn("pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-fill-accent", drop.place === "before" ? "top-0" : "bottom-0")}
            />
          ) : null}
          <Icon aria-hidden className="size-4 shrink-0 text-secondary" />
          {renaming === frame.id ? (
            <LayerNameInput
              name={frame.title}
              onDone={(title) => {
                setRenaming(null);
                if (title !== null && title !== frame.title) update(frame.id, { title }, { record: true });
              }}
            />
          ) : (
            <button
              type="button"
              data-layer-name
              aria-pressed={active}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              title="Double-click to rename. Drag, or ⌥↑ and ⌥↓, to bring forward or send back."
              className="min-w-0 flex-1 cursor-default truncate rounded-control px-1 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              onClick={(event) => {
                if (event.shiftKey || event.metaKey || event.ctrlKey) {
                  const next = new Set(selection);
                  if (next.has(frame.id)) next.delete(frame.id);
                  else next.add(frame.id);
                  onSelect([...next]);
                } else onSelect([frame.id]);
              }}
              onDoubleClick={() => setRenaming(frame.id)}
              onKeyDown={(event) => {
                if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                  event.preventDefault();
                  step(frame.id, event.key === "ArrowUp" ? "forward" : "backward");
                } else if (event.key === "F2") {
                  event.preventDefault();
                  setRenaming(frame.id);
                }
              }}
            >
              {name}
            </button>
          )}
          <Button
            iconOnly
            size="small"
            variant="transparent"
            aria-label={`${frame.hidden ? "Show" : "Hide"} ${name}`}
            aria-pressed={frame.hidden === true}
            title={frame.hidden ? "Show" : "Hide"}
            className={cn(!frame.hidden && "opacity-0 group-hover/layer:opacity-100 focus-visible:opacity-100")}
            onClick={() => update(frame.id, { hidden: frame.hidden ? undefined : true }, { record: true })}
          >
            {frame.hidden ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          </Button>
          <Button
            iconOnly
            size="small"
            variant="transparent"
            aria-label={`${frame.locked ? "Unlock" : "Lock"} ${name}`}
            aria-pressed={frame.locked === true}
            title={frame.locked ? "Unlock" : "Lock"}
            className={cn(!frame.locked && "opacity-0 group-hover/layer:opacity-100 focus-visible:opacity-100")}
            onClick={() => update(frame.id, { locked: frame.locked ? undefined : true }, { record: true })}
          >
            {frame.locked ? <Lock aria-hidden /> : <LockOpen aria-hidden />}
          </Button>
          <Button
            iconOnly
            size="small"
            variant="transparent"
            data-layer-grip
            aria-label={`Move ${name}`}
            aria-keyshortcuts="Space ArrowUp ArrowDown Home End Escape"
            title="Drag, or press Space and the arrow keys, to reorder"
            className="cursor-grab opacity-0 group-hover/layer:opacity-100 focus-visible:opacity-100 data-reorder-held:bg-list-selection data-reorder-held:opacity-100"
            {...keyboard.handleProps(frame.id)}
          >
            <GripVertical aria-hidden />
          </Button>
        </div>
        {layer.children.length > 0 ? (
          <ul aria-label={`In ${name}`}>{arrangeByDraft(layer.children, byFrame, keyboard.draft).map((child) => row(child, depth + 1))}</ul>
        ) : null}
      </li>
    );
  };

  return (
    <>
      <ul ref={listRef} aria-label="Layers" className="flex flex-col py-1 select-none">
        {arrangeByDraft(layers, byFrame, keyboard.draft).map((layer) => row(layer, 0))}
      </ul>
      <ReorderAnnouncer message={keyboard.announcement} />
    </>
  );
}

const byFrame = (layer: DesignLayer) => layer.frame.id;

function LayerNameInput({ name, onDone }: { name: string; onDone(title: string | null): void }) {
  const [draft, setDraft] = React.useState(name);
  const done = React.useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title === null ? null : title.slice(0, DESIGN_CANVAS_LIMITS.titleChars));
  };
  return (
    <Input
      autoFocus
      aria-label="Name"
      value={draft}
      className="h-7 min-w-0 flex-1 px-1.5"
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => finish(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(draft);
        } else if (isEscapeKey(event)) {
          event.preventDefault();
          finish(null);
        }
      }}
    />
  );
}

// ---- Code -----------------------------------------------------------------

function codeLanguage(frame: DesignFrame): string {
  if (frame.kind === "artifact") return "xml";
  const extension = frame.path?.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "css") return "css";
  if (extension === "js" || extension === "mjs") return "javascript";
  return "xml";
}


/** The one selected page or artifact, the frames Code and Tweaks are about. */
function selectedPage(selected: DesignFrame[]): DesignFrame | null {
  return selected.length === 1 && isDesignPrintable(selected[0]!.kind) ? selected[0]! : null;
}

function CodeTab({ readSource, selected, versionOf }: DesignSidePanelProps & { selected: DesignFrame[] }) {
  const frame = selectedPage(selected);
  const current = useFrameSource(readSource, frame, versionOf);
  if (!frame) return <PanelNote>Select a page or an artifact to see its code.</PanelNote>;
  return (
    <div className="flex flex-col gap-2 pt-1">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-small text-secondary">{frame.path ?? designItemName(frame)}</span>
        {current && "text" in current ? <CopyButton text={current.text} label="Copy code" /> : null}
      </div>
      <p className="text-small text-secondary">Read only. Ask Aiden for changes, or open the file in your editor.</p>
      {current === null ? (
        <PanelNote>Loading…</PanelNote>
      ) : "error" in current ? (
        <PanelNote>{current.error}</PanelNote>
      ) : (
        <>
          {current.truncated ? <p className="text-small text-secondary">Showing the first 512 KB.</p> : null}
          <HighlightedCode code={current.text} language={codeLanguage(frame)} />
        </>
      )}
    </div>
  );
}

function HighlightedCode({ code, language }: { code: string; language: string }) {
  const grammars = React.useSyncExternalStore(subscribeHighlightLanguages, highlightLanguagesVersion, highlightLanguagesVersion);
  React.useEffect(() => {
    void loadHighlightLanguage(language);
  }, [language]);
  const html = React.useMemo(() => highlightCode(code, language), [code, language, grammars]);
  return (
    <pre aria-label="Code" tabIndex={0} className="overflow-x-auto rounded-lg bg-well p-3 leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
      {html ? (
        <code className="hljs font-mono text-small" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code className="hljs font-mono text-small">{code}</code>
      )}
    </pre>
  );
}

// ---- Tweaks ---------------------------------------------------------------

function TweaksTab({ readSource, selected, versionOf, tweaks }: DesignSidePanelProps & { selected: DesignFrame[] }) {
  const frame = selectedPage(selected);
  const { source, controls } = useDesignTweakControls(readSource, frame, versionOf);
  if (!frame) return <PanelNote>Select a page or an artifact to change how it looks.</PanelNote>;
  return (
    <div className="flex flex-col">
      <PanelSection title="Appearance">
        <DesignTweakDark frame={frame} ops={tweaks} />
        <p className="text-small text-secondary">
          {frame.kind === "artifact"
            ? "Off, it follows Aiden's appearance."
            : "Works on pages that style a dark look, as the pages Aiden makes do."}
        </p>
      </PanelSection>
      {frame.kind === "file" ? (
        <PanelSection title="This page's tweaks">
          {source === null ? (
            <PanelNote>Loading…</PanelNote>
          ) : "error" in source ? (
            <PanelNote>{source.error}</PanelNote>
          ) : controls.length === 0 ? (
            <p className="text-small text-secondary">This page has no tweaks. Ask Aiden to add some, like an accent colour or a density switch.</p>
          ) : (
            <DesignTweaksEditor frame={frame} controls={controls} ops={tweaks} />
          )}
        </PanelSection>
      ) : null}
    </div>
  );
}
