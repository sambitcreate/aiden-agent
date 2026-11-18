// The Tweaks controls of one page frame, shared by the side panel's Tweaks tab
// and the floating panel on a page the person is inside: its versions, its
// controls (in folders when the page groups them), and the row that shuffles
// them, sends them to Aiden, copies them, makes them the page's defaults or
// resets them. Changes stay on the frame until Make default.

import { ChevronRight, Copy, Dices, LayoutGrid, MessageSquarePlus, Plus, RotateCcw, Stamp, X } from "lucide-react";
import * as React from "react";
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, toast } from "../components/ui";
import { Segmented } from "../components/ui-primitives";
import { cn } from "../lib/ui-utils";
import type { DesignFrame } from "../shared/design-canvas/schema";
import {
  cleanDesignTweakText,
  DESIGN_TWEAK_VERSION_LIMITS,
  describeDesignTweak,
  designTweakSummary,
  extractDesignTweakControls,
  nextDesignTweakVersionName,
  readDesignTweak,
  showsDesignTweakVersion,
  shuffleDesignTweaks,
  withDesignTweak,
  type DesignTweakAxis,
  type DesignTweakControl,
  type DesignTweakPoint,
  type DesignTweakValue,
  type DesignTweakVersion,
} from "../shared/design-canvas/tweaks";
import { useFrameSource, type DesignLoadedSource, type DesignReadSource } from "./frame-source";
import type { DesignFramePatch } from "./nodes/design-node-context";
import { DESIGN_TWEAK_V1, forgetDesignTweakVersionPicture, useDesignTweakVersionPicture } from "./tweak-versions";

/** What the Tweaks controls ask of the canvas. */
export type DesignTweakOps = {
  update(id: string, patch: DesignFramePatch, options: { record: boolean }): void;
  /** Presses one of the page's own buttons; false when the page isn't running. */
  action(frameId: string, actionId: string): boolean;
  /** Queues the values as a comment on the frame, for the next message. */
  send(frameId: string, note: string): boolean;
  /** Writes the frame's values into its file as the page's defaults. */
  makeDefault(frameId: string): void;
  /**
   * Takes a version's picture after `delay`, kept only if the frame still has
   * that version and shows it when the picture is taken and when it comes back.
   */
  pictureVersion(frameId: string, versionId: string, delay: number): void;
  /** Lays out a copy of the page for each version, side by side. */
  showAll(frameId: string): void;
};

const V1 = DESIGN_TWEAK_V1;

/** A page frame's declared controls, read again after each change of its file. */
export function useDesignTweakControls(
  readSource: DesignReadSource,
  frame: DesignFrame | null,
  versionOf: (path: string | undefined) => number,
): { source: DesignLoadedSource | null; controls: DesignTweakControl[] } {
  // Only a page's file declares controls; an artifact has just the Dark switch.
  const source = useFrameSource(readSource, frame?.kind === "file" ? frame : null, versionOf);
  const controls = React.useMemo(
    () => (source && "text" in source ? extractDesignTweakControls(source.text) : []),
    [source],
  );
  return { source, controls };
}

export function DesignTweakDark({ frame, ops }: { frame: DesignFrame; ops: Pick<DesignTweakOps, "update"> }) {
  return (
    <TweakRow label="Dark">
      <Switch
        aria-label="Dark"
        checked={frame.dark === true}
        onCheckedChange={(checked) => ops.update(frame.id, { dark: checked ? true : undefined }, { record: true })}
      />
    </TweakRow>
  );
}

