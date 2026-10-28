// The floating subagent pill above the composer. It keeps running subagents
// visible while the Environment panel and Quick View are closed and after
// their transcript chips have scrolled away; its tray shows each run's live
// activity with the same Open and Stop actions as the Subagents panel.

import * as React from "react";
import { ArrowDownToLine, ChevronRight, ChevronUp, PanelRight, Square, X } from "lucide-react";
import { subagentModelDisplay } from "../lib/subagent-panel-state";
import {
  formatSubagentElapsed,
  isSubagentRunViewStateActive,
  longestSubagentElapsedLabel,
  subagentElapsedMilliseconds,
  subagentRoleLabel,
  subagentStoppableSnapshot,
  type SubagentRunView,
} from "../lib/subagent-view-state";
import { cn } from "../lib/ui-utils";
import { useNow } from "../lib/use-now";
import { ariaKeyShortcut, prettyAccelerator } from "../shared/keybindings";
import type { SubagentRunSnapshot } from "../shared/subagent-runs";
import {
  SubagentMark,
  SubagentMarkStack,
  subagentGroupSummary,
  subagentStateLabel,
  subagentStatusLabel,
} from "./subagent-chips";
import { subagentMilestoneLabel } from "./subagent-detail";
import { Button, Popover, PopoverContent, PopoverTrigger } from "./ui";
import { Kbd } from "./ui-primitives";

/** What the pill shows: one batch of runs, live or just finished. */
export interface SubagentPillModel {
  /** The runs of the batch, in transcript order. */
  runs: SubagentRunView[];
  activeCount: number;
  /** The first run waiting on the person, which outranks every other headline. */
  attention?: SubagentRunView;
  /** The running run whose snapshot changed most recently. */
  latest?: SubagentRunView;
}

interface BatchLatch {
  generationIds: string[];
  /** True while the batch still has an active run; a new batch starts after it settles. */
  ongoing: boolean;
  /**
   * Runs the person dismissed; they bring the pill back only while they need the person.
   * A new run in their generation brings it back too.
   */
  dismissedRunIds: string[];
}

/**
 * Picks the runs the pill presents. A batch is every generation that had an
 * active run since the chat last went quiet; once it settles it stays as a
 * finished summary until dismissed or replaced by the next batch.
 */
export function subagentPillModel(
  views: readonly SubagentRunView[],
  latchedGenerationIds: readonly string[],
  dismissedRunIds: readonly string[] = [],
): SubagentPillModel | null {
  const dismissed = new Set(dismissedRunIds);
  // A run waiting on the person comes back even after it was put away.
  const visible = views.filter((view) => !dismissed.has(view.runId) || view.state === "needs_attention");
  const generations = new Set(latchedGenerationIds);
  for (const view of visible) {
    if (isSubagentRunViewStateActive(view.state)) generations.add(view.generationId);
  }
  if (generations.size === 0) return null;
  // Views arrive in transcript order already.
  const runs = visible.filter((view) => generations.has(view.generationId));
  if (runs.length === 0) return null;
  const active = runs.filter((run) => isSubagentRunViewStateActive(run.state));
  const latest = active
    .filter((run) => run.state === "running")
    .sort((left, right) => (right.snapshot?.updatedAt ?? 0) - (left.snapshot?.updatedAt ?? 0))[0];
  return {
    runs,
    activeCount: active.length,
    attention: runs.find((run) => run.state === "needs_attention"),
    latest: latest ?? active[0],
  };
}

/** One "generation\trun" line per active run, stable across renders that change nothing. */
function activeRunsKey(views: readonly SubagentRunView[]): string {
  return views
    .filter((view) => isSubagentRunViewStateActive(view.state))
    .map((view) => `${view.generationId}\t${view.runId}`)
    .sort()
    .join("\n");
}

/** Every generation that has a run in view, sorted. */
function presentGenerationsKey(views: readonly SubagentRunView[]): string {
  return [...new Set(views.map((view) => view.generationId))].sort().join("\n");
}

const NO_VIEWS: readonly SubagentRunView[] = [];
/** Enough to cover every run a person could still see; the oldest are forgotten first. */
const MAX_DISMISSED_RUN_IDS = 200;

/**
 * Tracks the current batch per chat so a finished batch keeps its summary
 * after the turn ends, and returns the pill model plus its dismiss action.
 */
