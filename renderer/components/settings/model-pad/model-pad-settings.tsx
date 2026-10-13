import * as React from "react";
import { Pin } from "lucide-react";
import { FieldSet, Text, toast } from "../../ui";
import { InfoHint } from "../../ui-info-hint";
import { ProviderIcon } from "../../provider-icon";
import {
  alsoViaLabel,
  alsoViaProviders,
  benchmarkCoverage,
  createModelEntries,
  modelBenchmarkPercentiles,
  modelInfoByValue,
  modelPlacementLabel,
  modelSiblings,
  pinnedAndRecentQuickStart,
  previewBenchmarkSuggestions,
  topBenchmarkSuggestions,
  visibleModelEntries,
  type ModelEntry,
} from "../../../lib/model-picker-data";
import {
  addModelPadPlacement,
  distributeCapabilityOnlyModelPadSuggestions,
  measureModelPadAvailableSize,
  modelPadGridSize,
  modelPadGridSizeForPlacements,
  modelPadHeightMetric,
  modelPadPlacementKind,
  modelPadPlacementMetric,
  modelPadPlacementSourceLabel,
  modelPadPointFromPointer,
  modelPadPointKey,
  moveModelPadPoint,
  nearestAvailableModelPadPoint,
  placedVisibleModelPadValues,
  reflowVisibleModelPadPlacements,
  rerankModelPadBenchmarkHeights,
  snapToModelPadGrid,
  MODEL_PAD_METRIC_LABELS,
  type ModelPadCapabilitySuggestion,
  type ModelPadDirection,
  type ModelPadMetric,
  type ModelPadPoint,
} from "../../../lib/model-pad-layout";
import {
  formatModelPace,
  measuredPacePlacements,
  type MeasuredPaceResult,
} from "../../../lib/model-pad-pace";
import { useModelPadPreferences } from "../../../lib/model-pad-preferences";
import {
  sameModelPadPlacements,
  type ModelPadPlacement,
  type ModelPadPlacements,
} from "../../../shared/model-pad-preferences";
import {
  useModelInsightsStatus,
  useModelPaceSummaries,
  useProviders,
  useProvidersModelInfo,
  useSettings,
} from "../../../lib/queries";
import { ModelPadAddPopover } from "./model-pad-add-popover";
import { ModelPadArrangeMenu, ModelPadMetricChip, ModelPadMoreMenu } from "./model-pad-arrange-menu";
import {
  ModelPadCanvas,
  ModelPadPreviewBar,
  ModelPadQuickStart,
  type ModelPadGhostView,
  type ModelPadMarkerView,
} from "./model-pad-canvas";
import { ModelPadDataRows } from "./model-pad-data-rows";
import { ModelPadTray, type ModelPadTrayRow } from "./model-pad-tray";

function gridLocation(point: ModelPadPoint, gridSize: number): string {
  const column = Math.round(point.x * (gridSize - 1)) + 1;
  const row = Math.round((1 - point.y) * (gridSize - 1)) + 1;
  return `row ${row}, column ${column}`;
}

/** How many pinned and recent models the Add list's Recent section lists at most. */
const ADD_RECENT_LIMIT = 5;

/** A benchmark score as the Pad shows it: one decimal at most. */
function formatScore(score: number): string {
  return String(Math.round(score * 10) / 10);
}

function benchmarkScore(entry: ModelEntry, metric: ModelPadMetric): number | undefined {
  const score = entry.info?.benchmark?.[metric];
  return typeof score === "number" && Number.isFinite(score) ? score : undefined;
}

interface ModelPadDragState {
  value: string;
  point: ModelPadPoint;
  displaced: boolean;
}

/** A burst of arrow-key nudges with shorter gaps than this is one save and one Undo step. */
const NUDGE_BURST_MS = 500;
const SAVE_ERROR_MESSAGE = "Aiden couldn’t save your Model Pad.";
/** Every action toast shares one id, so only the latest action is ever undoable. */
const ACTION_TOAST_ID = "model-pad-action";
const STALE_UNDO_MESSAGE = "Can’t undo — the Pad changed since";

/** A move shown on the Pad ahead of its save: a dropped drag, or an open nudge burst. */
interface PendingModelPadMove {
  value: string;
  /** Provider-qualified, since one model can be on the Pad through two providers. */
  label: string;
  placement: ModelPadPlacement;
  gridSize: number;
  visibleValues: readonly string[];
}

/**
 * One persisted editor action: the layout it produces, the benchmark metric
 * when it changes that too, and its toast. An action without a message saves
 * quietly and offers no Undo (a metric switch that moves no height).
 */
interface ModelPadAction {
  placements: ModelPadPlacements;
  metric?: ModelPadMetric;
  message?: string;
}

/** What an Undo restores, and what the Pad must still hold for it to be safe. */
interface ModelPadUndo {
  before: { placements: ModelPadPlacements; metric: ModelPadMetric };
  after: { placements: ModelPadPlacements; metric?: ModelPadMetric };
}

const QUICK_START_LOADING_REASON = "Loading your models…";
const BENCHMARKS_NOT_CONNECTED_REASON = "Connect benchmark scores in Data below first";

function addedSuggestionsMessage(count: number): string {
  return `Added ${count} suggestion${count === 1 ? "" : "s"}`;
}

const MEASURED_PACE_UNAVAILABLE_REASON = "Use a few models in chat first to measure their speed";

function measuredPaceMessage({ updated, lacking, unscored }: MeasuredPaceResult): string {
  const parts = [`Set pace for ${updated.length} model${updated.length === 1 ? "" : "s"}`];
  if (lacking.length > 0) {
    parts.push(`${lacking.length} need${lacking.length === 1 ? "s" : ""} more chats`);
  }
  if (unscored.length > 0) {
    parts.push(`${unscored.length} ha${unscored.length === 1 ? "s" : "ve"} no usable speed`);
  }
  return parts.join(" · ");
}

/**
 * Where benchmark suggestions land: existing models reflowed onto the grid the
 * Pad has once the suggestions join it, and the suggestions packed into its
 * free dots by capability. OpenRouter's benchmark feed measures capability, not
 * pace, so the horizontal spread is for legibility and X provenance stays
 * neutral; the spread is never mistaken for speed data. Each height records
 * the `metric` it came from.
 */
