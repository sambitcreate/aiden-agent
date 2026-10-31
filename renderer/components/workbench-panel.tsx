import * as React from "react";
import { List, PanelRightClose, Plus, X } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui";
import { cn } from "../lib/ui-utils";
import { useShortcutBinding, useShortcutLabel } from "../lib/command-system";
import { ariaKeyShortcut } from "../shared/keybindings";
import {
  resolveEnvironmentPanelResizeBounds,
  storedWorkbenchWidth,
  type PanelWidthBounds,
} from "../lib/environment-panel-layout";

export interface WorkbenchWidthState {
  /** The person's preferred width; the rendered width is resolved against the container. */
  preferredWidth: number;
  /** Live updates while dragging. Not persisted. */
  setPreferredWidth: (width: number) => void;
  /** Sets and persists an already-clamped width. */
  commitPreferredWidth: (width: number) => void;
  resizing: boolean;
  setResizing: (resizing: boolean) => void;
}

/** Preferred width and drag state for a workbench, persisted under `storageKey`. */
export function useWorkbenchWidth(storageKey: string, bounds?: PanelWidthBounds): WorkbenchWidthState {
  const [preferredWidth, setPreferredWidth] = React.useState(() =>
    storedWorkbenchWidth(localStorage.getItem(storageKey), bounds),
  );
  const [resizing, setResizing] = React.useState(false);
  const commitPreferredWidth = React.useCallback(
    (width: number) => {
      setPreferredWidth(width);
      localStorage.setItem(storageKey, String(Math.round(width)));
    },
    [storageKey],
  );
  return { preferredWidth, setPreferredWidth, commitPreferredWidth, resizing, setResizing };
}

/**
 * One entry in the workbench tab strip. Several tabs may show the same view
 * (each browser page and device viewer is its own tab over one view).
 */
export interface WorkbenchTab {
  /** Unique in the strip: the React key and the "Open tabs" entry. */
  id: string;
  /** The view this tab shows; ids are `${idPrefix}-${viewId}-tab` and `-panel`. */
  viewId: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  selected: boolean;
  /** Defaults to true. A fixed tab gets no close button and ignores Delete. */
  closable?: boolean;
  /** Tooltip; defaults to the label. */
  title?: string;
  /** F2 and double-click call this. */
  onRename?: () => void;
  /** Replaces the tab button while a rename is in progress. */
  editor?: React.ReactNode;
  /** Wraps the tab button, for example in a context menu. */
  wrap?: (tabButton: React.ReactElement) => React.ReactNode;
  /** Extra `data-*` attributes on the tab's wrapper. */
  dataAttributes?: Readonly<Record<`data-${string}`, string | undefined>>;
}

export interface WorkbenchTabStripProps<T extends WorkbenchTab> {
  tabs: readonly T[];
  idPrefix: string;
  tabListLabel: string;
  /** The panel is busy (for example a long-running operation): tab navigation is disabled, Close panel is not. */
  busy?: boolean;
  activeTabRef: React.RefObject<HTMLButtonElement | null>;
  onSelectTab: (tab: T) => void;
  onCloseTab: (tab: T) => void;
  /** The launcher hook point. Without it the strip has no "+" button. */
  newTab?: { label: string; onOpen: () => void };
  /** The "Open tabs" list, for strips whose tabs can overflow. Defaults to shown. */
  tabMenu?: boolean;
  closeLabel: string;
  /** Shown as `${closeTitle} (${shortcut})` with the `environment.toggle` binding. */
  closeTitle: string;
  onClose: () => void;
}