/** A page frame's versions, controls and actions. */
export function DesignTweaksEditor({
  frame,
  controls,
  ops,
}: {
  frame: DesignFrame;
  controls: DesignTweakControl[];
  ops: DesignTweakOps;
}) {
  const set = (control: DesignTweakControl, value: DesignTweakValue) =>
    ops.update(frame.id, { tweaks: withDesignTweak(frame.tweaks, control, value) }, { record: true });
  const press = (control: DesignTweakControl) => {
    if (!ops.action(frame.id, control.id)) toast("Select the page so it runs, then try again.");
  };
  const { loose, folders } = React.useMemo(() => intoFolders(controls), [controls]);
  const showing = frame.tweakVersions?.find((version) => showsDesignTweakVersion(frame, version));
  const summary = () => designTweakSummary(controls, frame.tweaks, { dark: frame.dark === true, ...(showing ? { version: showing.name } : {}) });
  const canShuffle = controls.some((control) => control.type !== "text" && control.type !== "action");
  const renderControl = (control: DesignTweakControl) => (
    <TweakControl
      key={control.id}
      control={control}
      value={readDesignTweak(control, frame.tweaks)}
      onChange={(value) => set(control, value)}
      onPress={() => press(control)}
    />
  );
  return (
    <div className="flex flex-col gap-3">
      <TweakVersions frame={frame} ops={ops} />
      <div className="flex flex-col gap-2">
        {loose.map(renderControl)}
        {folders.map((folder) => (
          <TweakFolder key={folder.name} path={frame.path ?? frame.id} name={folder.name}>
            {folder.controls.map(renderControl)}
          </TweakFolder>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="small"
          variant="muted"
          title="Add these values to your next message"
          onClick={() => {
            if (ops.send(frame.id, summary())) toast.success("Added to your next message.");
            else toast.error("These values couldn't be added. Remove a comment and try again.");
          }}
        >
          <MessageSquarePlus aria-hidden />
          Send to Aiden
        </Button>
        <Button
          size="small"
          variant="muted"
          disabled={!frame.tweaks}
          title="Write these values into the page's file"
          onClick={() => ops.makeDefault(frame.id)}
        >
          <Stamp aria-hidden />
          Make default
        </Button>
        <Button
          size="small"
          variant="muted"
          disabled={!canShuffle}
          title="Try random values"
          onClick={() => ops.update(frame.id, { tweaks: shuffleDesignTweaks(controls, frame.tweaks) }, { record: true })}
        >
          <Dices aria-hidden />
          Shuffle
        </Button>
        <Button
          size="small"
          variant="muted"
          title="Copy these values"
          onClick={() => {
            void navigator.clipboard.writeText(summary()).then(
              () => toast.success("Copied the values."),
              () => toast.error("The values couldn't be copied."),
            );
          }}
        >
          <Copy aria-hidden />
          Copy
        </Button>
        <Button
          size="small"
          variant="muted"
          disabled={!frame.tweaks}
          onClick={() => ops.update(frame.id, { tweaks: undefined }, { record: true })}
        >
          <RotateCcw aria-hidden />
          Reset tweaks
        </Button>
      </div>
      <p className="text-small text-secondary">Tweaks change only this frame until you choose Make default.</p>
    </div>
  );
}

// ---- Folders ----------------------------------------------------------------

type Folder = { name: string; controls: DesignTweakControl[] };

/** Controls without a folder come first, then each folder in the order the page first names it. */
function intoFolders(controls: readonly DesignTweakControl[]): { loose: DesignTweakControl[]; folders: Folder[] } {
  const loose: DesignTweakControl[] = [];
  const folders: Folder[] = [];
  for (const control of controls) {
    if (!control.group) {
      loose.push(control);
      continue;
    }
    let folder = folders.find((entry) => entry.name === control.group);
    if (!folder) {
      folder = { name: control.group, controls: [] };
      folders.push(folder);
    }
    folder.controls.push(control);
  }
  return { loose, folders };
}

const FOLDERS_KEY = "aiden.design.tweakFolders";
/** Pages whose closed folders are remembered; the oldest is forgotten first. */
const FOLDER_PAGES = 50;

function readClosedFolders(): Record<string, string[]> {
  try {
    const saved = JSON.parse(window.localStorage.getItem(FOLDERS_KEY) ?? "null") as unknown;
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      const closed: Record<string, string[]> = {};
      for (const [path, names] of Object.entries(saved as Record<string, unknown>)) {
        if (Array.isArray(names)) closed[path] = names.filter((name): name is string => typeof name === "string");
      }
      return closed;
    }
  } catch {
    // Storage that cannot be read opens every folder.
  }
  return {};
}

function rememberFolder(path: string, name: string, open: boolean): void {
  try {
    const closed = readClosedFolders();
    const names = new Set(closed[path] ?? []);
    if (open) names.delete(name);
    else names.add(name);
    delete closed[path];
    if (names.size > 0) closed[path] = [...names];
    const paths = Object.keys(closed);
    for (const old of paths.slice(0, Math.max(0, paths.length - FOLDER_PAGES))) delete closed[old];
    window.localStorage.setItem(FOLDERS_KEY, JSON.stringify(closed));
  } catch {
    // Not remembered; the folder still opens and closes.
  }
}

/** A folder of controls, open unless the person closed it on this page before. */
function TweakFolder({ path, name, children }: { path: string; name: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(() => !(readClosedFolders()[path] ?? []).includes(name));
  const id = React.useId();
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        className="-mx-1 flex h-7 items-center gap-1 rounded-button px-1 text-small-strong text-secondary outline-none hover:bg-list-hover hover:text-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
        onClick={() => {
          setOpen(!open);
          rememberFolder(path, name, !open);
        }}
      >
        <ChevronRight
          aria-hidden
          className={cn("size-3.5 shrink-0 transition-transform duration-(--motion-duration) ease-standard motion-reduce:transition-none", open && "rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate text-left">{name}</span>
      </button>
      <div id={id} hidden={!open} className="flex flex-col gap-2 pl-4">
        {children}
      </div>
    </div>
  );
}

// ---- Versions ---------------------------------------------------------------

/** V1 (the page as its file says), the saved versions, Save version and Show all. */
function TweakVersions({ frame, ops }: { frame: DesignFrame; ops: DesignTweakOps }) {
  const versions = frame.tweakVersions ?? [];
  const showingV1 = !frame.tweaks && frame.dark !== true;
  const saved = showingV1 || versions.some((version) => showsDesignTweakVersion(frame, version));
  const full = versions.length >= DESIGN_TWEAK_VERSION_LIMITS.versions;
  const show = (version: { id: string; tweaks?: DesignTweakVersion["tweaks"]; dark?: true }) => {
    ops.update(frame.id, { tweaks: version.tweaks, dark: version.dark }, { record: true });
    // Once the page has its values.
    ops.pictureVersion(frame.id, version.id, 400);
  };
  const save = () => {
    if (saved || full) return;
    const version: DesignTweakVersion = {
      id: crypto.randomUUID(),
      name: nextDesignTweakVersionName(versions),
      ...(frame.tweaks ? { tweaks: { ...frame.tweaks } } : {}),
      ...(frame.dark ? { dark: true as const } : {}),
    };
    ops.update(frame.id, { tweakVersions: [...versions, version] }, { record: true });
    ops.pictureVersion(frame.id, version.id, 0);
  };
  const remove = (version: DesignTweakVersion) => {
    const rest = versions.filter((entry) => entry.id !== version.id);
    ops.update(frame.id, { tweakVersions: rest.length > 0 ? rest : undefined }, { record: true });
    forgetDesignTweakVersionPicture(frame.id, version.id);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 text-small-strong text-secondary">Versions</span>
        {versions.length > 0 ? (
          <Button size="small" variant="transparent" title="Lay out every version side by side" onClick={() => ops.showAll(frame.id)}>
            <LayoutGrid aria-hidden />
            Show all
          </Button>
        ) : null}
      </div>
      <div role="group" aria-label="Versions" className="flex flex-wrap gap-1.5">
        <VersionChip frameId={frame.id} versionId={V1} name="V1" title="The page as its file says" active={showingV1} onShow={() => show({ id: V1 })} />
        {versions.map((version) => (
          <VersionChip
            key={version.id}
            frameId={frame.id}
            versionId={version.id}
            name={version.name}
            active={showsDesignTweakVersion(frame, version)}
            onShow={() => show(version)}
            onRemove={() => remove(version)}
          />
        ))}
        <Button
          size="small"
          variant="transparent"
          className="px-2"
          disabled={saved || full}
          title={full ? "This page has as many versions as it can keep." : saved ? "This look is already saved." : "Save this look as a version"}
          onClick={save}
        >
          <Plus aria-hidden />
          Save version
        </Button>
      </div>
    </div>
  );
}

function VersionChip({
  frameId,
  versionId,
  name,
  title,
  active,
  onShow,
  onRemove,
}: {
  frameId: string;
  versionId: string;
  name: string;
  title?: string;
  active: boolean;
  onShow(): void;
  onRemove?(): void;
}) {
  const picture = useDesignTweakVersionPicture(frameId, versionId);
  return (
    <div
      className={cn(
        "group/version flex items-center rounded-button transition-colors duration-(--motion-duration) ease-standard",
        active ? "bg-list-selection" : "bg-control/50 hover:bg-control",
      )}
    >
      <button
        type="button"
        aria-pressed={active}
        title={title ?? `Show ${name}`}
        className="flex h-7 items-center gap-1.5 rounded-button pl-1 pr-2 text-small outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        onClick={onShow}
      >
        {picture ? (
          <img src={picture} alt="" className="h-5 w-8 rounded-sm bg-well object-cover object-top" draggable={false} />
        ) : (
          <span aria-hidden className="w-0.5" />
        )}
        {name}
      </button>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Delete ${name}`}
          title={`Delete ${name}`}
          className="-ml-1 mr-0.5 flex size-5 items-center justify-center rounded-full text-secondary opacity-0 outline-none hover:bg-list-hover hover:text-primary focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus-ring group-hover/version:opacity-100"
          onClick={onRemove}
        >
          <X aria-hidden className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

// ---- Controls ---------------------------------------------------------------

export function TweakRow({ label, id, children }: { label: string; id?: string; children: React.ReactNode }) {
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
  onPress,
}: {
  control: DesignTweakControl;
  value: DesignTweakValue;
  onChange(value: DesignTweakValue): void;
  onPress(): void;
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
      return <TweakNumber label={control.label} axis={control} value={Number(value)} onCommit={onChange} />;
    case "color":
      return <TweakColor label={control.label} value={String(value)} onCommit={onChange} />;
    case "text":
      return <TweakText label={control.label} value={String(value)} onCommit={onChange} />;
    case "pad":
      return <TweakPad control={control} value={value as DesignTweakPoint} onCommit={onChange} />;
    case "action":
      return (
        <div>
          <Button size="small" variant="filled" onClick={onPress}>
            {control.label}
          </Button>
        </div>
      );
  }
}

type NumberAxis = Pick<DesignTweakAxis, "min" | "max" | "step" | "unit">;

/** A value on an axis's steps, inside its limits. */
function snap(axis: NumberAxis, value: number): number {
  const stepped = axis.min + Math.round((value - axis.min) / axis.step) * axis.step;
  return Number(Math.min(axis.max, Math.max(axis.min, stepped)).toFixed(6));
}

function shownNumber(value: number): string {
  return String(Number(value.toFixed(4)));
}

/** A typed value for a number: Enter or leaving the field sets it, kept inside the limits. */
function NumberEntry({
  label,
  axis,
  value,
  onCommit,
}: {
  label: string;
  axis: NumberAxis;
  value: number;
  onCommit(value: number): void;
}) {
  const shown = shownNumber(value);
  const [draft, setDraft] = React.useState(shown);
  React.useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const parsed = Number.parseFloat(draft.trim());
    if (!Number.isFinite(parsed)) {
      setDraft(shown);
      return;
    }
    // Typed values may sit between the slider's steps, but never past its ends.
    const next = Number(Math.min(axis.max, Math.max(axis.min, parsed)).toFixed(6));
    setDraft(shownNumber(next));
    if (next !== value) onCommit(next);
  };
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Input
        aria-label={`${label} value`}
        inputMode="decimal"
        value={draft}
        className="h-6 w-14 px-1.5 text-right text-small tabular-nums"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDraft(shown);
          }
        }}
      />
      {axis.unit ? <span className="w-5 text-small text-secondary">{axis.unit}</span> : null}
    </span>
  );
}

/** A slider and its typed value. The page changes once the slider is let go, so one drag is one undo step. */
function TweakNumber({
  label,
  axis,
  value,
  onCommit,
}: {
  label: string;
  axis: NumberAxis;
  value: number;
  onCommit(value: number): void;
}) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-2 text-small">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <NumberEntry label={label} axis={axis} value={draft} onCommit={onCommit} />
      </span>
      <input
        type="range"
        aria-label={label}
        min={axis.min}
        max={axis.max}
        step={axis.step}
        value={draft}
        className="w-full accent-fill-accent"
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
    </div>
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

/** Words for the page; they change once Enter is pressed or the field is left. */
function TweakText({ label, value, onCommit }: { label: string; value: string; onCommit(value: string): void }) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = cleanDesignTweakText(draft);
    setDraft(next);
    if (next !== value) onCommit(next);
  };
  return (
    <label className="flex flex-col gap-1">
      <span className="truncate text-small">{label}</span>
      <Input
        aria-label={label}
        value={draft}
        maxLength={200}
        className="h-7 px-2 text-small"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDraft(value);
          }
        }}
      />
    </label>
  );
}

/**
 * Two numbers on one pad: drag the point, or focus it and use the arrow keys
 * (Shift for ten steps). Left and right change the first axis, up and down
 * the second. The page changes once the point is let go.
 */
function TweakPad({
  control,
  value,
  onCommit,
}: {
  control: Extract<DesignTweakControl, { type: "pad" }>;
  value: DesignTweakPoint;
  onCommit(value: DesignTweakPoint): void;
}) {
  const { x: xAxis, y: yAxis } = control;
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value.x, value.y]);
  const padRef = React.useRef<HTMLDivElement>(null);
  const dragging = React.useRef(false);
  const latest = React.useRef(draft);
  latest.current = draft;
  const commit = (next = latest.current) => {
    if (next.x !== value.x || next.y !== value.y) onCommit(next);
  };
  const at = (event: React.PointerEvent) => {
    const rect = padRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return latest.current;
    const fx = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const fy = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    return { x: snap(xAxis, xAxis.min + fx * (xAxis.max - xAxis.min)), y: snap(yAxis, yAxis.min + fy * (yAxis.max - yAxis.min)) };
  };
  const fraction = (axis: DesignTweakAxis, n: number) => (axis.max === axis.min ? 0 : (n - axis.min) / (axis.max - axis.min));
  const description = describeDesignTweak(control, draft);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="truncate text-small">{control.label}</span>
      <div
        ref={padRef}
        className="relative h-28 w-full touch-none select-none rounded-lg bg-well"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          setDraft(at(event));
          padRef.current?.querySelector<HTMLElement>("[role=slider]")?.focus({ preventScroll: true });
        }}
        onPointerMove={(event) => {
          if (dragging.current) setDraft(at(event));
        }}
        onPointerUp={(event) => {
          if (!dragging.current) return;
          dragging.current = false;
          const next = at(event);
          setDraft(next);
          commit(next);
        }}
        onPointerCancel={() => {
          dragging.current = false;
          setDraft(value);
        }}
      >
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-separator" />
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-separator" />
        <span
          role="slider"
          tabIndex={0}
          aria-label={control.label}
          aria-valuemin={xAxis.min}
          aria-valuemax={xAxis.max}
          aria-valuenow={draft.x}
          aria-valuetext={description}
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
          className="absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fill-accent shadow-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-well"
          style={{ left: `${fraction(xAxis, draft.x) * 100}%`, top: `${fraction(yAxis, draft.y) * 100}%` }}
          onKeyDown={(event) => {
            const steps = event.shiftKey ? 10 : 1;
            let next: DesignTweakPoint | null = null;
            if (event.key === "ArrowLeft") next = { ...draft, x: snap(xAxis, draft.x - steps * xAxis.step) };
            else if (event.key === "ArrowRight") next = { ...draft, x: snap(xAxis, draft.x + steps * xAxis.step) };
            else if (event.key === "ArrowUp") next = { ...draft, y: snap(yAxis, draft.y - steps * yAxis.step) };
            else if (event.key === "ArrowDown") next = { ...draft, y: snap(yAxis, draft.y + steps * yAxis.step) };
            if (!next) return;
            // The canvas's own arrow keys would move the selected frame.
            event.preventDefault();
            event.stopPropagation();
            setDraft(next);
          }}
          onKeyUp={() => commit()}
          onBlur={() => commit()}
        />
      </div>
      <span className="flex min-w-0 items-center gap-2 text-small">
        <span className="min-w-0 flex-1 truncate text-secondary">{xAxis.label}</span>
        <NumberEntry label={`${control.label} ${xAxis.label}`} axis={xAxis} value={draft.x} onCommit={(x) => onCommit({ ...draft, x })} />
      </span>
      <span className="flex min-w-0 items-center gap-2 text-small">
        <span className="min-w-0 flex-1 truncate text-secondary">{yAxis.label}</span>
        <NumberEntry label={`${control.label} ${yAxis.label}`} axis={yAxis} value={draft.y} onCommit={(y) => onCommit({ ...draft, y })} />
      </span>
    </div>
  );
}

// ---- Floating panel ---------------------------------------------------------

const FLOAT_KEY = "aiden.design.tweaksFloat";

function readFloatOpen(): boolean {
  try {
    const saved = JSON.parse(window.localStorage.getItem(FLOAT_KEY) ?? "null") as unknown;
    return !(saved && typeof saved === "object" && (saved as { open?: unknown }).open === false);
  } catch {
    return true;
  }
}

function writeFloatOpen(open: boolean): void {
  try {
    window.localStorage.setItem(FLOAT_KEY, JSON.stringify({ open }));
  } catch {
    // Not remembered; it still folds for now.
  }
}

/**
 * The page's controls over the canvas while the person is inside a page that
 * has some, so they can tweak it without opening the side panel. It folds to
 * its title, and stays folded next time.
 */
export function DesignTweaksFloat({
  frame,
  readSource,
  versionOf,
  ops,
}: {
  frame: DesignFrame;
  readSource: DesignReadSource;
  versionOf(path: string | undefined): number;
  ops: DesignTweakOps;
}) {
  const { source, controls } = useDesignTweakControls(readSource, frame, versionOf);
  const [open, setOpen] = React.useState(readFloatOpen);
  const bodyId = React.useId();
  if (!source || "error" in source || controls.length === 0) return null;
  return (
    <section
      aria-label="Tweaks"
      className="design-tweaks-float absolute right-3 top-16 z-10 flex max-h-[calc(100%-8.5rem)] w-76 flex-col overflow-hidden rounded-menu bg-popover shadow-popover"
      // Its keys are its own; Escape still leaves the page.
      onKeyDown={(event) => {
        if (event.key !== "Escape") event.stopPropagation();
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex h-9 shrink-0 items-center gap-1.5 px-3 text-small-strong text-primary outline-none hover:bg-list-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
        onClick={() => {
          setOpen(!open);
          writeFloatOpen(!open);
        }}
      >
        <ChevronRight
          aria-hidden
          className={cn("size-3.5 shrink-0 transition-transform duration-(--motion-duration) ease-standard motion-reduce:transition-none", open && "rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate text-left">Tweaks</span>
        <span className="min-w-0 max-w-32 truncate text-small text-secondary">{frame.title}</span>
      </button>
      <div id={bodyId} hidden={!open} className="min-h-0 overflow-y-auto px-3 pb-3">
        <div className="flex flex-col gap-3 pt-1">
          <DesignTweakDark frame={frame} ops={ops} />
          <DesignTweaksEditor frame={frame} controls={controls} ops={ops} />
        </div>
      </div>
    </section>
  );
}
