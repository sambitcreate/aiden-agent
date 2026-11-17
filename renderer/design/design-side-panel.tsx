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
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from "../components/ui";
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
  isDesignLine,
  isDesignPrintable,
  type DesignCanvas,
  type DesignColor,
  type DesignFrame,
  type DesignGuide,
  type DesignWidth,
} from "../shared/design-canvas/schema";
import {
  extractDesignTweakControls,
  readDesignTweak,
  withDesignTweak,
  type DesignTweakControl,
} from "../shared/design-canvas/tweaks";
import { designLayers, type DesignLayer, type DesignLayerPlace } from "./layers-core";
import { designColorVar, designFillVar, DESIGN_COLOR_NAMES } from "./nodes/draw-style";
import { DESIGN_DEFAULT_WIDTH, type DesignFramePatch } from "./nodes/design-node-context";

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

/** `designCanvas:source`'s answer. */
export type DesignFrameSourceResult =
  | { text: string; truncated: boolean }
  /** `unsaved`: the canvas couldn't be saved, so main's copy of the frame is older than the screen. */
  | { error: "unavailable" | "missing" | "unsaved" };

export type DesignSidePanelProps = {
  /** Reads a page's file or an artifact's HTML; the canvas saves first, since main reads the stored frame. */
  readSource(frameId: string): Promise<DesignFrameSourceResult>;
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
          } else if (event.key === "Escape") {
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

function LayersTab({ doc, selection, onSelect, update, reorder, step }: DesignSidePanelProps) {
  const layers = React.useMemo(() => designLayers(doc), [doc]);
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [drop, setDrop] = React.useState<{ id: string; place: DesignLayerPlace } | null>(null);
  const dragged = React.useRef<string | null>(null);
  if (layers.length === 0) return <PanelNote>Nothing on this page yet.</PanelNote>;

  const row = (layer: DesignLayer, depth: number): React.ReactNode => {
    const { frame } = layer;
    const name = designItemName(frame);
    const Icon = kindIcon(frame);
    const active = selection.has(frame.id);
    return (
      <li key={frame.id}>
        <div
          data-layer-id={frame.id}
          draggable={renaming !== frame.id}
          onDragStart={(event) => {
            dragged.current = frame.id;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", frame.id);
          }}
          onDragEnd={() => {
            dragged.current = null;
            setDrop(null);
          }}
          onDragOver={(event) => {
            if (!dragged.current || dragged.current === frame.id) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const place: DesignLayerPlace = event.clientY < rect.top + rect.height / 2 ? "above" : "below";
            setDrop((current) => (current?.id === frame.id && current.place === place ? current : { id: frame.id, place }));
          }}
          onDragLeave={() => setDrop((current) => (current?.id === frame.id ? null : current))}
          onDrop={(event) => {
            event.preventDefault();
            const id = dragged.current;
            const place = drop?.id === frame.id ? drop.place : "above";
            dragged.current = null;
            setDrop(null);
            if (id && id !== frame.id) reorder(id, frame.id, place);
          }}
          className={cn(
            "group/layer relative flex h-8 items-center gap-1 rounded-control pr-1 text-regular",
            active ? "bg-list-selection" : "hover:bg-list-hover",
            frame.hidden && "text-secondary",
          )}
          style={{ paddingLeft: 4 + depth * 16 }}
        >
          {drop?.id === frame.id ? (
            <span
              aria-hidden
              className={cn("pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-fill-accent", drop.place === "above" ? "top-0" : "bottom-0")}
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
        </div>
        {layer.children.length > 0 ? <ul aria-label={`In ${name}`}>{layer.children.map((child) => row(child, depth + 1))}</ul> : null}
      </li>
    );
  };

  return (
    <ul aria-label="Layers" className="flex flex-col py-1">
      {layers.map((layer) => row(layer, 0))}
    </ul>
  );
}

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
        } else if (event.key === "Escape") {
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

type Loaded = { key: string; text: string; truncated: boolean } | { key: string; error: string };

/** The one selected page or artifact, the frames Code and Tweaks are about. */
function selectedPage(selected: DesignFrame[]): DesignFrame | null {
  return selected.length === 1 && isDesignPrintable(selected[0]!.kind) ? selected[0]! : null;
}

/** A page's file or an artifact's HTML, read again after each change on disk; null while it loads. */
const SOURCE_ERRORS = {
  missing: "This file is missing.",
  unavailable: "The code isn't available here.",
  unsaved: "The canvas couldn't be saved, so the code can't be shown yet.",
} as const;

function useFrameSource(
  readSource: DesignSidePanelProps["readSource"],
  frame: DesignFrame | null,
  versionOf: (path: string | undefined) => number,
): Loaded | null {
  const key = frame ? `${frame.id}:${frame.mediaId ?? frame.path}:${versionOf(frame.path)}` : null;
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  React.useEffect(() => {
    if (!frame || !key) return;
    let cancelled = false;
    void readSource(frame.id).then(
      (answer) => {
        if (cancelled) return;
        if ("text" in answer) setLoaded({ key, text: answer.text, truncated: answer.truncated });
        else setLoaded({ key, error: SOURCE_ERRORS[answer.error] });
      },
      () => !cancelled && setLoaded({ key, error: "The code couldn't be read." }),
    );
    return () => {
      cancelled = true;
    };
    // The key changes with the frame, its file and each change on disk.
  }, [readSource, key]);
  return loaded?.key === key ? loaded : null;
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

function TweaksTab({ readSource, selected, versionOf, update }: DesignSidePanelProps & { selected: DesignFrame[] }) {
  const frame = selectedPage(selected);
  // Only a page's file declares controls; an artifact has just the Dark switch.
  const source = useFrameSource(readSource, frame?.kind === "file" ? frame : null, versionOf);
  const controls = React.useMemo(
    () => (source && "text" in source ? extractDesignTweakControls(source.text) : []),
    [source],
  );
  if (!frame) return <PanelNote>Select a page or an artifact to change how it looks.</PanelNote>;
  const set = (control: DesignTweakControl, value: boolean | string | number) =>
    update(frame.id, { tweaks: withDesignTweak(frame.tweaks, control, value) }, { record: true });
  return (
    <div className="flex flex-col">
      <PanelSection title="Appearance">
        <TweakRow label="Dark">
          <Switch
            aria-label="Dark"
            checked={frame.dark === true}
            onCheckedChange={(checked) => update(frame.id, { dark: checked ? true : undefined }, { record: true })}
          />
        </TweakRow>
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
            <>
              {controls.map((control) => (
                <TweakControl key={control.id} control={control} value={readDesignTweak(control, frame.tweaks)} onChange={(value) => set(control, value)} />
              ))}
              <div>
                <Button
                  size="small"
                  variant="muted"
                  disabled={!frame.tweaks}
                  onClick={() => update(frame.id, { tweaks: undefined }, { record: true })}
                >
                  Reset tweaks
                </Button>
              </div>
            </>
          )}
          <p className="text-small text-secondary">Tweaks change only this frame. The page's file stays as it is.</p>
        </PanelSection>
      ) : null}
    </div>
  );
}