export function useSubagentComposerPill(
  chatId: string,
  /** This chat's views, or `null` while the panel still holds another chat's. */
  views: readonly SubagentRunView[] | null,
  enabled: boolean,
): { model: SubagentPillModel | null; dismiss: () => void } {
  const viewsReady = views !== null;
  const chatViews = views ?? NO_VIEWS;
  const activeKey = activeRunsKey(chatViews);
  const presentKey = presentGenerationsKey(chatViews);
  const [latches, setLatches] = React.useState<Readonly<Record<string, BatchLatch>>>({});
  /** What this visit to the chat has shown: its generations, and whether any run was active. */
  const visitRef = React.useRef<{ chatId: string | null; generationIds: Set<string>; sawActive: boolean }>({
    chatId: null,
    generationIds: new Set(),
    sawActive: false,
  });

  React.useEffect(() => {
    if (!viewsReady) {
      visitRef.current = { chatId: null, generationIds: new Set(), sawActive: false };
      return;
    }
    if (visitRef.current.chatId !== chatId) {
      visitRef.current = { chatId, generationIds: new Set(), sawActive: false };
    }
    const visit = visitRef.current;
    for (const generationId of presentKey ? presentKey.split("\n") : []) visit.generationIds.add(generationId);
    if (activeKey) visit.sawActive = true;
    const seen = new Set(visit.generationIds);
    const sawActive = visit.sawActive;
    setLatches((current) => {
      const latch = current[chatId];
      const dismissedRunIds = latch?.dismissedRunIds ?? [];
      const active = [
        ...new Set(
          (activeKey ? activeKey.split("\n") : [])
            .map((line) => line.split("\t") as [string, string])
            .filter(([, runId]) => !dismissedRunIds.includes(runId))
            .map(([generationId]) => generationId),
        ),
      ];
      if (active.length === 0) {
        if (!latch?.ongoing) return current;
        // Returning to a chat, its views load in pieces (transcript references,
        // then saved and live snapshots), so a generation not yet back in view
        // may still be running. The batch has ended once every generation is
        // back, or once this visit watched live runs settle: by then the views
        // have loaded, so a generation still missing went with a failed turn.
        if (!sawActive && !latch.generationIds.every((generationId) => seen.has(generationId))) {
          return current;
        }
        return { ...current, [chatId]: { ...latch, ongoing: false } };
      }
      if (latch?.ongoing) {
        const merged = [...new Set([...latch.generationIds, ...active])];
        if (merged.length === latch.generationIds.length) return current;
        return { ...current, [chatId]: { ...latch, generationIds: merged } };
      }
      return { ...current, [chatId]: { generationIds: active, ongoing: true, dismissedRunIds } };
    });
  }, [activeKey, chatId, presentKey, viewsReady]);

  const latch = latches[chatId];
  const model = React.useMemo(
    () =>
      enabled && viewsReady
        ? subagentPillModel(chatViews, latch?.generationIds ?? [], latch?.dismissedRunIds)
        : null,
    [chatViews, enabled, latch, viewsReady],
  );
  const shownRunIds = model?.runs.map((run) => run.runId).join("\n") ?? "";
  const dismiss = React.useCallback(() => {
    setLatches((current) => {
      const latch = current[chatId];
      const dismissedRunIds = [
        ...new Set([...(latch?.dismissedRunIds ?? []), ...(shownRunIds ? shownRunIds.split("\n") : [])]),
      ].slice(-MAX_DISMISSED_RUN_IDS);
      return { ...current, [chatId]: { generationIds: [], ongoing: false, dismissedRunIds } };
    });
  }, [chatId, shownRunIds]);
  return { model, dismiss };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function headlineText(model: SubagentPillModel): { text: string; tone: "attention" | "active" | "quiet" } {
  if (model.attention) return { text: `${model.attention.label} needs your attention`, tone: "attention" };
  const latest = model.latest;
  if (latest) {
    return {
      text: `${latest.label} · ${subagentStatusLabel(latest.state, latest.snapshot?.activity)}`,
      tone: "active",
    };
  }
  return { text: subagentGroupSummary(model.runs.map((run) => run.state)), tone: "quiet" };
}

/** The live feed for one run: saved milestones, then the current activity and latest text. */
function RunFeed({
  run,
  elapsed,
  stopPending,
  stopError,
  onOpen,
  onStop,
}: {
  run: SubagentRunView;
  elapsed: string | undefined;
  stopPending: boolean;
  stopError: string | undefined;
  onOpen: (runId: string, trigger: HTMLElement) => void;
  onStop: (run: SubagentRunSnapshot) => void;
}) {
  const snapshot = run.snapshot;
  const active = isSubagentRunViewStateActive(run.state);
  const stoppable = subagentStoppableSnapshot(run);
  const milestones = (snapshot?.milestones ?? []).slice(-4);
  const activity = snapshot?.activity?.trim();
  const latestText = snapshot?.latestText?.trim();
  const error = snapshot?.error?.trim();
  const model = snapshot ? subagentModelDisplay(snapshot) : undefined;
  const meta = [
    elapsed ? `${active ? "Working for" : "Ran for"} ${elapsed}` : null,
    snapshot ? plural(snapshot.tools, "tool call") : null,
    model?.model ?? null,
  ].filter((part): part is string => part !== null);

  return (
    <div className="mt-0.5 mb-1.5 ml-[2.375rem] mr-2 rounded-card bg-well px-3 py-2.5" data-subagent-pill-feed={run.runId}>
      {meta.length ? <p className="m-0 truncate text-mini text-tertiary">{meta.join(" · ")}</p> : null}
      <ol className="m-0 mt-1.5 list-none space-y-1 p-0 text-small text-secondary" aria-label={`${run.label} activity`}>
        {milestones.map((milestone, index) => (
          <li key={`${index}:${milestone}`} className="flex items-start gap-2">
            <span aria-hidden="true" className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-tertiary" />
            <span className="min-w-0">{subagentMilestoneLabel(milestone)}</span>
          </li>
        ))}
        {active ? (
          <li className="flex items-start gap-2 font-medium text-primary">
            <span aria-hidden="true" className="mt-[0.4rem] size-1.5 shrink-0 rounded-full bg-status-accent" />
            <span className="min-w-0">{subagentStatusLabel(run.state, activity)}</span>
          </li>
        ) : null}
        {error ? (
          <li className="flex items-start gap-2 text-red">
            <span aria-hidden="true" className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-current" />
            <span className="min-w-0 break-words">{error}</span>
          </li>
        ) : null}
        {!milestones.length && !active && !error ? (
          <li className="text-tertiary">{subagentStateLabel(run.state)}</li>
        ) : null}
      </ol>
      {latestText ? (
        <p className="m-0 mt-1.5 line-clamp-2 text-small text-tertiary [overflow-wrap:anywhere]">{latestText}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button
          variant="muted"
          size="small"
          onClick={(event) => onOpen(run.runId, event.currentTarget)}
          aria-label={`${run.state === "needs_attention" ? "Review" : active ? "Open" : "View result of"} ${run.label} in the side panel`}
        >
          <PanelRight aria-hidden="true" className="size-3.5" />
          {run.state === "needs_attention" ? "Review" : active ? "Open in side panel" : "View result"}
        </Button>
        {stoppable ? (
          <Button
            variant="muted"
            size="small"
            disabled={stopPending}
            aria-busy={stopPending ? true : undefined}
            aria-label={stopPending ? `Stopping ${run.label}` : `Stop ${run.label}`}
            onClick={() => {
              if (!stopPending) onStop(stoppable);
            }}
          >
            <Square aria-hidden="true" className="size-3" />
            {stopPending ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
      </div>
      {stopError && !stopPending ? (
        <p role="alert" className="m-0 mt-1.5 text-small text-red">
          {stopError}
        </p>
      ) : null}
    </div>
  );
}

function TrayRun({
  run,
  now,
  expanded,
  onToggle,
  ...feed
}: {
  run: SubagentRunView;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  stopPending: boolean;
  stopError: string | undefined;
  onOpen: (runId: string, trigger: HTMLElement) => void;
  onStop: (run: SubagentRunSnapshot) => void;
}) {
  const elapsedMs = subagentElapsedMilliseconds(run, now);
  const elapsed = elapsedMs === undefined ? undefined : formatSubagentElapsed(elapsedMs);
  const role = subagentRoleLabel(run.role);
  const status = subagentStatusLabel(run.state, run.snapshot?.activity);
  // A failed Stop shows on the row too, so it is not lost when the feed is collapsed.
  const stopError = feed.stopPending ? undefined : feed.stopError;
  const error = stopError ?? run.snapshot?.error?.trim();
  const feedId = React.useId();
  return (
    <li className="list-none" data-subagent-pill-run-id={run.runId}>
      <button
        type="button"
        // The elapsed time ticks every second; keep it out of the name.
        aria-label={[run.label, role, error || status].filter(Boolean).join(", ")}
        aria-expanded={expanded}
        aria-controls={expanded ? feedId : undefined}
        onClick={onToggle}
        className="grid min-h-11 w-full grid-cols-[20px_minmax(0,1fr)_auto_14px] items-center gap-2.5 rounded-control px-2.5 py-1 text-left transition-colors duration-150 ease-out [--keyboard-focus-offset:-2px] hover:bg-list-hover active:bg-list-selection motion-reduce:transition-none"
      >
        <SubagentMark role={run.role} state={run.state} activity={run.snapshot?.activity} size={18} />
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-regular text-primary">{run.label}</span>
            {role ? (
              <span className="shrink-0 rounded-full bg-control px-1.5 text-mini text-secondary">{role}</span>
            ) : null}
          </span>
          <span
            className={cn(
              "truncate text-small",
              error || run.state === "failed"
                ? "text-red"
                : run.state === "needs_attention"
                  ? "text-support-warning"
                  : "text-tertiary",
            )}
          >
            {error || status}
          </span>
        </span>
        <span aria-hidden="true" className="text-small whitespace-nowrap text-tertiary tabular-nums">
          {elapsed ?? ""}
        </span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 text-tertiary transition-transform duration-150 motion-reduce:transition-none",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded ? (
        <div id={feedId}>
          <RunFeed run={run} elapsed={elapsed} {...feed} />
        </div>
      ) : null}
    </li>
  );
}

export interface SubagentComposerPillProps {
  model: SubagentPillModel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stopPendingRunIds: readonly string[];
  stopErrors?: Readonly<Record<string, string>>;
  onOpenRun: (runId: string, trigger: HTMLElement) => void;
  /** Receives the pill trigger, which focus returns to when the panel closes. */
  onOpenPanel: (returnTarget: HTMLElement | null) => void;
  onStop: (run: SubagentRunSnapshot) => Promise<void> | void;
  /** Scrolls the transcript to these runs; returns false when none are on screen to reveal. */
  onShowInChat?: (runIds: readonly string[]) => boolean;
  onDismiss: () => void;
  /** Where keyboard focus goes when the pill leaves while it or its tray holds focus. */
  returnFocus?: () => HTMLElement | null;
  /** The effective `subagents.toggleTray` binding, shown in the tray footer. */
  shortcut?: string | null;
}

const NO_STOP_ERRORS: Readonly<Record<string, string>> = {};

export function SubagentComposerPill({
  model,
  open,
  onOpenChange,
  stopPendingRunIds,
  stopErrors = NO_STOP_ERRORS,
  onOpenRun,
  onOpenPanel,
  onStop,
  onShowInChat,
  onDismiss,
  returnFocus,
  shortcut = null,
}: SubagentComposerPillProps) {
  const active = model.activeCount > 0;
  const now = useNow(active);
  const headline = headlineText(model);
  const elapsed = longestSubagentElapsedLabel(
    model.runs.map((run) => run.snapshot),
    now,
  );
  const allCompleted = !active && model.runs.every((run) => run.state === "completed");
  const marks = (active ? model.runs.filter((run) => isSubagentRunViewStateActive(run.state)) : model.runs).map(
    (run) => ({ key: run.runId, role: run.role, state: run.state, activity: run.snapshot?.activity }),
  );
  const countText = active ? plural(model.activeCount, "subagent") : plural(model.runs.length, "subagent");
  const stopPending = React.useMemo(() => new Set(stopPendingRunIds), [stopPendingRunIds]);
  const stoppable = model.runs
    .map(subagentStoppableSnapshot)
    .filter((snapshot): snapshot is SubagentRunSnapshot => snapshot !== undefined && !stopPending.has(snapshot.runId));
  // Background runs keep working on their own and cannot be stopped here, so
  // once only they remain the person may put the pill away. A run of unknown
  // execution (an older host) counts as foreground, and a run waiting on the
  // person stays until it is answered.
  const dismissible =
    !model.attention &&
    model.runs.every(
      (run) =>
        !isSubagentRunViewStateActive(run.state) ||
        (run.snapshot?.version === 2 && run.snapshot.execution === "background"),
    );
  const defaultExpanded = (model.attention ?? model.latest ?? model.runs[0])?.runId ?? null;
  const [expandedRunId, setExpandedRunId] = React.useState<string | null>(defaultExpanded);
  const wasOpen = React.useRef(open);
  const listRef = React.useRef<HTMLUListElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const pillRef = React.useRef<HTMLDivElement>(null);
  const trayRef = React.useRef<HTMLDivElement>(null);
  const returnFocusLatest = React.useRef(returnFocus);
  returnFocusLatest.current = returnFocus;
  // Dismissing, or the last run vanishing, removes the pill (and an open tray)
  // while it may hold keyboard focus. Hand focus on instead of dropping it on the document.
  React.useLayoutEffect(() => {
    const pill = pillRef.current;
    const tray = trayRef;
    return () => {
      const focused = document.activeElement;
      if (!focused || !(pill?.contains(focused) || tray.current?.contains(focused))) return;
      queueMicrotask(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        returnFocusLatest.current?.()?.focus({ preventScroll: true });
      });
    };
  }, []);
  /** Where the person was typing when the shortcut opened the tray. */
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (open && !wasOpen.current) setExpandedRunId(defaultExpanded);
    wasOpen.current = open;
  }, [defaultExpanded, open]);

  const stop = (snapshot: SubagentRunSnapshot) => {
    // The environment panel's stop-pending state owns and presents failures.
    void Promise.resolve(onStop(snapshot)).catch(() => undefined);
  };
  // Kept free of live activity so a focused trigger is not re-read on every step.
  const triggerLabel = `${active ? `${countText} running` : `${countText} finished`}.${model.attention ? ` ${model.attention.label} needs your attention.` : ""} ${open ? "Hide" : "Show"} subagent details.`;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <div
        ref={pillRef}
        data-subagent-pill={active ? (model.attention ? "attention" : "active") : "finished"}
        className={cn(
          // Shrinks ahead of the task chip so both stay legible when they share the row, but
          // never below its marks and count: the headline is the only part that gives way.
          "pointer-events-auto flex min-h-9 max-w-[min(100%,36rem)] shrink-[4] items-center rounded-pill bg-popover/95 shadow-popover backdrop-blur-xl transition-[background-color,box-shadow] duration-150 hover:bg-popover hover:shadow-modal motion-reduce:transition-none",
          model.attention && "bg-status-warning-surface hover:bg-status-warning-surface",
        )}
      >
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            aria-label={triggerLabel}
            aria-keyshortcuts={ariaKeyShortcut(shortcut)}
            className={cn(
              "flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-pill py-1 pr-3 pl-1.5 text-small [--keyboard-focus-offset:-2px]",
              dismissible && "pr-1.5",
            )}
          >
            <SubagentMarkStack
              items={marks}
              // The warning fill is translucent; an opaque ring would show as a halo on it.
              ringClassName={model.attention ? "bg-transparent" : undefined}
              // In the narrowest windows the count alone has to fit beside the controls.
              className="@max-[15rem]:hidden"
            />
            <span
              className={cn(
                "shrink-0 font-medium whitespace-nowrap tabular-nums",
                allCompleted ? "text-status-green" : "text-primary",
              )}
            >
              <span className="@max-[30rem]:hidden">{active ? countText : `${countText} finished`}</span>
              <span className="hidden @max-[30rem]:inline">
                {active ? `${model.activeCount} running` : `${model.runs.length} finished`}
              </span>
            </span>
            {/* Narrow windows keep the marks and count; the tray still has every detail. */}
            <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-separator @max-[30rem]:hidden" />
            <span
              className={cn(
                "line-clamp-1 min-w-0 [overflow-wrap:anywhere] @max-[30rem]:hidden",
                headline.tone === "attention" ? "text-support-warning" : "text-secondary",
              )}
            >
              {headline.text}
            </span>
            {elapsed ? (
              <span className="shrink-0 text-mini text-tertiary tabular-nums @max-[30rem]:hidden">{elapsed}</span>
            ) : null}
            <ChevronUp
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-tertiary transition-transform duration-150 motion-reduce:transition-none",
                open && "rotate-180",
              )}
            />
          </button>
        </PopoverTrigger>
        {dismissible ? (
          <Button
            variant="transparent"
            size="small"
            iconOnly
            className="mr-0.5 text-tertiary hover:text-primary"
            aria-label={active ? "Hide background subagents" : "Dismiss finished subagents"}
            onClick={onDismiss}
          >
            <X aria-hidden="true" className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <PopoverContent
        ref={trayRef}
        side="top"
        align="center"
        sideOffset={8}
        collisionPadding={16}
        aria-label="Subagents"
        data-subagent-tray
        onOpenAutoFocus={(event) => {
          // Focus has not moved yet: remember a text field the shortcut opened from.
          const previous = document.activeElement;
          returnFocusRef.current =
            previous instanceof HTMLElement &&
            previous !== triggerRef.current &&
            (previous.isContentEditable || previous.matches("input, textarea"))
              ? previous
              : null;
          // Land on the run whose feed is open rather than the first header action.
          const row = Array.from(
            listRef.current?.querySelectorAll<HTMLElement>("[data-subagent-pill-run-id]") ?? [],
          )
            .find((item) => item.dataset.subagentPillRunId === defaultExpanded)
            ?.querySelector<HTMLElement>(":scope > button");
          if (!row) return;
          event.preventDefault();
          row.focus();
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef.current;
          returnFocusRef.current = null;
          // An action that already moved focus (Show in chat, Open) keeps it.
          const current = document.activeElement;
          const unclaimed =
            !current || current === document.body || current.closest("[data-subagent-tray]") !== null;
          if (!target?.isConnected || !unclaimed) return;
          event.preventDefault();
          target.focus({ preventScroll: true });
        }}
        className="flex max-h-[min(30rem,60vh)] w-[min(34rem,calc(100vw-2rem))] flex-col p-1.5"
      >
        <div className="flex shrink-0 items-center gap-2 py-1 pr-1 pl-2.5">
          <p className="m-0 text-small-strong text-primary">Subagents</p>
          <p className="m-0 min-w-0 flex-1 truncate text-small text-tertiary">
            {subagentGroupSummary(model.runs.map((run) => run.state))}
          </p>
          {onShowInChat ? (
            <Button
              variant="muted"
              size="small"
              onClick={() => {
                const shown = onShowInChat(model.runs.map((run) => run.runId));
                onOpenChange(false);
                // Nothing in the transcript to reveal: the panel still lists every run.
                if (!shown) onOpenPanel(triggerRef.current);
              }}
            >
              <ArrowDownToLine aria-hidden="true" className="size-3.5 rotate-180" />
              Show in chat
            </Button>
          ) : null}
        </div>
        <ul ref={listRef} className="m-0 min-h-0 flex-1 overflow-y-auto p-0" aria-label="Subagent runs">
          {model.runs.map((run) => (
            <TrayRun
              key={run.runId}
              run={run}
              now={now}
              expanded={expandedRunId === run.runId}
              onToggle={() => setExpandedRunId((current) => (current === run.runId ? null : run.runId))}
              stopPending={stopPending.has(run.runId)}
              stopError={stopErrors[run.runId]}
              onOpen={(runId, trigger) => {
                onOpenChange(false);
                // The tray row unmounts; the pill is what focus returns to.
                onOpenRun(runId, triggerRef.current ?? trigger);
              }}
              onStop={stop}
            />
          ))}
        </ul>
        <div className="mt-1 flex shrink-0 items-center gap-1.5 border-t border-separator px-1 pt-1.5">
          <Button
            variant="muted"
            size="small"
            onClick={() => {
              onOpenChange(false);
              // The tray button unmounts; the pill is what focus returns to.
              onOpenPanel(triggerRef.current);
            }}
          >
            <PanelRight aria-hidden="true" className="size-3.5" />
            Open Subagents panel
          </Button>
          {stoppable.length > 1 ? (
            <Button
              variant="muted"
              size="small"
              onClick={() => {
                for (const snapshot of stoppable) stop(snapshot);
              }}
            >
              <Square aria-hidden="true" className="size-3" />
              Stop all
            </Button>
          ) : null}
          <span className="flex-1" />
          {shortcut ? (
            <span className="text-mini text-tertiary">
              Toggle{" "}
              <Kbd>{prettyAccelerator(shortcut)}</Kbd>
            </span>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
