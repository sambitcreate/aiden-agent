import * as React from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "../lib/ui-utils";
import {
  deriveSubagentRunPresentation,
  resolveSubagentSelection as resolveRunViewSelection,
  splitSubagentRunViews,
  type SubagentRunPresentation,
  type SubagentRunView,
} from "../lib/subagent-view-state";
import {
  focusSubagentRosterRun,
  shouldRestoreSubagentDetailFocus,
  subagentDetailAnnouncement,
  subagentDetailFocusFrame,
  subagentDetailPendingLoading,
  subagentDetailPresentation,
  subagentDetailRestoreRunId,
  subagentPanelBreakpointFocusTarget,
  subagentPanelOwnerKey,
  type SubagentPanelBreakpointFocusTarget,
  type SubagentPanelFocusSurface,
  type SubagentDetailAnnouncementState,
} from "../lib/subagent-panel-state";
import type { SubagentEffectActivityV1, SubagentRunSnapshot } from "../shared/subagent-runs";
import { SubagentOrb, subagentStateLabel } from "./subagent-chips";
import { SubagentDetail } from "./subagent-detail";
import {
  SubagentOwnerFocusBoundary,
  useSubagentSelectionRestoreRunRepair,
} from "./subagent-owner-focus-boundary";
import { SubagentRoster } from "./subagent-roster";
import { Button, Callout, Text } from "./ui";

export function resolveSubagentSelection(
  runs: readonly SubagentRunView[],
  requestedRunId: string | null | undefined,
): string | null {
  return resolveRunViewSelection(requestedRunId ?? undefined, runs) ?? null;
}

export interface SubagentsPanelProps {
  chatId: string | null;
  workspaceId: string | null;
  runs: readonly SubagentRunView[];
  handoffSnapshots?: readonly SubagentRunSnapshot[];
  selectedRunSnapshot?: SubagentRunSnapshot | null;
  detailLoading?: boolean;
  detailError?: string | null;
  effectActivity?: readonly SubagentEffectActivityV1[];
  selectedRunId?: string | null;
  defaultSelectedRunId?: string | null;
  onSelectedRunChange?: (runId: string) => void;
  onRetryDetail?: (runId: string) => void;
  onStopRun?: (run: SubagentRunSnapshot) => Promise<void> | void;
  stopPendingRunIds?: readonly string[];
  stopErrorsByRunId?: Readonly<Record<string, string>>;
  onDetailAnnouncement?: (ownerKey: string, message: string) => void;
  detailRequestVersion?: number;
  active?: boolean;
  compact?: boolean;
  ownerReplacementFallbackFocusTarget?: () => HTMLElement | null;
  className?: string;
}

function matchingDetailSnapshot(
  selectedRun: SubagentRunView | null,
  selectedRunSnapshot: SubagentRunSnapshot | null | undefined,
): SubagentRunSnapshot | null {
  if (!selectedRun) return null;
  const loaded =
    selectedRunSnapshot?.runId === selectedRun.runId &&
    selectedRunSnapshot.generationId === selectedRun.generationId
      ? selectedRunSnapshot
      : undefined;
  const live = selectedRun.snapshot;
  if (!loaded) return live ?? null;
  if (!live) return loaded;
  return loaded.revision > live.revision ? loaded : live;
}

const SubagentDetailPending = React.forwardRef<
  HTMLHeadingElement,
  {
    run: SubagentRunView;
    loading: boolean;
    unavailable: boolean;
    onRetry?: () => void;
  }
>(function SubagentDetailPending({ run, loading, unavailable, onRetry }, headingRef) {
  const state = subagentStateLabel(run.state);
  return (
    <article
      className="h-full min-h-0 overflow-y-auto px-4 py-4"
      aria-busy={loading ? true : undefined}
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <header className="flex min-w-0 items-start gap-2.5">
          <SubagentOrb role={run.role} state={run.state} className="mt-0.5" />
          <span className="min-w-0 flex-1">
            <h2
              ref={headingRef}
              tabIndex={-1}
              data-subagent-detail-heading="true"
              className="break-words text-strong font-medium text-primary outline-none"
            >
              {run.label}
            </h2>
            <Text as="p" variant="small" color="secondary" className="mt-0.5">
              {run.role === "unknown" ? "Subagent" : run.role} · {state}
            </Text>
          </span>
        </header>
        {loading ? (
          <Text as="p" variant="regular" color="secondary">
            Loading subagent activity…
          </Text>
        ) : unavailable ? (
          <Callout role="note" data-subagent-detail-unavailable="true">
            <Text variant="small-strong">Details unavailable</Text>
            <Text as="p" variant="small" color="secondary">
              Aiden could not load the saved activity for this subagent.
            </Text>
            {onRetry ? (
              <Button
                variant="muted"
                size="small"
                onClick={onRetry}
                aria-label={`Retry loading details for ${run.label}`}
                className="mt-3 motion-reduce:transition-none"
              >
                Retry
              </Button>
            ) : null}
          </Callout>
        ) : null}
      </div>
    </article>
  );
});