function TweakRow({ label, id, children }: { label: string; id?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-7 min-w-0 items-center gap-2">
      <span id={id} className="min-w-0 flex-1 truncate text-small">
        {label}
      </span>
      {children}
    </div>
  );
}

function TweakControl({
  control,
  value,
  onChange,
}: {
  control: DesignTweakControl;
  value: boolean | string | number;
  onChange(value: boolean | string | number): void;
}) {
  const id = React.useId();
  switch (control.type) {
    case "switch":
      return (
        <TweakRow label={control.label}>
          <Switch aria-label={control.label} checked={value === true} onCheckedChange={onChange} />
        </TweakRow>
      );
    case "choice":
      return control.options.length <= 3 && control.options.every((option) => option.length <= 10) ? (
        <div className="flex flex-col gap-1">
          <span id={id} className="text-small">
            {control.label}
          </span>
          <Segmented
            aria-labelledby={id}
            value={String(value)}
            onValueChange={onChange}
            options={control.options.map((option) => ({ value: option, label: option }))}
            className="[&>*]:flex-1"
          />
        </div>
      ) : (
        <TweakRow label={control.label} id={id}>
          <Select value={String(value)} onValueChange={onChange}>
            <SelectTrigger size="small" aria-labelledby={id} className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {control.options.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </TweakRow>
      );
    case "number":
      return <TweakNumber control={control} value={Number(value)} onCommit={onChange} />;
    case "color":
      return <TweakColor label={control.label} value={String(value)} onCommit={onChange} />;
  }
}

/** A slider that changes the page once it is let go, so one drag is one undo step. */
function TweakNumber({
  control,
  value,
  onCommit,
}: {
  control: Extract<DesignTweakControl, { type: "number" }>;
  value: number;
  onCommit(value: number): void;
}) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center text-small">
        <span className="min-w-0 flex-1 truncate">{control.label}</span>
        <span className="tabular-nums text-secondary">
          {Number(draft.toFixed(4))}
          {control.unit}
        </span>
      </span>
      <input
        type="range"
        aria-label={control.label}
        min={control.min}
        max={control.max}
        step={control.step}
        value={draft}
        className="w-full accent-fill-accent"
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
    </label>
  );
}

/** A colour well; the page changes once the picker closes. */
function TweakColor({ label, value, onCommit }: { label: string; value: string; onCommit(value: string): void }) {
  const commitRef = React.useRef(onCommit);
  React.useLayoutEffect(() => {
    commitRef.current = onCommit;
  });
  // The well is drawn afresh for each new value (its key), so every one gets the listener.
  const listen = React.useCallback((input: HTMLInputElement | null) => {
    if (!input) return;
    // "change" fires when the picker closes; React's onChange would fire for every step of a drag.
    const changed = () => commitRef.current(input.value);
    input.addEventListener("change", changed);
    return () => input.removeEventListener("change", changed);
  }, []);
  return (
    <TweakRow label={label}>
      <span className="font-mono text-small text-secondary">{value}</span>
      <input
        ref={listen}
        type="color"
        aria-label={label}
        defaultValue={value}
        key={value}
        className="h-7 w-9 cursor-pointer rounded-button bg-control p-0.5"
      />
    </TweakRow>
  );
}