export function WorkbenchTabStrip<T extends WorkbenchTab>({
  tabs,
  idPrefix,
  tabListLabel,
  busy = false,
  activeTabRef,
  onSelectTab,
  onCloseTab,
  newTab,
  tabMenu = true,
  closeLabel,
  closeTitle,
  onClose,
}: WorkbenchTabStripProps<T>) {
  const toggleShortcut = useShortcutLabel("environment.toggle");
  const toggleShortcutBinding = useShortcutBinding("environment.toggle");
  const tabMenuSelectionRef = React.useRef(false);
  return (
    <header className="drag-region flex h-13 shrink-0 items-center gap-1 border-b border-separator px-2">
      <div className="no-drag flex min-w-0 flex-1 gap-1 overflow-x-auto py-1" role="tablist" aria-label={tabListLabel}>
        {tabs.map((entry, index) => {
          const Icon = entry.icon;
          const closable = entry.closable !== false;
          const tabButton = <Button ref={entry.selected ? activeTabRef : undefined} id={entry.selected ? `${idPrefix}-${entry.viewId}-tab` : undefined} variant="transparent" size="small" role="tab" tabIndex={entry.selected ? 0 : -1} aria-selected={entry.selected} aria-controls={`${idPrefix}-${entry.viewId}-panel`} title={entry.title ?? entry.label} disabled={busy} onClick={() => onSelectTab(entry)} onDoubleClick={entry.onRename} onKeyDown={(event) => {
              if (event.key === "Delete") { event.preventDefault(); if (closable) onCloseTab(entry); return; }
              if (event.key === "F2" && entry.onRename) { event.preventDefault(); entry.onRename(); return; }
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
              onSelectTab(tabs[next]);
            }}>{Icon ? <Icon className="size-4 shrink-0" /> : null}<span className="max-w-32 truncate">{entry.label}</span></Button>;
          return <div key={entry.id} {...entry.dataAttributes} className={cn("flex min-w-0 shrink-0 items-center rounded-control", entry.selected && "bg-list-selection")}>
            {entry.editor ?? (entry.wrap ? entry.wrap(tabButton) : tabButton)}
            {closable ? <Button variant="transparent" size="small" iconOnly disabled={busy} aria-label={`Close ${entry.label} tab`} onClick={() => onCloseTab(entry)}><X className="size-3" /></Button> : null}
          </div>;
        })}
      </div>
      {newTab ? <Button variant="transparent" size="small" iconOnly className="no-drag" disabled={busy} aria-label={newTab.label} onClick={newTab.onOpen}><Plus /></Button> : null}
      {tabMenu ? <DropdownMenu><DropdownMenuTrigger asChild><Button variant="transparent" size="small" iconOnly className="no-drag" aria-label="Open tabs"><List /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" onCloseAutoFocus={(event) => { if (tabMenuSelectionRef.current) { event.preventDefault(); tabMenuSelectionRef.current = false; requestAnimationFrame(() => activeTabRef.current?.focus()); } }}>{tabs.map((entry) => <DropdownMenuItem key={entry.id} disabled={busy} onSelect={() => { tabMenuSelectionRef.current = true; onSelectTab(entry); }}>{entry.label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu> : null}
      <Button variant="transparent" size="small" iconOnly onClick={onClose} aria-label={closeLabel} aria-keyshortcuts={ariaKeyShortcut(toggleShortcutBinding)} title={`${closeTitle} (${toggleShortcut})`} className="no-drag"><PanelRightClose /></Button>
    </header>
  );
}

export interface WorkbenchViewContext {
  /** The surface is open and in front. */
  presented: boolean;
  /** This view is the selected one. */
  selected: boolean;
  /** The rendered surface width, for compact layouts. */
  width: number;
}

export interface WorkbenchView {
  id: string;
  /**
   * Called as a plain function inside WorkbenchPanel's render, NOT mounted as a component.
   * Do not call hooks here; return an element (e.g. `<BotActivityView />`) whose component owns any hooks.
   */
  render: (context: WorkbenchViewContext) => React.ReactNode;
}

export interface WorkbenchPanelProps<T extends WorkbenchTab>
  extends Omit<WorkbenchTabStripProps<T>, "activeTabRef"> {
  id: string;
  /**
   * `data-environment-surface`: the workspace's focus and Escape rules act on
   * "tools". Another workbench (the Bot panel) names its own surface.
   */
  surface?: string;
  label: string;
  resizeLabel: string;
  open: boolean;
  /** Open and not covered by a surface stacked in front of it. */
  presented: boolean;
  inline: boolean;
  width: number;
  containerWidth: number;
  /** The surface's own width range; the workspace Environment panel's by default. */
  widthBounds?: PanelWidthBounds;
  resizing: boolean;
  onResizingChange: (resizing: boolean) => void;
  /** Live width while dragging, already clamped. */
  onWidthChange: (width: number) => void;
  /** Final width after a drag or a key, already clamped; persist it. */
  onWidthCommit: (width: number) => void;
  onActivate?: () => void;
  /** Every view stays mounted; only `selectedViewId` is visible. */
  views: readonly WorkbenchView[];
  selectedViewId: string;
  /** Shown above every view, such as a card the floating panel would otherwise cover. */
  notice?: React.ReactNode;
  activeTabRef?: React.RefObject<HTMLButtonElement | null>;
  surfaceRef?: React.RefObject<HTMLElement | null>;
}

export function WorkbenchPanel<T extends WorkbenchTab>({
  id,
  surface = "tools",
  label,
  resizeLabel,
  open,
  presented,
  inline,
  width,
  containerWidth,
  widthBounds,
  resizing,
  onResizingChange,
  onWidthChange,
  onWidthCommit,
  onActivate,
  views,
  selectedViewId,
  notice,
  activeTabRef: providedActiveTabRef,
  surfaceRef: providedSurfaceRef,
  tabs,
  idPrefix,
  tabListLabel,
  busy,
  onSelectTab,
  onCloseTab,
  newTab,
  tabMenu,
  closeLabel,
  closeTitle,
  onClose,
}: WorkbenchPanelProps<T>) {
  const ownActiveTabRef = React.useRef<HTMLButtonElement | null>(null);
  const ownSurfaceRef = React.useRef<HTMLElement | null>(null);
  const activeTabRef = providedActiveTabRef ?? ownActiveTabRef;
  const surfaceRef = providedSurfaceRef ?? ownSurfaceRef;
  const widthRef = React.useRef(width);
  widthRef.current = width;

  const resizeBounds = resolveEnvironmentPanelResizeBounds(containerWidth, inline, widthBounds);
  const clampToResizeBounds = React.useCallback(
    (nextWidth: number) => Math.min(resizeBounds.max, Math.max(resizeBounds.min, nextWidth)),
    [resizeBounds.max, resizeBounds.min],
  );

  const commitWidth = React.useCallback(
    (nextWidth: number) => onWidthCommit(clampToResizeBounds(nextWidth)),
    [clampToResizeBounds, onWidthCommit],
  );

  const beginResize = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !open) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = widthRef.current;
      onResizingChange(true);
      const move = (moveEvent: PointerEvent) => {
        onWidthChange(clampToResizeBounds(startWidth + startX - moveEvent.clientX));
      };
      const finish = (endEvent: PointerEvent) => {
        commitWidth(
          endEvent.type === "pointerup" ? startWidth + startX - endEvent.clientX : widthRef.current,
        );
        onResizingChange(false);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [clampToResizeBounds, commitWidth, open, onResizingChange, onWidthChange],
  );

  const resizeWithKeyboard = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const increment = event.shiftKey ? 40 : 16;
      let next = width;
      if (event.key === "ArrowLeft") next += increment;
      else if (event.key === "ArrowRight") next -= increment;
      else if (event.key === "Home") next = resizeBounds.min;
      else if (event.key === "End") next = resizeBounds.max;
      else return;
      event.preventDefault();
      commitWidth(next);
    },
    [commitWidth, resizeBounds.max, resizeBounds.min, width],
  );

  return (
    <aside
      ref={surfaceRef}
      id={id}
      data-environment-surface={surface}
      data-focus-region="panel"
      data-surface-mode={inline ? "tools-pinned" : "tools-floating"}
      data-state={open ? (presented ? "open" : "covered") : "closed"}
      inert={!presented ? true : undefined}
      aria-hidden={!presented ? true : undefined}
      aria-label={label}
      onFocusCapture={onActivate}
      onPointerDownCapture={onActivate}
      className={cn(
        "environment-panel absolute z-30 flex min-h-0 flex-col overflow-hidden bg-popover text-primary",
        inline
          ? "inset-y-0 right-0 border-l border-separator"
          : "bottom-3 right-3 rounded-sheet shadow-dialog",
        // Float below the top bar so its tool buttons stay reachable, like Quick View.
        !inline && "top-14",
        resizing
          ? "transition-none"
          : "transition-[width,opacity,transform] duration-300 ease-out motion-reduce:transition-none",
        (!open || !presented) && !inline && "translate-x-[calc(100%+0.75rem)]",
      )}
      style={{
        width: open ? width : inline ? 0 : width,
        opacity: open && presented ? 1 : 0,
        pointerEvents: open && presented ? "auto" : "none",
      }}
    >
      <div
        role="separator"
        aria-label={resizeLabel}
        aria-orientation="vertical"
        aria-valuemin={resizeBounds.min}
        aria-valuemax={resizeBounds.max}
        aria-valuenow={Math.round(width)}
        tabIndex={open ? 0 : -1}
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
        className="absolute inset-y-0 left-0 z-40 -ml-1 w-2 cursor-col-resize outline-none before:absolute before:inset-y-0 before:left-1 before:w-px before:bg-separator hover:before:bg-primary/20 focus-visible:before:w-0.5 focus-visible:before:bg-accent"
      />

      <WorkbenchTabStrip
        tabs={tabs}
        idPrefix={idPrefix}
        tabListLabel={tabListLabel}
        busy={busy}
        activeTabRef={activeTabRef}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        newTab={newTab}
        tabMenu={tabMenu}
        closeLabel={closeLabel}
        closeTitle={closeTitle}
        onClose={onClose}
      />

      {notice}

      <div className="min-h-0 flex-1 @container">
        {views.map((view) => {
          const selected = view.id === selectedViewId;
          return (
            <div
              key={view.id}
              id={`${idPrefix}-${view.id}-panel`}
              role="tabpanel"
              aria-labelledby={`${idPrefix}-${view.id}-tab`}
              hidden={!selected}
              className="h-full min-h-0"
            >
              {view.render({ presented, selected, width })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