function layoutBenchmarkSuggestions(
  current: ModelPadPlacements,
  visibleValues: readonly string[],
  suggestions: readonly ModelPadCapabilitySuggestion[],
  metric: ModelPadMetric,
): { gridSize: number; placements: ModelPadPlacements; added: ModelPadPlacements } | null {
  if (suggestions.length === 0) return null;
  const gridSize = modelPadGridSize(
    placedVisibleModelPadValues(current, visibleValues).length + suggestions.length,
  );
  const placements = reflowVisibleModelPadPlacements(current, visibleValues, gridSize);
  const occupied: ModelPadPoint[] = placedVisibleModelPadValues(placements, visibleValues).map(
    (value) => placements[value],
  );
  const added: ModelPadPlacements = Object.fromEntries(
    Object.entries(distributeCapabilityOnlyModelPadSuggestions(suggestions, gridSize, occupied)).map(
      ([value, placement]) => [value, { ...placement, yMetric: metric }],
    ),
  );
  return Object.keys(added).length > 0 ? { gridSize, placements, added } : null;
}

/** One previewed benchmark suggestion: a ghost marker the user can keep. */
interface ModelPadSuggestion {
  value: string;
  placement: ModelPadPlacement;
}

/**
 * Previewed suggestions (transient, never persisted). Their spots are fixed on
 * the grid for placed + previewed models, so keeping some or all of them
 * never moves the rest.
 */
interface ModelPadSuggestionPreview {
  gridSize: number;
  /** The score the ghosts were laid out for; their tags name it. */
  metric: ModelPadMetric;
  suggestions: readonly ModelPadSuggestion[];
}