function OwnedSubagentsPanel({
  chatId,
  workspaceId,
  runs,
  handoffSnapshots = [],
  selectedRunSnapshot,
  detailLoading = false,
  detailError = null,
  effectActivity = [],
  selectedRunId,
  defaultSelectedRunId,
  onSelectedRunChange,
  onRetryDetail,
  onStopRun,
  stopPendingRunIds = [],
  stopErrorsByRunId = {},
  onDetailAnnouncement,
  detailRequestVersion = 0,
  active = true,
  compact = false,
  className,
}: SubagentsPanelProps) {
  const ownerKey = subagentPanelOwnerKey(chatId, workspaceId);
  const controlled = selectedRunId !== undefined;
  const [internalSelection, setInternalSelection] = React.useState<string | null>(
    resolveSubagentSelection(runs, defaultSelectedRunId),
  );
  const [compactView, setCompactView] = React.useState<"roster" | "detail">("roster");
  const [now, setNow] = React.useState(() => Date.now());
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const detailHeadingRef = React.useRef<HTMLHeadingElement | null>(null);
  const detailRegionOwnsFocusRef = React.useRef(false);
  const previousDetailFocusFrameRef = React.useRef<string | null>(null);
  const previousAnnouncementStateRef = React.useRef<SubagentDetailAnnouncementState | null>(null);
  const restoreRunIdRef = React.useRef<string | null>(null);
  const handledDetailRequestVersionRef = React.useRef(detailRequestVersion);
  const previousCompactRef = React.useRef(compact);
  const focusedSurfaceRef = React.useRef<SubagentPanelFocusSurface>(null);
  const pendingBreakpointFocusRef = React.useRef<SubagentPanelBreakpointFocusTarget>(null);
  const requestedSelection = controlled ? selectedRunId : internalSelection;
  const selection = resolveSubagentSelection(runs, requestedSelection);
  const selectedRun = runs.find((run) => run.runId === selection) ?? null;
  useSubagentSelectionRestoreRunRepair(restoreRunIdRef, selectedRun?.runId ?? null, runs);
  const detailSnapshot = matchingDetailSnapshot(selectedRun, selectedRunSnapshot);
  const hasActiveRuns = splitSubagentRunViews(runs).active.length > 0;
  const stopPendingRunIdSet = React.useMemo(() => new Set(stopPendingRunIds), [stopPendingRunIds]);
  const presentationByRunId = React.useMemo(
    () =>
      new Map<string, SubagentRunPresentation>(
        runs.map((run) => [
          run.runId,
          stopPendingRunIdSet.has(run.runId)
            ? { state: "stopping", label: "Stopping…" }
            : deriveSubagentRunPresentation(run, handoffSnapshots, now, 120_000),
        ]),
      ),
    [handoffSnapshots, now, runs, stopPendingRunIdSet],
  );
  const selectedPresentation = selectedRun ? presentationByRunId.get(selectedRun.runId) : undefined;
  const hasUndelayedHandoff = React.useMemo(
    () => [...presentationByRunId.values()].some(({ state }) => state === "saving"),
    [presentationByRunId],
  );
  const pendingDetailLoading = subagentDetailPendingLoading(
    selectedRun !== null,
    detailSnapshot !== null,
    detailLoading,
    detailError,
  );
  const detailFocusFrame = selectedRun
    ? `${compact ? `compact:${compactView}` : "wide"}:${subagentDetailFocusFrame(
        selectedRun,
        detailSnapshot !== null,
        pendingDetailLoading,
        detailRequestVersion,
      )}`
    : null;
  const detailLifecyclePresentation =
    subagentDetailPresentation(
      selectedRun !== null,
      detailSnapshot !== null,
      pendingDetailLoading,
    ) ?? "unavailable";
  const savedDetail = Boolean(selectedRun?.referenceMessageId);
  const savedDetailRefreshing = savedDetail && detailSnapshot !== null && detailLoading;
  const savedDetailRefreshError = savedDetail && detailSnapshot !== null ? detailError : null;
  const selectedStopPending = Boolean(selectedRun && stopPendingRunIdSet.has(selectedRun.runId));
  const selectedStopError = selectedRun ? (stopErrorsByRunId[selectedRun.runId] ?? null) : null;
  const detailAnnouncementPresentation: SubagentDetailAnnouncementState["presentation"] =
    selectedStopPending
      ? "stopping"
      : selectedStopError
        ? "stop_failed"
        : selectedPresentation?.state === "saving" || selectedPresentation?.state === "save_delayed"
          ? selectedPresentation.state
          : savedDetailRefreshing
            ? "refreshing"
            : savedDetailRefreshError
              ? "refresh_failed"
              : detailLifecyclePresentation;
  const detailVisible = Boolean(selectedRun && (!compact || compactView === "detail"));
  const detailAnnouncementState: SubagentDetailAnnouncementState | null =
    selectedRun && detailVisible
      ? {
          ownerKey,
          runId: selectedRun.runId,
          label: selectedRun.label,
          saved: savedDetail,
          presentation: detailAnnouncementPresentation,
          ...(selectedPresentation?.label ? { statusLabel: selectedPresentation.label } : {}),
          ...(detailSnapshot?.activity ? { activity: detailSnapshot.activity } : {}),
        }
      : null;

  React.useEffect(() => {
    if (!active || (!hasActiveRuns && !hasUndelayedHandoff)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, hasActiveRuns, hasUndelayedHandoff]);

  React.useLayoutEffect(() => {
    if (detailRequestVersion <= handledDetailRequestVersionRef.current) return;
    if (!active || !selectedRun) return;
    handledDetailRequestVersionRef.current = detailRequestVersion;
    restoreRunIdRef.current = subagentDetailRestoreRunId(selectedRun);
    if (compact) setCompactView("detail");
  }, [active, compact, detailRequestVersion, selectedRun?.runId]);

  React.useLayoutEffect(() => {
    if (!active || !compact || compactView !== "detail" || !selectedRun) return;
    detailHeadingRef.current?.focus();
  }, [active, compact, compactView, selectedRun?.runId]);

  React.useLayoutEffect(() => {
    const previousCompact = previousCompactRef.current;
    previousCompactRef.current = compact;
    if (!active) return;
    const target = subagentPanelBreakpointFocusTarget(
      previousCompact,
      compact,
      focusedSurfaceRef.current,
    );
    if (!target) return;
    pendingBreakpointFocusRef.current = target;
    if (compact) setCompactView(target === "detail" && selectedRun ? "detail" : "roster");
  }, [active, compact, selectedRun]);

  React.useLayoutEffect(() => {
    const target = pendingBreakpointFocusRef.current;
    if (!active || !target) return;
    if (target === "detail") {
      if (compact && compactView !== "detail") return;
      detailHeadingRef.current?.focus();
    } else {
      if (compact && compactView !== "roster") return;
      const buttons =
        panelRef.current?.querySelectorAll<HTMLButtonElement>("[data-subagent-run-id]");
      focusSubagentRosterRun(buttons ?? [], restoreRunIdRef.current ?? selection);
    }
    pendingBreakpointFocusRef.current = null;
  }, [active, compact, compactView, selection]);

  React.useLayoutEffect(() => {
    const previousFrame = previousDetailFocusFrameRef.current;
    previousDetailFocusFrameRef.current = detailFocusFrame;
    if (!active) return;
    if (
      shouldRestoreSubagentDetailFocus(
        detailRegionOwnsFocusRef.current,
        previousFrame,
        detailFocusFrame,
      )
    ) {
      detailHeadingRef.current?.focus();
    }
  }, [active, detailFocusFrame]);

  React.useEffect(() => {
    if (!active) return;
    const previous = previousAnnouncementStateRef.current;
    previousAnnouncementStateRef.current = detailAnnouncementState;
    const message = subagentDetailAnnouncement(previous, detailAnnouncementState);
    if (message) onDetailAnnouncement?.(ownerKey, message);
  }, [
    active,
    detailAnnouncementState?.activity,
    detailAnnouncementState?.label,
    detailAnnouncementState?.ownerKey,
    detailAnnouncementState?.presentation,
    detailAnnouncementState?.runId,
    detailAnnouncementState?.saved,
    detailAnnouncementState?.statusLabel,
    onDetailAnnouncement,
    ownerKey,
  ]);

  const selectRun = (runId: string, trigger: HTMLButtonElement) => {
    restoreRunIdRef.current = runId;
    if (!controlled) setInternalSelection(runId);
    onSelectedRunChange?.(runId);
    if (compact) setCompactView("detail");
    else trigger.focus();
  };

  const showRoster = () => {
    setCompactView("roster");
    if (typeof window === "undefined") return;
    window.requestAnimationFrame(() => {
      const buttons =
        panelRef.current?.querySelectorAll<HTMLButtonElement>("[data-subagent-run-id]");
      focusSubagentRosterRun(buttons ?? [], restoreRunIdRef.current);
    });
  };

  const detailRegion = selectedRun ? (
    <div
      className="min-h-0 min-w-0 flex-1"
      data-subagent-detail-region="true"
      onFocusCapture={() => {
        detailRegionOwnsFocusRef.current = true;
      }}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        detailRegionOwnsFocusRef.current =
          nextTarget instanceof Node && event.currentTarget.contains(nextTarget);
      }}
    >
      {detailSnapshot ? (
        <SubagentDetail
          key={detailSnapshot.runId}
          ref={detailHeadingRef}
          run={detailSnapshot}
          effectActivity={effectActivity}
          onStop={onStopRun}
          stopPending={selectedStopPending}
          stopError={selectedStopError}
          presentation={selectedPresentation}
          refreshing={savedDetailRefreshing}
          refreshError={savedDetailRefreshError}
          onRetryRefresh={onRetryDetail ? () => onRetryDetail(selectedRun.runId) : undefined}
          now={now}
        />
      ) : (
        <SubagentDetailPending
          ref={detailHeadingRef}
          run={selectedRun}
          loading={pendingDetailLoading}
          unavailable={!pendingDetailLoading}
          onRetry={onRetryDetail ? () => onRetryDetail(selectedRun.runId) : undefined}
        />
      )}
    </div>
  ) : null;

  return (
    <div
      ref={panelRef}
      className={cn("flex h-full min-h-0 flex-col bg-popover text-primary", className)}
      data-subagents-layout={compact ? "compact" : "wide"}
      data-subagents-owner={ownerKey}
      onFocusCapture={(event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest("[data-subagent-back]")) {
          focusedSurfaceRef.current = "back";
        } else if (target.closest("[data-subagent-detail-region]")) {
          focusedSurfaceRef.current = "detail";
        } else if (target.closest("[data-subagent-run-id]")) {
          focusedSurfaceRef.current = "roster";
        }
      }}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          focusedSurfaceRef.current = null;
        }
      }}
    >
      {runs.length === 0 ? (
        <div className="m-auto flex flex-col items-center justify-center px-6 py-10 text-center">
          <Text
            as="h2"
            variant="strong"
            tabIndex={-1}
            data-subagent-empty-heading="true"
            className="outline-none"
          >
            No subagents yet
          </Text>
          <Text as="p" variant="small" color="secondary" className="mt-1 max-w-sm">
            Subagents used by this conversation will appear here.
          </Text>
        </div>
      ) : compact ? (
        compactView === "detail" && selectedRun ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-separator px-2 py-2">
              <Button
                variant="transparent"
                size="small"
                onClick={showRoster}
                data-subagent-back="true"
                className="motion-reduce:transition-none"
              >
                <ArrowLeft aria-hidden="true" className="size-4" />
                Back to subagents
              </Button>
            </div>
            {detailRegion}
          </div>
        ) : (
          <SubagentRoster
            runs={runs}
            selectedRunId={selection}
            onSelect={selectRun}
            presentationByRunId={presentationByRunId}
            className="flex-1"
          />
        )
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(12rem,0.42fr)_minmax(0,1fr)]">
          <SubagentRoster
            runs={runs}
            selectedRunId={selection}
            onSelect={selectRun}
            presentationByRunId={presentationByRunId}
            className="border-r border-separator"
          />
          {detailRegion}
        </div>
      )}
    </div>
  );
}

/**
 * Chat and workspace identity own all compact navigation and focus state.
 * Keying the implementation remounts it synchronously when either changes, so
 * a previous chat's detail view can never paint or receive focus for a new one.
 */
export function SubagentsPanel(props: SubagentsPanelProps) {
  const ownerKey = subagentPanelOwnerKey(props.chatId, props.workspaceId);
  const replacementKey = JSON.stringify([
    ownerKey,
    props.runs.map((run) => [run.runId, run.generationId]),
  ]);
  return (
    <SubagentOwnerFocusBoundary
      ownerKey={ownerKey}
      replacementKey={replacementKey}
      active={props.active ?? true}
      fallbackFocusTarget={props.ownerReplacementFallbackFocusTarget}
      className="h-full min-h-0"
    >
      <OwnedSubagentsPanel key={ownerKey} {...props} />
    </SubagentOwnerFocusBoundary>
  );
}