export function ModelPadSettings() {
  const providersQuery = useProviders();
  const providers = React.useMemo(() => providersQuery.data ?? [], [providersQuery.data]);
  const catalog = useProvidersModelInfo(providers);
  const modelInsights = useModelInsightsStatus();
  const settings = useSettings();
  const hiddenModelsByProvider = settings.data?.hiddenModelsByProvider;
  const padPreferences = useModelPadPreferences();
  const savePadPreferences = padPreferences.save;
  // Device-local speed measured from the user's own chats; display-only until
  // the user chooses Pace from my chats.
  const paceQuery = useModelPaceSummaries();
  const paceSummaries = paceQuery.data;
  // The settings query is the only copy of the layout: every action saves
  // straight away, the save updates the query optimistically, and a failed
  // save rolls it back. Only in-progress gestures live in local state.
  const placements = padPreferences.placements;
  const [pendingMove, setPendingMove] = React.useState<PendingModelPadMove>();
  const pendingMoveRef = React.useRef<PendingModelPadMove | undefined>(undefined);
  const nudgeTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Bumped by every save and Undo; an older generation's toast or Undo is stale.
  const saveGenerationRef = React.useRef(0);
  const addButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const arrangeButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const [activeValue, setActiveValue] = React.useState<string>();
  // Shared by a marker and its tray row: hovering (or focusing a row) lights both.
  const [hotValue, setHotValue] = React.useState<string>();
  const benchmarkMetric = padPreferences.metric;
  const [suggestionPreview, setSuggestionPreview] = React.useState<ModelPadSuggestionPreview>();
  // Keep saves still in flight. Their optimistic layout already holds the
  // kept models, so the preview may look used up; it must survive until
  // the save settles, because a failed save rolls back and shows the ghosts again.
  const [acceptsInFlight, setAcceptsInFlight] = React.useState(0);
  // A value to focus once it renders: a suggestion, a marker, or a tray row.
  const focusValueRef = React.useRef<string | undefined>(undefined);
  // A menu action that moved focus on purpose; the closing menu must not take it back.
  const keepFocusOnMenuCloseRef = React.useRef(false);
  const [dragState, setDragState] = React.useState<ModelPadDragState>();
  const [announcement, setAnnouncement] = React.useState("");
  const padRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLDivElement | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const headerRef = React.useRef<HTMLDivElement | null>(null);

  React.useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const body = bodyRef.current;
    if (!canvas || !body) return;

    // Measure the real settings viewport: window width alone ignores the app
    // sidebar, settings navigation, the tray, and user interface zoom.
    let scrollport = body.parentElement;
    while (scrollport && !/(auto|scroll)/u.test(getComputedStyle(scrollport).overflowY)) {
      scrollport = scrollport.parentElement;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const scrollportRect = scrollport?.getBoundingClientRect();
      const viewportBottom = Math.min(
        window.innerHeight,
        scrollportRect?.bottom ?? window.innerHeight,
      );
      // Compensate for page scrolling so scrolling down never grows the Pad.
      const canvasTop = canvas.getBoundingClientRect().top + (scrollport?.scrollTop ?? 0);
      const size = measureModelPadAvailableSize({
        viewportBottom,
        canvasTop,
        canvasWidth: canvas.clientWidth,
        scrollportClientHeight: scrollport?.clientHeight ?? window.innerHeight,
      });
      const value = `${size}px`;
      if (body.style.getPropertyValue("--model-pad-available-size") !== value) {
        body.style.setProperty("--model-pad-available-size", value);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    // Watch the body and scrollport only; observing the canvas height (square +
    // suggestion bar) would feed the bar back into the square size.
    observer.observe(body);
    // The header wraps on a narrow card (and the chip comes and goes), moving the canvas down.
    if (headerRef.current) observer.observe(headerRef.current);
    if (scrollport) observer.observe(scrollport);
    measure();
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, []);
  const focusAdd = React.useCallback(() => addButtonRef.current, []);
  const helpId = React.useId();
  const statusId = React.useId();

  const entries = React.useMemo(
    () =>
      visibleModelEntries(
        createModelEntries(providers, modelInfoByValue(providers, catalog.data)),
        hiddenModelsByProvider,
      ),
    [providers, catalog.data, hiddenModelsByProvider],
  );
  const visibleValues = React.useMemo(() => entries.map((entry) => entry.value), [entries]);
  // Other visible routes to the same model ("Also via …"); placements stay per provider.
  const siblingsByValue = React.useMemo(() => modelSiblings(entries), [entries]);
  const entriesByValue = React.useMemo(
    () => new Map(entries.map((entry) => [entry.value, entry])),
    [entries],
  );
  // Previewed suggestions still waiting for a decision: visible, not on the Pad yet.
  const pendingSuggestions = React.useMemo(
    () =>
      suggestionPreview?.suggestions.filter(
        (suggestion) => entriesByValue.has(suggestion.value) && !placements[suggestion.value],
      ) ?? [],
    [suggestionPreview, entriesByValue, placements],
  );
  // Sized by the placed, visible models (never the catalog), exactly as the
  // composer Pad sizes them, so both surfaces snap saved placements identically.
  const placedGridSize = React.useMemo(
    () => modelPadGridSizeForPlacements(placements, visibleValues),
    [placements, visibleValues],
  );
  // The preview's spots are only valid on its own grid. Models placed from
  // elsewhere (the composer, another window) can outgrow it; that ends the preview.
  const previewFits = Boolean(suggestionPreview && placedGridSize <= suggestionPreview.gridSize);
  // While suggestions are previewed, the Pad shows the grid they were placed on.
  const gridSize =
    suggestionPreview && previewFits && pendingSuggestions.length > 0
      ? suggestionPreview.gridSize
      : placedGridSize;
  const reflowedPlacements = React.useMemo(
    () => reflowVisibleModelPadPlacements(placements, visibleValues, gridSize),
    [placements, visibleValues, gridSize],
  );
  // A move waiting for its save is shown at once, without reflowing for every nudge.
  const snappedPlacements = React.useMemo(
    () =>
      pendingMove && reflowedPlacements[pendingMove.value]
        ? { ...reflowedPlacements, [pendingMove.value]: pendingMove.placement }
        : reflowedPlacements,
    [reflowedPlacements, pendingMove],
  );
  const placed = React.useMemo(
    () => entries.filter((entry) => snappedPlacements[entry.value]),
    [entries, snappedPlacements],
  );
  const placedCount = placed.length;
  // The hot (hovered, or tray-focused) marker, else the focused or selected one,
  // shares its highlight with its siblings. A hot marker that has since left the
  // Pad (removed with the pointer resting on it) no longer counts.
  const hotPlaced = hotValue && snappedPlacements[hotValue] ? hotValue : undefined;
  const linkSource = hotPlaced ?? activeValue;
  const linkedValues = React.useMemo(
    () => new Set(siblingsByValue.get(linkSource ?? "")?.map((entry) => entry.value) ?? []),
    [siblingsByValue, linkSource],
  );
  const occupiedCells = React.useMemo(
    () =>
      new Set(
        placed.flatMap((entry) => {
          const point =
            dragState?.value === entry.value ? dragState.point : snappedPlacements[entry.value];
          return point ? [modelPadPointKey(point, gridSize)] : [];
        }),
      ),
    [placed, dragState, snappedPlacements, gridSize],
  );
  // A suggestion whose dot a placed model has taken meanwhile is not offered.
  const shownSuggestions = React.useMemo(
    () =>
      pendingSuggestions.flatMap((suggestion) => {
        const entry = entriesByValue.get(suggestion.value);
        return entry && !occupiedCells.has(modelPadPointKey(suggestion.placement, gridSize))
          ? [{ ...suggestion, entry }]
          : [];
      }),
    [pendingSuggestions, entriesByValue, occupiedCells, gridSize],
  );
  const hiddenCells = React.useMemo(
    () =>
      new Set([
        ...occupiedCells,
        ...shownSuggestions.map(({ placement }) => modelPadPointKey(placement, gridSize)),
      ]),
    [occupiedCells, shownSuggestions, gridSize],
  );
  const previewActive = previewFits && shownSuggestions.length > 0;
  // The score behind the visible heights, ghosts included: one metric, or mixed.
  const previewMetricForHeights = previewActive ? suggestionPreview?.metric : undefined;
  const heightMetric = React.useMemo(
    () =>
      modelPadHeightMetric(
        placements,
        visibleValues,
        benchmarkMetric,
        previewMetricForHeights ? [previewMetricForHeights] : [],
      ),
    [placements, visibleValues, benchmarkMetric, previewMetricForHeights],
  );
  // The header chip names the score while any visible height comes from it.
  const showMetricChip = previewActive || (placedCount > 0 && heightMetric !== undefined);
  React.useEffect(() => {
    if (!suggestionPreview) return;
    // The Pad outgrew the preview grid, or every suggestion is on the Pad and
    // no keep is still saving: the preview is done.
    if (!previewFits || (!previewActive && acceptsInFlight === 0)) {
      setSuggestionPreview(undefined);
    }
  }, [suggestionPreview, previewFits, previewActive, acceptsInFlight]);
  const preferencesReady = padPreferences.ready;
  const loading = providersQuery.isLoading || catalog.isLoading;
  const coverage = React.useMemo(
    () => benchmarkCoverage(entries, placements),
    [entries, placements],
  );
  const benchmarkPercentiles = React.useMemo(
    () => modelBenchmarkPercentiles(entries, benchmarkMetric),
    [entries, benchmarkMetric],
  );
  // Visible models with some benchmark score but none for the chosen metric.
  const matchedWithoutMetric = coverage.visible.matched - benchmarkPercentiles.size;
  // Coverage counts are only meaningful once every model and its details have loaded.
  const coverageReady = !loading && !providersQuery.isError && !catalog.isError;
  const insightsReady = Boolean(modelInsights.data?.ready);
  // Unplaced visible models with a score for the metric: what suggestions can draw from.
  const suggestionCount = React.useMemo(
    () =>
      entries.filter((entry) => !placements[entry.value] && benchmarkPercentiles.has(entry.value))
        .length,
    [entries, benchmarkPercentiles, placements],
  );
  const placedValues = React.useMemo(() => new Set(Object.keys(placements)), [placements]);
  const pinnedModels = padPreferences.pinnedModels;
  const recentModels = padPreferences.recentModels;
  // Pinned, then recent visible models not on the Pad: the Add list's Recent section.
  const recentToAdd = React.useMemo(
    () =>
      pinnedAndRecentQuickStart(entries, {
        pinned: pinnedModels,
        recent: recentModels,
        placements,
        limit: ADD_RECENT_LIMIT,
      }),
    [entries, pinnedModels, recentModels, placements],
  );
  const quickStartsLoading = loading || !preferencesReady || modelInsights.isLoading;
  const measuredCount = Object.values(paceSummaries ?? {}).filter(
    (summary) => summary.sampleCount > 0,
  ).length;
  const measuredPace = React.useMemo(() => {
    if (paceQuery.isLoading) return { ready: 0, reason: "Loading measured speeds…" };
    if (paceQuery.isError) return { ready: 0, reason: "Couldn’t read measured speeds" };
    if (placedCount === 0) return { ready: 0, reason: "Add models to the Pad first" };
    const result = measuredPacePlacements(placements, visibleValues, paceSummaries ?? {});
    if (result.updated.length === 0) return { ready: 0, reason: MEASURED_PACE_UNAVAILABLE_REASON };
    return {
      ready: result.updated.length,
      reason: result.placements === placements ? "Pace is already up to date" : undefined,
    };
  }, [
    paceQuery.isLoading,
    paceQuery.isError,
    placedCount,
    placements,
    visibleValues,
    paceSummaries,
  ]);
  const suggestUnavailableReason = quickStartsLoading
    ? QUICK_START_LOADING_REASON
    : !insightsReady
      ? BENCHMARKS_NOT_CONNECTED_REASON
      : suggestionCount === 0
        ? `No model off the Pad has a ${MODEL_PAD_METRIC_LABELS[benchmarkMetric]} score`
        : undefined;

  // Saves can settle after the editor is gone (a flushed nudge on unmount);
  // their toast would offer Undo on a page that no longer shows the Pad.
  const mountedRef = React.useRef(false);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      toast.dismiss(ACTION_TOAST_ID);
    };
  }, []);

  /**
   * Undo one action: restore the layout from just before it, but only while
   * the Pad still holds exactly what the action saved. Any later edit (the
   * composer picker, another window) makes the snapshot stale, and restoring
   * it would silently erase that edit, so nothing is saved then.
   */
  const restorePlacements = React.useCallback(
    ({ before, after }: ModelPadUndo) => {
      // Undo supersedes a nudge burst that has not been saved yet.
      clearTimeout(nudgeTimerRef.current);
      pendingMoveRef.current = undefined;
      setPendingMove(undefined);
      saveGenerationRef.current += 1;
      let stale = false;
      savePadPreferences((current) => {
        stale =
          !sameModelPadPlacements(current.placements, after.placements) ||
          (after.metric !== undefined && current.metric !== after.metric);
        if (stale) return {};
        return {
          modelPadPlacements: before.placements,
          ...(after.metric === undefined ? {} : { modelPadMetric: before.metric }),
        };
      }).then(
        () => {
          // Replaces the action toast; its Undo must not carry over.
          if (stale) toast(STALE_UNDO_MESSAGE, { id: ACTION_TOAST_ID, action: undefined });
        },
        () => {
          toast.error(SAVE_ERROR_MESSAGE);
        },
      );
    },
    [savePadPreferences],
  );

  /**
   * Save one action, composed on the latest saved layout. On success the toast
   * offers Undo back to the layout from just before it; on failure the
   * settings query has already rolled back to the persisted layout. Resolves
   * true when the action changed and saved the layout.
   */
  const persistAction = React.useCallback(
    (
      compute: (current: ModelPadPlacements, metric: ModelPadMetric) => ModelPadAction | null,
    ) => {
      let undo: ModelPadUndo | undefined;
      let saved = false;
      let message: string | undefined;
      let generation = 0;
      return savePadPreferences((current) => {
        const action = compute(current.placements, current.metric);
        // A no-op writes nothing and leaves the latest toast undoable.
        if (!action) return {};
        saved = true;
        message = action.message;
        const placementsChanged = action.placements !== current.placements;
        const patch = {
          ...(placementsChanged ? { modelPadPlacements: action.placements } : {}),
          ...(action.metric === undefined ? {} : { modelPadMetric: action.metric }),
        };
        // A quiet action offers no Undo of its own; the latest toast's Undo
        // stays, guarded by the Pad still matching what that action saved.
        if (message === undefined) return patch;
        generation = ++saveGenerationRef.current;
        undo = {
          before: { placements: current.placements, metric: current.metric },
          after: { placements: action.placements, metric: action.metric },
        };
        return patch;
      }).then(
        () => {
          if (!saved) return false;
          const pending = undo;
          if (!pending || message === undefined) return true;
          // A later action or Undo owns the toast now; undoing this one
          // would silently revert everything after it.
          if (generation !== saveGenerationRef.current || !mountedRef.current) return true;
          toast(message, {
            id: ACTION_TOAST_ID,
            action: {
              label: "Undo",
              onClick: () => {
                if (generation === saveGenerationRef.current) restorePlacements(pending);
              },
            },
          });
          return true;
        },
        () => {
          toast.error(SAVE_ERROR_MESSAGE);
          return false;
        },
      );
    },
    [savePadPreferences, restorePlacements],
  );

  /** Save the pending move now (end of a nudge burst, a drop, blur or unmount). */
  const flushPendingMove = React.useCallback(() => {
    clearTimeout(nudgeTimerRef.current);
    nudgeTimerRef.current = undefined;
    const move = pendingMoveRef.current;
    if (!move) return;
    pendingMoveRef.current = undefined;
    void persistAction((current) => {
      const reflowed = reflowVisibleModelPadPlacements(current, move.visibleValues, move.gridSize);
      // The model left the Pad meanwhile (another window, or Undo).
      if (!reflowed[move.value]) return null;
      return {
        placements: { ...reflowed, [move.value]: move.placement },
        message: `Moved ${move.label}`,
      };
    }).finally(() => {
      // The query now holds the move (or rolled back), so stop overlaying it.
      setPendingMove((current) => (current === move ? undefined : current));
    });
  }, [persistAction]);

  React.useEffect(() => () => flushPendingMove(), [flushPendingMove]);

  const showPendingMove = (move: PendingModelPadMove) => {
    pendingMoveRef.current = move;
    setPendingMove(move);
  };

  const pointForValue = (value: string): ModelPadPoint | undefined =>
    dragState?.value === value ? dragState.point : snappedPlacements[value];

  // A previewed suggestion holds its dot, so moved markers go around it.
  const suggestionPoints = shownSuggestions.map((suggestion) => suggestion.placement);

  const occupiedPoints = (exceptValue?: string): ModelPadPoint[] => [
    ...placed.flatMap((entry) => {
      if (entry.value === exceptValue) return [];
      const placement = pointForValue(entry.value);
      return placement ? [placement] : [];
    }),
    ...suggestionPoints,
  ];

  const snapPointer = (
    value: string,
    event: React.PointerEvent,
  ): Pick<ModelPadDragState, "point" | "displaced"> | undefined => {
    const rect = padRef.current?.getBoundingClientRect();
    if (!rect) return undefined;
    const desired = snapToModelPadGrid(modelPadPointFromPointer(event, rect), gridSize);
    const point = nearestAvailableModelPadPoint(desired, gridSize, occupiedPoints(value));
    return {
      point,
      displaced: modelPadPointKey(point, gridSize) !== modelPadPointKey(desired, gridSize),
    };
  };

  const dropPlacement = (entry: ModelEntry, point: ModelPadPoint) => {
    showPendingMove({
      value: entry.value,
      label: modelPlacementLabel(entry),
      placement: { ...point, xSource: "user", ySource: "user" },
      gridSize,
      visibleValues,
    });
    flushPendingMove();
  };

  const nudgePlacement = (entry: ModelEntry, direction: ModelPadDirection, steps: number) => {
    const value = entry.value;
    if (pendingMoveRef.current && pendingMoveRef.current.value !== value) flushPendingMove();
    const pending = pendingMoveRef.current;
    const placement = pending?.value === value ? pending.placement : snappedPlacements[value];
    if (!placement) return;
    const occupied = [
      ...placed.flatMap((candidate) =>
        candidate.value !== value ? [snappedPlacements[candidate.value]] : [],
      ),
      ...suggestionPoints,
    ];
    const point = moveModelPadPoint(placement, direction, steps, gridSize, occupied);
    if (modelPadPointKey(point, gridSize) === modelPadPointKey(placement, gridSize)) return;
    const vertical = direction === "up" || direction === "down";
    // A height the user sets is theirs; it no longer names a benchmark score.
    const { yMetric: _yMetric, ...withoutMetric } = placement;
    showPendingMove({
      value,
      label: modelPlacementLabel(entry),
      placement: vertical
        ? { ...withoutMetric, ...point, ySource: "user" }
        : { ...placement, ...point, xSource: "user" },
      gridSize,
      visibleValues,
    });
    clearTimeout(nudgeTimerRef.current);
    nudgeTimerRef.current = setTimeout(flushPendingMove, NUDGE_BURST_MS);
    setAnnouncement(`${entry.label} moved to ${gridLocation(point, gridSize)}.`);
  };

  const addModel = (entry: ModelEntry) => {
    flushPendingMove();
    // Previewed spots assume the current Pad; adding or removing models invalidates them.
    setSuggestionPreview(undefined);
    setActiveValue(entry.value);
    void persistAction((current) => {
      const next = addModelPadPlacement(current, visibleValues, entry.value);
      return next === current ? null : { placements: next, message: `Added ${modelPlacementLabel(entry)}` };
    });
  };

  const removeModel = (entry: ModelEntry) => {
    flushPendingMove();
    setSuggestionPreview(undefined);
    setActiveValue((current) => (current === entry.value ? undefined : current));
    void persistAction((current) => {
      if (!current[entry.value]) return null;
      const next = { ...current };
      delete next[entry.value];
      return { placements: next, message: `Removed ${modelPlacementLabel(entry)}` };
    });
  };

  const toggleModel = (entry: ModelEntry) =>
    placements[entry.value] ? removeModel(entry) : addModel(entry);

  const setHot = (value: string, hot: boolean) =>
    setHotValue((current) => (hot ? value : current === value ? undefined : current));

  const removeAll = () => {
    flushPendingMove();
    setSuggestionPreview(undefined);
    setActiveValue(undefined);
    void persistAction((current) =>
      Object.keys(current).length > 0 ? { placements: {}, message: "Cleared the Pad" } : null,
    );
  };

  // A quick start removes the empty-Pad overlay (and the focused button with
  // it). Focus the first placed marker so arranging can start at once, or
  // Add when nothing was placed.
  const focusFirstMarkerRef = React.useRef(false);
  React.useEffect(() => {
    if (!focusFirstMarkerRef.current || placedCount === 0) return;
    focusFirstMarkerRef.current = false;
    padRef.current?.querySelector<HTMLElement>(".model-pad-marker")?.focus();
  }, [placedCount]);

  const runQuickStart = (run: () => Promise<boolean>) => {
    focusFirstMarkerRef.current = true;
    void run().then((placedModels) => {
      // When models were placed, the effect above focuses one once they render.
      if (placedModels) return;
      focusFirstMarkerRef.current = false;
      const focused = document.activeElement;
      if (!focused || focused === document.body || !focused.isConnected) {
        addButtonRef.current?.focus();
      }
    });
  };

  const addPinnedAndRecent = () => {
    flushPendingMove();
    return persistAction((current) => {
      const chosen = pinnedAndRecentQuickStart(entries, {
        pinned: pinnedModels,
        recent: recentModels,
        placements: current,
      });
      if (chosen.length === 0) return null;
      // One model at a time, so each lands on the grid the Pad has after it.
      const next = chosen.reduce<ModelPadPlacements>(
        (layout, entry) => addModelPadPlacement(layout, visibleValues, entry.value),
        current,
      );
      return {
        placements: next,
        message: `Added ${chosen.length} model${chosen.length === 1 ? "" : "s"}`,
      };
    });
  };

  /**
   * The Start from benchmarks quick start: place the most capable unplaced
   * models that have a score for the current metric, up to the quick-start limit.
   */
  const placeBenchmarkSuggestions = () => {
    flushPendingMove();
    return persistAction((current) => {
      const layout = layoutBenchmarkSuggestions(
        current,
        visibleValues,
        topBenchmarkSuggestions(entries, benchmarkPercentiles, { placements: current }),
        benchmarkMetric,
      );
      if (!layout) return null;
      return {
        placements: { ...layout.placements, ...layout.added },
        message: addedSuggestionsMessage(Object.keys(layout.added).length),
      };
    });
  };

  /**
   * Show up to eight suggestions for `metric` as ghosts on the Pad, saving
   * nothing. Focus moves to the first one only when asked (Suggest models).
   */
  const previewSuggestions = ({
    metric = benchmarkMetric,
    focus = true,
  }: { metric?: ModelPadMetric; focus?: boolean } = {}): number => {
    flushPendingMove();
    const percentiles =
      metric === benchmarkMetric ? benchmarkPercentiles : modelBenchmarkPercentiles(entries, metric);
    const chosen = previewBenchmarkSuggestions(entries, percentiles, {
      placements,
      pinned: pinnedModels,
      recent: recentModels,
    });
    const layout = layoutBenchmarkSuggestions(placements, visibleValues, chosen, metric);
    const suggestions = layout
      ? chosen.flatMap(({ value }) =>
          layout.added[value] ? [{ value, placement: layout.added[value] }] : [],
        )
      : [];
    setSuggestionPreview(
      layout && suggestions.length > 0
        ? { gridSize: layout.gridSize, metric, suggestions }
        : undefined,
    );
    if (focus && suggestions[0]) {
      focusValueRef.current = suggestions[0].value;
      keepFocusOnMenuCloseRef.current = true;
    }
    setAnnouncement(
      suggestions.length > 0
        ? `${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"} shown on the Pad. Keep one at a time, or keep all.`
        : "No suggestions to show.",
    );
    return suggestions.length;
  };

  /** Set the pace of every placed model with enough measured chats from its speed. */
  const setPaceFromMeasuredSpeed = () => {
    const summaries = paceSummaries;
    if (!summaries) return;
    flushPendingMove();
    // Previewed spots assume the current Pad; moving models invalidates them.
    setSuggestionPreview(undefined);
    void persistAction((current) => {
      const result = measuredPacePlacements(current, visibleValues, summaries);
      // Nothing to measure, or the Pad already shows the measured pace.
      if (result.placements === current) return null;
      return { placements: result.placements, message: measuredPaceMessage(result) };
    });
  };

  /**
   * Switch the benchmark score. Saved benchmark heights with a score for it
   * move to that score's rank (one undoable action); heights without one stay
   * and keep naming their own score.
   */
  const changeMetric = (metric: ModelPadMetric) => {
    if (metric === benchmarkMetric) return;
    flushPendingMove();
    const percentiles = modelBenchmarkPercentiles(entries, metric);
    void persistAction((current, currentMetric) => {
      if (currentMetric === metric) return null;
      const result = rerankModelPadBenchmarkHeights(current, visibleValues, {
        percentiles,
        metric,
        previousMetric: currentMetric,
      });
      return {
        placements: result.placements,
        metric,
        message:
          result.updated.length > 0
            ? `Heights now use ${MODEL_PAD_METRIC_LABELS[metric]} scores`
            : undefined,
      };
    }).then((saved) => {
      // The ghosts were laid out for the score that didn't save.
      if (!saved) setSuggestionPreview(undefined);
    });
    // An open preview follows the new score; focus stays where it is.
    if (suggestionPreview) previewSuggestions({ metric, focus: false });
  };

  /** Keep focus near the suggestions once the one that had it goes away. */
  const focusAfterKeeping = (value: string) => {
    if (document.activeElement?.getAttribute("data-value") !== value) return;
    const remaining = shownSuggestions.filter((suggestion) => suggestion.value !== value);
    const index = shownSuggestions.findIndex((suggestion) => suggestion.value === value);
    focusValueRef.current = (remaining[index] ?? remaining[index - 1])?.value ?? value;
  };

  /** Keep the preview alive until a keep's save settles (see `acceptsInFlight`). */
  const trackAccept = (save: Promise<boolean>): Promise<boolean> => {
    setAcceptsInFlight((count) => count + 1);
    return save.finally(() => setAcceptsInFlight((count) => count - 1));
  };

  // Keeping never removes a ghost itself. It stops showing once the
  // optimistic layout holds its model (pendingSuggestions skips placed models);
  // a failed save rolls that layout back before the save settles, so the ghost
  // shows again, and the preview stays alive meanwhile (`acceptsInFlight`).
  const keepSuggestion = (suggestion: ModelPadSuggestion, entry: ModelEntry) => {
    const preview = suggestionPreview;
    if (!preview) return;
    flushPendingMove();
    focusAfterKeeping(suggestion.value);
    const focusTarget = focusValueRef.current;
    void trackAccept(
      persistAction((current) => {
        if (current[suggestion.value]) return null;
        // The Pad already shows its models on the preview grid; save them there.
        const next = reflowVisibleModelPadPlacements(current, visibleValues, preview.gridSize);
        next[suggestion.value] = suggestion.placement;
        return { placements: next, message: `Added ${modelPlacementLabel(entry)}` };
      }),
    ).then((saved) => {
      // Never leave focus armed for a marker that will not appear.
      if (!saved && focusValueRef.current === focusTarget) focusValueRef.current = undefined;
    });
  };

  const keepAllSuggestions = () => {
    const preview = suggestionPreview;
    if (!preview) return;
    const kept = shownSuggestions;
    flushPendingMove();
    // The preview ends once the saved layout holds every suggestion; a failed
    // save rolls back and leaves the ghosts in place.
    runQuickStart(() =>
      trackAccept(
        persistAction((current) => {
          const next = reflowVisibleModelPadPlacements(current, visibleValues, preview.gridSize);
          let added = 0;
          for (const suggestion of kept) {
            if (current[suggestion.value]) continue;
            next[suggestion.value] = suggestion.placement;
            added += 1;
          }
          return added > 0 ? { placements: next, message: addedSuggestionsMessage(added) } : null;
        }),
      ),
    );
  };

  /**
   * The chip hides once no visible height comes from a benchmark and no
   * preview is open (a score with no suggestions, a failed save, Dismiss…).
   * If it or its menu held focus, Arrange takes it.
   */
  const focusArrangeForGoneChip = React.useCallback(() => {
    const arrange = arrangeButtonRef.current;
    arrange?.focus();
    // The chip's closing menu can still restore focus to its gone trigger; take it back once.
    setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) arrange?.focus();
    }, 0);
  }, []);

  const dismissSuggestions = () => {
    setSuggestionPreview(undefined);
    setAnnouncement("Suggestions dismissed.");
    arrangeButtonRef.current?.focus();
  };

  /** Choosing a tray row focuses its marker, so arrows can move it at once. */
  const showOnPad = (value: string) => {
    setActiveValue(value);
    [...(padRef.current?.querySelectorAll<HTMLElement>(".model-pad-marker") ?? [])]
      .find((element) => element.dataset.value === value)
      ?.focus();
  };

  React.useEffect(() => {
    const value = focusValueRef.current;
    if (!value) return;
    const target = [...(padRef.current?.querySelectorAll<HTMLElement>("[data-value]") ?? [])].find(
      (element) => element.dataset.value === value,
    );
    if (!target) return;
    focusValueRef.current = undefined;
    target.focus();
    // A closing menu can still hold focus for one more render; try again once it is gone.
    if (document.activeElement !== target) {
      setTimeout(() => {
        if (target.isConnected) target.focus();
      }, 0);
    }
  });

  const markers: ModelPadMarkerView[] = placed.flatMap((entry) => {
    const point = pointForValue(entry.value);
    const sourcePlacement = snappedPlacements[entry.value];
    if (!point || !sourcePlacement) return [];
    const paceDescription =
      sourcePlacement.xSource === "neutral"
        ? "Pace unmeasured; horizontal spread is for readability"
        : gridLocation(point, gridSize);
    const paceSummary = paceSummaries?.[entry.value];
    const measuredSpeed =
      paceSummary && paceSummary.sampleCount > 0 ? formatModelPace(paceSummary) : undefined;
    const alsoVia = alsoViaLabel(siblingsByValue.get(entry.value));
    // A benchmark height names the score it came from; any other the current one.
    const markerMetric = modelPadPlacementMetric(sourcePlacement, benchmarkMetric) ?? benchmarkMetric;
    const score = benchmarkScore(entry, markerMetric);
    const scoreLabel =
      score === undefined
        ? undefined
        : `${MODEL_PAD_METRIC_LABELS[markerMetric]} score ${formatScore(score)}`;
    // The tag has room for one detail: measured speed wins over the score.
    const detail = measuredSpeed ?? scoreLabel;
    return [
      {
        value: entry.value,
        point,
        kind: modelPadPlacementKind(sourcePlacement),
        ariaLabel: `${[
          modelPlacementLabel(entry),
          modelPadPlacementSourceLabel(sourcePlacement),
          paceDescription,
          measuredSpeed,
          scoreLabel,
          alsoVia,
        ]
          .filter(Boolean)
          .join(", ")}. Drag to another dot; use arrow keys to move one dot.`,
        selected: activeValue === entry.value,
        dragging: dragState?.value === entry.value,
        linked: linkedValues.has(entry.value),
        hot: hotPlaced === entry.value,
        tag: {
          title: entry.label,
          lines: [
            [entry.providerLabel, alsoVia].filter(Boolean).join(" · "),
            ...(detail ? [detail] : []),
          ],
        },
        handlers: {
          onFocus: () => setActiveValue(entry.value),
          onBlur: flushPendingMove,
          onPointerEnter: () => setHot(entry.value, true),
          onPointerLeave: () => setHot(entry.value, false),
          onPointerDown: (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            flushPendingMove();
            setActiveValue(entry.value);
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            const snapped = snapPointer(entry.value, event);
            if (snapped) setDragState({ value: entry.value, ...snapped });
          },
          onPointerMove: (event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const snapped = snapPointer(entry.value, event);
            if (!snapped) return;
            // Most moves stay on the same dot; only a new dot re-renders the Pad.
            setDragState((previous) =>
              previous?.value === entry.value &&
              previous.displaced === snapped.displaced &&
              modelPadPointKey(previous.point, gridSize) === modelPadPointKey(snapped.point, gridSize)
                ? previous
                : { value: entry.value, ...snapped },
            );
          },
          onPointerUp: (event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            // Only a drag that started on this marker can drop it.
            if (dragState?.value !== entry.value) return;
            const snapped = snapPointer(entry.value, event);
            const dropPoint = snapped?.point ?? dragState.point;
            const displaced = snapped?.displaced ?? dragState.displaced;
            if (modelPadPointKey(dropPoint, gridSize) !== modelPadPointKey(sourcePlacement, gridSize)) {
              dropPlacement(entry, dropPoint);
              setAnnouncement(
                `${entry.label} moved to ${gridLocation(dropPoint, gridSize)}.${
                  displaced
                    ? " The requested dot was occupied, so Aiden used the closest open dot."
                    : ""
                }`,
              );
            }
            setDragState(undefined);
          },
          onPointerCancel: (event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            setDragState(undefined);
            setAnnouncement(`${entry.label} movement cancelled.`);
          },
          onKeyDown: (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setActiveValue(undefined);
              event.currentTarget.blur();
              setAnnouncement(`${entry.label} selection cleared.`);
              return;
            }
            const direction = {
              ArrowLeft: "left",
              ArrowRight: "right",
              ArrowUp: "up",
              ArrowDown: "down",
            }[event.key];
            if (!direction) return;
            event.preventDefault();
            nudgePlacement(entry, direction as ModelPadDirection, event.shiftKey ? 3 : 1);
          },
        },
      },
    ];
  });

  const previewMetric = suggestionPreview?.metric ?? benchmarkMetric;
  const ghosts: ModelPadGhostView[] = shownSuggestions.map(({ entry, ...suggestion }) => {
    const score = benchmarkScore(entry, previewMetric);
    const scoreLabel =
      score === undefined
        ? ""
        : `, ${MODEL_PAD_METRIC_LABELS[previewMetric]} score ${formatScore(score)}`;
    return {
      value: suggestion.value,
      point: suggestion.placement,
      ariaLabel: `Keep suggestion: ${modelPlacementLabel(entry)}${scoreLabel}`,
      hot: hotValue === suggestion.value,
      tag: {
        title: entry.label,
        lines: [
          entry.providerLabel,
          `Click to keep${score === undefined ? "" : ` · ${MODEL_PAD_METRIC_LABELS[previewMetric]} ${formatScore(score)}`}`,
        ],
      },
      onKeep: () => keepSuggestion(suggestion, entry),
      onHotChange: (hot) => setHot(suggestion.value, hot),
    };
  });

  // Top to bottom, then left to right, as the Pad shows them.
  const trayRows: ModelPadTrayRow[] = placed
    .flatMap((entry) => {
      const placement = snappedPlacements[entry.value];
      if (!placement) return [];
      const alsoVia = alsoViaProviders(siblingsByValue.get(entry.value));
      return [
        {
          entry,
          placement,
          kind: modelPadPlacementKind(placement),
          sourceLabel: modelPadPlacementSourceLabel(placement),
          secondary: alsoVia ? `${entry.providerLabel} · also via ${alsoVia}` : entry.providerLabel,
        },
      ];
    })
    .sort((left, right) => right.placement.y - left.placement.y || left.placement.x - right.placement.x)
    .map(({ placement: _placement, ...row }) => row);

  return (
    <>
      <FieldSet className="model-pad-fieldset">
        <div ref={headerRef} className="model-pad-header">
          {placedCount > 0 ? (
            <span className="text-small text-secondary tabular-nums">
              {`${placedCount} model${placedCount === 1 ? "" : "s"}`}
            </span>
          ) : null}
          <InfoHint topic="Pad markers">
            <p>
              <b>Solid</b> — you placed it. <b>Ring</b> — placed from benchmarks or your speed.{" "}
              <b>Dashed</b> — a suggestion; click to keep.
            </p>
            <p>
              Drag a dot, or focus it and use <kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd>{" "}
              (<kbd>⇧</kbd> moves 3). Every change saves; Undo is in the toast.
            </p>
          </InfoHint>
          {showMetricChip ? (
            <ModelPadMetricChip
              metric={benchmarkMetric}
              heightMetric={heightMetric ?? benchmarkMetric}
              onMetricChange={changeMetric}
              onRemovedWithFocus={focusArrangeForGoneChip}
            />
          ) : null}
          {/* The actions wrap together and stay right-aligned on a narrow card. */}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <ModelPadAddPopover
              triggerRef={addButtonRef}
              entries={entries}
              recentEntries={recentToAdd}
              placedValues={placedValues}
              loading={loading}
              recentReady={!loading && preferencesReady}
              onToggle={toggleModel}
            />
            <ModelPadArrangeMenu
              triggerRef={arrangeButtonRef}
              metric={benchmarkMetric}
              onMetricChange={changeMetric}
              suggestUnavailableReason={suggestUnavailableReason}
              onSuggest={() => previewSuggestions()}
              paceReadyCount={measuredPace.ready}
              paceUnavailableReason={measuredPace.reason}
              onPace={setPaceFromMeasuredSpeed}
              onCloseAutoFocus={(event) => {
                if (!keepFocusOnMenuCloseRef.current) return;
                keepFocusOnMenuCloseRef.current = false;
                event.preventDefault();
              }}
            />
            <ModelPadMoreMenu
              removeAllUnavailableReason={placedCount === 0 ? "The Pad is empty" : undefined}
              onRemoveAll={removeAll}
            />
          </div>
        </div>
        <div ref={bodyRef} className="model-pad-body">
          <ModelPadCanvas
            canvasRef={canvasRef}
            padRef={padRef}
            gridSize={gridSize}
            hiddenCells={hiddenCells}
            markers={markers}
            ghosts={ghosts}
            dragging={Boolean(dragState)}
            describedBy={`${helpId} ${statusId}`}
            emptyState={
              placedCount === 0 && !previewActive ? (
                <div className="model-pad-empty-state">
                  <div className="model-pad-empty-state-content">
                    <Text as="p" variant="small-strong" className="model-pad-empty-hint">
                      Your Pad is empty
                    </Text>
                    <div className="pointer-events-auto flex max-w-full flex-col items-stretch gap-1.5">
                      <ModelPadQuickStart
                        icon={<Pin />}
                        label="Add pinned & recent"
                        variant="accent"
                        disabledReason={
                          quickStartsLoading
                            ? QUICK_START_LOADING_REASON
                            : recentToAdd.length > 0
                              ? undefined
                              : "Pin or choose a few models first"
                        }
                        onClick={() => runQuickStart(addPinnedAndRecent)}
                      />
                      <ModelPadQuickStart
                        icon={
                          <ProviderIcon
                            providerId="openrouter"
                            providerLabel="OpenRouter"
                            className="size-4"
                          />
                        }
                        label="Start from benchmarks"
                        disabledReason={
                          quickStartsLoading
                            ? QUICK_START_LOADING_REASON
                            : !insightsReady
                              ? BENCHMARKS_NOT_CONNECTED_REASON
                              : suggestionCount === 0
                                ? "None of your visible models has a score for this benchmark yet"
                                : undefined
                        }
                        onClick={() => runQuickStart(placeBenchmarkSuggestions)}
                      />
                    </div>
                  </div>
                </div>
              ) : null
            }
            previewBar={
              previewActive ? (
                <ModelPadPreviewBar
                  count={shownSuggestions.length}
                  onKeepAll={keepAllSuggestions}
                  onDismiss={dismissSuggestions}
                />
              ) : null
            }
            onBackgroundPointerDown={() => setActiveValue(undefined)}
          >
            <p id={helpId} className="sr-only">
              Move models vertically by personal capability and horizontally by perceived response
              pace. This Pad has {gridSize} rows and {gridSize} columns. Arrow keys move one dot;
              Shift plus an arrow moves three dots. Occupied dots are skipped.
            </p>
            <p id={statusId} className="sr-only" aria-live="polite">
              {announcement}
            </p>
          </ModelPadCanvas>
          <ModelPadTray
            rows={trayRows}
            hotValue={hotPlaced}
            selectedValue={activeValue}
            onHotChange={setHot}
            onShow={showOnPad}
            onRemove={removeModel}
            fallbackFocus={focusAdd}
          />
        </div>
      </FieldSet>
      <ModelPadDataRows
        coverage={insightsReady && coverageReady ? coverage : undefined}
        matchedWithoutMetric={matchedWithoutMetric}
        metric={benchmarkMetric}
        measuredCount={measuredCount}
        fallbackFocus={focusAdd}
      />
    </>
  );
}
