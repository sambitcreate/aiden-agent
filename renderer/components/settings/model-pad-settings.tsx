import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import {
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  KeyRound,
  Layers3,
  Loader2,
  Pin,
  Plus,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { AlertDialog, Badge, Button, Callout, Field, FieldSet, Input, Text, toast } from "../ui";
import { modelInsightsApi } from "../../lib/ipc";
import { ProviderIcon } from "../provider-icon";
import { ModelPadLegend } from "./model-pad-legend";
import {
  createModelEntries,
  encodeSelection,
  modelBenchmarkPercentiles,
  MODEL_PAD_QUICK_START_LIMIT,
  pinnedAndRecentQuickStart,
  previewBenchmarkSuggestions,
  topBenchmarkSuggestions,
  visibleModelEntries,
  type ModelEntry,
} from "../../lib/model-picker-data";
import {
  addModelPadPlacement,
  distributeCapabilityOnlyModelPadSuggestions,
  modelPadGridSize,
  modelPadGridSizeForPlacements,
  modelPadHasBenchmarkHeight,
  modelPadHeightCaption,
  modelPadLeftPercent,
  modelPadPointKey,
  modelPadTopPercent,
  moveModelPadPoint,
  nearestAvailableModelPadPoint,
  placedVisibleModelPadValues,
  reflowVisibleModelPadPlacements,
  snapToModelPadGrid,
  measureModelPadAvailableSize,
  modelPadLabelPlacement,
  modelPadPlacementKind,
  MODEL_PAD_INSET_PERCENT,
  MODEL_PAD_METRIC_LABELS,
  MODEL_PAD_PLACEMENT_KIND_LABELS,
  MODEL_PAD_RANGE_PERCENT,
  type ModelPadCapabilitySuggestion,
  type ModelPadDirection,
  type ModelPadMetric,
  type ModelPadPoint,
} from "../../lib/model-pad-layout";
import { useModelPadPreferences } from "../../lib/model-pad-preferences";
import type { ModelPadPlacement, ModelPadPlacements } from "../../shared/model-pad-preferences";
import {
  beginModelInsightsAction,
  commitModelInsightsState,
  refreshModelInsightsState,
  useModelInsightsStatus,
  useProviders,
  useProvidersModelInfo,
  useSettings,
} from "../../lib/queries";
import type { ModelInfo } from "../../lib/types";
import { cn } from "../../lib/ui-utils";

function pointFromPointer(event: React.PointerEvent, rect: DOMRect): ModelPadPoint {
  const inset = MODEL_PAD_INSET_PERCENT / 100;
  const range = MODEL_PAD_RANGE_PERCENT / 100;
  const rawX = (event.clientX - rect.left) / rect.width;
  const rawY = (event.clientY - rect.top) / rect.height;
  return {
    x: Math.min(1, Math.max(0, (rawX - inset) / range)),
    y: 1 - Math.min(1, Math.max(0, (rawY - inset) / range)),
  };
}

/** `column:row` of a grid point, rows counted from the top. */
function padCellKey(point: ModelPadPoint, gridSize: number): string {
  return `${Math.round(point.x * (gridSize - 1))}:${Math.round((1 - point.y) * (gridSize - 1))}`;
}

function gridLocation(point: ModelPadPoint, gridSize: number): string {
  const column = Math.round(point.x * (gridSize - 1)) + 1;
  const row = Math.round((1 - point.y) * (gridSize - 1)) + 1;
  return `row ${row}, column ${column}`;
}

function placementLabel(entry: ModelEntry): string {
  return `${entry.label} from ${entry.providerLabel}`;
}

interface ModelPadDragState {
  value: string;
  point: ModelPadPoint;
  displaced: boolean;
}

type ModelInsightsOperation = "connect" | "refresh" | "disconnect";

const MODEL_INSIGHTS_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function modelInsightsDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? MODEL_INSIGHTS_DATE_FORMATTER.format(date) : null;
}

function ModelPadBenchmarkConnection() {
  const queryClient = useQueryClient();
  const statusQuery = useModelInsightsStatus();
  const [keyDraft, setKeyDraft] = React.useState("");
  const [operation, setOperation] = React.useState<ModelInsightsOperation | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);
  const keyInputRef = React.useRef<HTMLInputElement | null>(null);
  const disconnectButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const status = statusQuery.data;
  const busy = operation !== null;
  const fetchedAt = modelInsightsDate(status?.fetchedAt);

  const reconcileAfterFailure = React.useCallback(async () => {
    await refreshModelInsightsState(queryClient).catch(() => undefined);
  }, [queryClient]);

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    const key = keyDraft.trim();
    if (!key || busy) return;
    setOperation("connect");
    setError(null);
    try {
      await beginModelInsightsAction(queryClient);
      const result = await modelInsightsApi.connect(key);
      if (!result.ok) {
        await reconcileAfterFailure();
        setError(result.message);
        toast.error(result.message);
        return;
      }
      setKeyDraft("");
      await commitModelInsightsState(queryClient, result.status);
      toast.success("Model Pad benchmark insights are ready.");
    } catch {
      await reconcileAfterFailure();
      const message = "Aiden couldn’t connect the Model Pad benchmark key.";
      setError(message);
      toast.error(message);
    } finally {
      setOperation(null);
    }
  };

  const refresh = async () => {
    if (busy) return;
    setOperation("refresh");
    setError(null);
    try {
      await beginModelInsightsAction(queryClient);
      const result = await modelInsightsApi.refresh();
      if (!result.ok) {
        await reconcileAfterFailure();
        setError(result.message);
        toast.error(result.message);
        return;
      }
      await commitModelInsightsState(queryClient, result.status);
      toast.success("Latest Model Pad benchmark insights are cached.");
    } catch {
      await reconcileAfterFailure();
      const message = "Aiden couldn’t fetch the latest Model Pad benchmark insights.";
      setError(message);
      toast.error(message);
    } finally {
      setOperation(null);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    setOperation("disconnect");
    setError(null);
    try {
      await beginModelInsightsAction(queryClient);
      const result = await modelInsightsApi.disconnect();
      if (!result.ok) {
        await reconcileAfterFailure();
        setConfirmDisconnect(false);
        setError(result.message);
        toast.error(result.message);
        return;
      }
      setKeyDraft("");
      await commitModelInsightsState(queryClient, result.status);
      setConfirmDisconnect(false);
      toast.success("Model Pad OpenRouter key and benchmark cache removed.");
    } catch {
      await reconcileAfterFailure();
      setConfirmDisconnect(false);
      const message = "Aiden couldn’t remove the Model Pad OpenRouter connection.";
      setError(message);
      toast.error(message);
    } finally {
      setOperation(null);
    }
  };

  return (
    <>
      <Field
        label="OpenRouter key for Model Pad"
        description="Optional. Connect a dedicated key to fetch source-aware benchmark scores; later updates happen only when you choose Fetch latest."
        orientation="vertical"
      >
        <Callout
          aria-live="polite"
          role={statusQuery.isError || error ? "alert" : undefined}
          color={statusQuery.isError || error ? "red" : undefined}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 flex-1 basis-72 items-start gap-2.5">
              {busy ? (
                <Loader2
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 animate-spin text-tertiary"
                />
              ) : status?.ready ? (
                <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-green" />
              ) : statusQuery.isError ? (
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-red" />
              ) : (
                <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-tertiary" />
              )}
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Text variant="small-strong">
                    {status?.ready
                      ? "Benchmark insights ready"
                      : status?.hasKey
                        ? "Key connected"
                        : statusQuery.isLoading
                          ? "Checking"
                          : "Not connected"}
                  </Text>
                  {status?.ready ? <Badge>{status.cachedModelCount} models</Badge> : null}
                  {status?.license ? <Badge>{status.license}</Badge> : null}
                </div>
                <Text as="p" variant="small" color="secondary" className="mt-1">
                  {error ??
                    (statusQuery.isError
                      ? "Aiden couldn’t read the local Model Pad connection."
                      : status?.ready
                        ? `Artificial Analysis scores via OpenRouter${fetchedAt ? ` · Fetched ${fetchedAt}` : ""}.`
                        : status?.hasKey
                          ? "The key is stored securely; fetch when you want a new benchmark snapshot."
                          : "Paste a key below to validate it and fetch the first benchmark snapshot.")}
                </Text>
              </div>
            </div>
            {status?.hasKey ? (
              <div className="flex shrink-0 flex-wrap justify-end gap-2">
                <Button size="small" onClick={() => void refresh()} disabled={busy}>
                  {operation === "refresh" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  {operation === "refresh" ? "Fetching…" : "Fetch latest"}
                </Button>
                <Button
                  ref={disconnectButtonRef}
                  size="small"
                  variant="transparent"
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={busy}
                >
                  Disconnect
                </Button>
              </div>
            ) : null}
          </div>
        </Callout>

        <div className="mt-3 rounded-control bg-background/35 px-3 py-2.5">
          <Text as="p" variant="small-strong">
            Benchmark-only connection
          </Text>
          <Text as="p" variant="small" color="secondary" className="mt-1 text-pretty">
            This key is separate from OpenRouter chat providers. It does not enable inference and
            will not add OpenRouter’s 500+ models to your model list. Aiden sends it only to the
            fixed OpenRouter benchmark endpoint when you choose Connect &amp; fetch or Fetch latest.
          </Text>
        </div>

        <form className="mt-3 flex flex-wrap gap-2" onSubmit={(event) => void connect(event)}>
          <Input
            ref={keyInputRef}
            className="min-w-0 flex-1 basis-72"
            type="password"
            value={keyDraft}
            onChange={(event) => {
              setKeyDraft(event.target.value);
              setError(null);
            }}
            autoComplete="off"
            spellCheck={false}
            placeholder={status?.hasKey ? "Paste a replacement OpenRouter key" : "sk-or-v1-…"}
            aria-label={
              status?.hasKey
                ? "Replacement OpenRouter API key for Model Pad"
                : "OpenRouter API key for Model Pad"
            }
            aria-invalid={Boolean(error)}
            disabled={busy}
          />
          <Button type="submit" size="medium" disabled={!keyDraft.trim() || busy}>
            {operation === "connect" ? <Loader2 className="animate-spin" /> : <KeyRound />}
            {operation === "connect"
              ? "Connecting…"
              : status?.hasKey
                ? "Replace & fetch"
                : "Connect & fetch"}
          </Button>
        </form>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <Text as="p" variant="small" color="secondary" className="min-w-0 flex-1 basis-72">
            Stored with operating-system secure encryption; normalized public scores stay in Aiden’s local
            offline cache. Create or manage keys in{" "}
            <a
              href="https://openrouter.ai/settings/keys"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline decoration-separator underline-offset-2 hover:text-secondary"
            >
              OpenRouter API Keys
              <ExternalLink aria-hidden="true" className="ml-1 inline size-3" />
            </a>
            .
          </Text>
          <div className="flex flex-wrap justify-end gap-2">
            <Badge>Separate key</Badge>
            <Badge>Manual fetch</Badge>
            <Badge>Offline cache</Badge>
          </div>
        </div>
      </Field>

      <AlertDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Model Pad from OpenRouter?"
        description="Aiden will remove the dedicated encrypted key and cached benchmark data from this device. Your providers, model list, and saved Model Pad positions will not change."
        confirmLabel="Disconnect"
        confirmVariant="destructive"
        busy={operation === "disconnect"}
        keepOpenOnConfirm
        returnFocus={() => {
          const button = disconnectButtonRef.current;
          return button?.isConnected ? button : keyInputRef.current;
        }}
        onConfirm={disconnect}
      />
    </>
  );
}

/** A burst of arrow-key nudges with shorter gaps than this is one save and one Undo step. */
const NUDGE_BURST_MS = 500;
const SAVE_ERROR_MESSAGE = "Aiden couldn’t save your Model Pad.";
/** Every action toast shares one id, so only the latest action is ever undoable. */
const ACTION_TOAST_ID = "model-pad-action";

/** A move shown on the Pad ahead of its save: a dropped drag, or an open nudge burst. */
interface PendingModelPadMove {
  value: string;
  /** Provider-qualified, since one model can be on the Pad through two providers. */
  label: string;
  placement: ModelPadPlacement;
  gridSize: number;
  visibleValues: readonly string[];
}

/** One persisted editor action: the layout it produces and its toast. */
interface ModelPadAction {
  placements: ModelPadPlacements;
  message: string;
}

const QUICK_START_LOADING_REASON = "Loading your models…";

const MODEL_PAD_METRICS: readonly ModelPadMetric[] = ["intelligence", "coding", "agentic"];

function addedSuggestionsMessage(count: number): string {
  return `Added ${count} suggestion${count === 1 ? "" : "s"}`;
}

/**
 * Where benchmark suggestions land: existing models reflowed onto the grid the
 * Pad has once the suggestions join it, and the suggestions packed into its
 * free dots by capability. OpenRouter's benchmark feed measures capability, not
 * pace, so the horizontal spread is for legibility and X provenance stays
 * neutral; the spread is never mistaken for speed data.
 */
function layoutBenchmarkSuggestions(
  current: ModelPadPlacements,
  visibleValues: readonly string[],
  suggestions: readonly ModelPadCapabilitySuggestion[],
): { gridSize: number; placements: ModelPadPlacements; added: ModelPadPlacements } | null {
  if (suggestions.length === 0) return null;
  const gridSize = modelPadGridSize(
    placedVisibleModelPadValues(current, visibleValues).length + suggestions.length,
  );
  const placements = reflowVisibleModelPadPlacements(current, visibleValues, gridSize);
  const occupied: ModelPadPoint[] = placedVisibleModelPadValues(placements, visibleValues).map(
    (value) => placements[value],
  );
  const added = distributeCapabilityOnlyModelPadSuggestions(suggestions, gridSize, occupied);
  return Object.keys(added).length > 0 ? { gridSize, placements, added } : null;
}

/** One previewed benchmark suggestion: a ghost marker the user can accept. */
interface ModelPadSuggestion {
  value: string;
  placement: ModelPadPlacement;
}

/**
 * Previewed suggestions (transient, never persisted). Their spots are fixed on
 * the grid for placed + previewed models, so accepting some or all of them
 * never moves the rest.
 */
interface ModelPadSuggestionPreview {
  gridSize: number;
  suggestions: readonly ModelPadSuggestion[];
}

/**
 * One of the empty Pad's quick starts. When it can't run it stays focusable
 * (aria-disabled) so keyboard and screen reader users hear why.
 */
function ModelPadQuickStart({
  icon,
  label,
  disabledReason,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabledReason?: string;
  onClick: () => void;
}) {
  const reasonId = React.useId();
  return (
    <>
      <Button
        size="small"
        // Wraps instead of clipping on a small Pad.
        className={cn(
          "h-auto min-h-7 max-w-full whitespace-normal py-1 text-center",
          disabledReason && "cursor-default opacity-45",
        )}
        aria-disabled={Boolean(disabledReason)}
        aria-describedby={disabledReason ? reasonId : undefined}
        title={disabledReason}
        onClick={() => {
          if (!disabledReason) onClick();
        }}
      >
        {icon}
        {label}
      </Button>
      {disabledReason ? (
        <span id={reasonId} className="sr-only">
          {disabledReason}.
        </span>
      ) : null}
    </>
  );
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
  // The settings query is the only copy of the layout: every action saves
  // straight away, the save updates the query optimistically, and a failed
  // save rolls it back. Only in-progress gestures live in local state.
  const placements = padPreferences.placements;
  const [pendingMove, setPendingMove] = React.useState<PendingModelPadMove>();
  const pendingMoveRef = React.useRef<PendingModelPadMove | undefined>(undefined);
  const nudgeTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Bumped by every save and Undo; an older generation's toast or Undo is stale.
  const saveGenerationRef = React.useRef(0);
  const browseButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const [filter, setFilter] = React.useState("");
  const [activeValue, setActiveValue] = React.useState<string>();
  const benchmarkMetric = padPreferences.metric;
  const [suggestionPreview, setSuggestionPreview] = React.useState<ModelPadSuggestionPreview>();
  // Accept saves still in flight. Their optimistic layout already holds the
  // accepted models, so the preview may look used up; it must survive until
  // the save settles, because a failed save rolls back and shows the ghosts again.
  const [acceptsInFlight, setAcceptsInFlight] = React.useState(0);
  // A value to focus once it renders: a suggestion, or a marker just placed from one.
  const focusValueRef = React.useRef<string | undefined>(undefined);
  const insightsButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const previewButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const [activePanel, setActivePanel] = React.useState<"models" | "insights" | null>(null);
  const [dragState, setDragState] = React.useState<ModelPadDragState>();
  const [announcement, setAnnouncement] = React.useState("");
  const padRef = React.useRef<HTMLDivElement | null>(null);
  const catalogRef = React.useRef<HTMLDivElement | null>(null);
  const modelsPanelRef = React.useRef<HTMLElement | null>(null);
  const panelTransitionRef = React.useRef<ViewTransition | null>(null);

  React.useLayoutEffect(() => {
    const pad = padRef.current;
    const canvas = pad?.parentElement;
    const grid = canvas?.parentElement;
    if (!pad || !canvas || !grid) return;

    // Measure the real settings viewport: window width alone ignores the app
    // sidebar, settings navigation, wrapped controls, and user interface zoom.
    let scrollport = grid.parentElement;
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
      if (grid.style.getPropertyValue("--model-pad-available-size") !== value) {
        grid.style.setProperty("--model-pad-available-size", value);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    // Watch the grid and scrollport only. Observing the canvas height (labels +
    // square) fed legend wrapping back into the square size and made the outline jump.
    observer.observe(grid);
    if (scrollport) observer.observe(scrollport);
    measure();
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [activePanel]);
  const [catalogScrollState, setCatalogScrollState] = React.useState({
    scrollable: false,
    hasMoreBelow: false,
  });
  const helpId = React.useId();
  const statusId = React.useId();
  const modelsPanelId = React.useId();
  const insightsPanelId = React.useId();
  const managementId = React.useId();

  const entries = React.useMemo(() => {
    const infoByValue: Record<string, ModelInfo | undefined> = {};
    providers.forEach((provider) => {
      const data = catalog.data[provider.id];
      for (const modelId of provider.models) {
        infoByValue[encodeSelection(provider.id, modelId)] = data?.[modelId];
      }
    });
    return visibleModelEntries(createModelEntries(providers, infoByValue), hiddenModelsByProvider);
  }, [providers, catalog.data, hiddenModelsByProvider]);
  const visibleValues = React.useMemo(() => entries.map((entry) => entry.value), [entries]);
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
  const snappedPlacements = React.useMemo(() => {
    const snapped = reflowVisibleModelPadPlacements(placements, visibleValues, gridSize);
    // A move waiting for its save is shown at once.
    return pendingMove && snapped[pendingMove.value]
      ? { ...snapped, [pendingMove.value]: pendingMove.placement }
      : snapped;
  }, [placements, visibleValues, gridSize, pendingMove]);
  const placed = React.useMemo(
    () => entries.filter((entry) => snappedPlacements[entry.value]),
    [entries, snappedPlacements],
  );
  const placedCount = placed.length;
  const occupiedCells = React.useMemo(
    () =>
      new Set(
        placed.flatMap((entry) => {
          const point =
            dragState?.value === entry.value ? dragState.point : snappedPlacements[entry.value];
          return point ? [padCellKey(point, gridSize)] : [];
        }),
      ),
    [placed, dragState, snappedPlacements, gridSize],
  );
  // A suggestion whose dot a placed model has taken meanwhile is not offered.
  const shownSuggestions = React.useMemo(
    () =>
      pendingSuggestions.flatMap((suggestion) => {
        const entry = entriesByValue.get(suggestion.value);
        return entry && !occupiedCells.has(padCellKey(suggestion.placement, gridSize))
          ? [{ ...suggestion, entry }]
          : [];
      }),
    [pendingSuggestions, entriesByValue, occupiedCells, gridSize],
  );
  const suggestionCells = React.useMemo(
    () => new Set(shownSuggestions.map(({ placement }) => padCellKey(placement, gridSize))),
    [shownSuggestions, gridSize],
  );
  const previewActive = previewFits && shownSuggestions.length > 0;
  React.useEffect(() => {
    if (!suggestionPreview) return;
    // The Pad outgrew the preview grid, or every suggestion is on the Pad and
    // no accept is still saving: the preview is done.
    if (!previewFits || (!previewActive && acceptsInFlight === 0)) {
      setSuggestionPreview(undefined);
    }
  }, [suggestionPreview, previewFits, previewActive, acceptsInFlight]);
  // The first visit to an empty Pad starts with the model list open. This is
  // decided once, after loading, so it never reopens after the user closes the
  // list or empties the Pad later on.
  const browseAutoOpenSettledRef = React.useRef(false);
  const preferencesReady = padPreferences.ready;
  const loading = providersQuery.isLoading || catalog.isLoading;
  React.useLayoutEffect(() => {
    if (browseAutoOpenSettledRef.current || loading || !preferencesReady) return;
    browseAutoOpenSettledRef.current = true;
    if (placedCount === 0) setActivePanel((current) => current ?? "models");
  }, [loading, preferencesReady, placedCount]);
  const query = filter.trim().toLocaleLowerCase();
  const filteredEntries = query
    ? entries.filter((entry) =>
        `${entry.label} ${entry.providerLabel} ${entry.model}`.toLocaleLowerCase().includes(query),
      )
    : entries;
  const benchmarkPercentiles = React.useMemo(
    () => modelBenchmarkPercentiles(entries, benchmarkMetric),
    [entries, benchmarkMetric],
  );
  const suggestionCount = React.useMemo(
    () =>
      topBenchmarkSuggestions(entries, benchmarkPercentiles, {
        placements,
        limit: Number.POSITIVE_INFINITY,
      }).length,
    [entries, benchmarkPercentiles, placements],
  );
  const hasUnavailablePlacements = Object.keys(placements).some(
    (value) => !entriesByValue.has(value),
  );
  const pinnedModels = padPreferences.pinnedModels;
  const recentModels = padPreferences.recentModels;
  // Only the empty Pad offers quick starts, so skip the lookup otherwise.
  const hasPinnedOrRecentToAdd =
    placedCount === 0 &&
    pinnedAndRecentQuickStart(entries, {
      pinned: pinnedModels,
      recent: recentModels,
      placements,
      limit: 1,
    }).length > 0;
  const quickStartsLoading = loading || !preferencesReady || modelInsights.isLoading;

  const toggleSupportingPanel = (panel: Exclude<typeof activePanel, null>, animate: boolean) => {
    browseAutoOpenSettledRef.current = true;
    const nextPanel = activePanel === panel ? null : panel;
    panelTransitionRef.current?.skipTransition();
    panelTransitionRef.current = null;

    const reduceMotion =
      document.documentElement.dataset.reduceMotion === "true" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduceMotion || !("startViewTransition" in document)) {
      setActivePanel(nextPanel);
      return;
    }

    const transition = document.startViewTransition(() => {
      flushSync(() => setActivePanel(nextPanel));
    });
    panelTransitionRef.current = transition;
    void transition.finished
      .finally(() => {
        if (panelTransitionRef.current === transition) panelTransitionRef.current = null;
      })
      .catch(() => undefined);
  };

  React.useEffect(
    () => () => {
      panelTransitionRef.current?.skipTransition();
    },
    [],
  );

  const updateCatalogScrollState = React.useCallback((element = catalogRef.current) => {
    if (!element) return;
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    const next = {
      scrollable: element.scrollHeight - element.clientHeight > 2,
      hasMoreBelow: remaining > 2,
    };
    setCatalogScrollState((current) =>
      current.scrollable === next.scrollable && current.hasMoreBelow === next.hasMoreBelow
        ? current
        : next,
    );
  }, []);

  React.useLayoutEffect(() => {
    if (activePanel !== "models") return;
    const element = catalogRef.current;
    if (!element) return;
    const update = () => updateCatalogScrollState(element);
    update();
    const frame = requestAnimationFrame(update);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activePanel, filteredEntries.length, loading, updateCatalogScrollState]);

  const scrollToMoreModels = () => {
    const element = catalogRef.current;
    if (!element) return;
    const reduceMotion = document.documentElement.dataset.reduceMotion === "true";
    element.scrollBy({
      top: Math.max(176, element.clientHeight * 0.72),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };

  const scrollToModelBrowser = () => {
    const element = modelsPanelRef.current;
    if (!element) return;
    const reduceMotion = document.documentElement.dataset.reduceMotion === "true";
    element.scrollIntoView({
      block: "start",
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };

  const restorePlacements = React.useCallback(
    (snapshot: ModelPadPlacements) => {
      // Undo supersedes a nudge burst that has not been saved yet.
      clearTimeout(nudgeTimerRef.current);
      pendingMoveRef.current = undefined;
      setPendingMove(undefined);
      saveGenerationRef.current += 1;
      savePadPreferences({ modelPadPlacements: snapshot }).catch(() => {
        toast.error(SAVE_ERROR_MESSAGE);
      });
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
    (compute: (current: ModelPadPlacements) => ModelPadAction | null) => {
      let snapshot: ModelPadPlacements | undefined;
      let message = "";
      let generation = 0;
      return savePadPreferences((current) => {
        const action = compute(current.placements);
        // A no-op writes nothing and leaves the latest toast undoable.
        if (!action) return {};
        generation = ++saveGenerationRef.current;
        snapshot = current.placements;
        message = action.message;
        return { modelPadPlacements: action.placements };
      }).then(
        () => {
          const before = snapshot;
          if (!before) return false;
          // A later action or Undo owns the toast now; undoing this one
          // would silently revert everything after it.
          if (generation !== saveGenerationRef.current) return true;
          toast(message, {
            id: ACTION_TOAST_ID,
            action: {
              label: "Undo",
              onClick: () => {
                if (generation === saveGenerationRef.current) restorePlacements(before);
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
    const desired = snapToModelPadGrid(pointFromPointer(event, rect), gridSize);
    const point = nearestAvailableModelPadPoint(desired, gridSize, occupiedPoints(value));
    return {
      point,
      displaced: modelPadPointKey(point, gridSize) !== modelPadPointKey(desired, gridSize),
    };
  };

  const dropPlacement = (entry: ModelEntry, point: ModelPadPoint) => {
    showPendingMove({
      value: entry.value,
      label: placementLabel(entry),
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
      ...visibleValues.flatMap((candidate) =>
        candidate !== value && snappedPlacements[candidate] ? [snappedPlacements[candidate]] : [],
      ),
      ...suggestionPoints,
    ];
    const point = moveModelPadPoint(placement, direction, steps, gridSize, occupied);
    if (modelPadPointKey(point, gridSize) === modelPadPointKey(placement, gridSize)) return;
    showPendingMove({
      value,
      label: placementLabel(entry),
      placement: {
        ...placement,
        ...point,
        xSource: direction === "up" || direction === "down" ? placement.xSource : "user",
        ySource: direction === "left" || direction === "right" ? placement.ySource : "user",
      },
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
      return next === current ? null : { placements: next, message: `Added ${placementLabel(entry)}` };
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
      return { placements: next, message: `Removed ${placementLabel(entry)}` };
    });
  };

  const removeAll = () => {
    flushPendingMove();
    setSuggestionPreview(undefined);
    setActiveValue(undefined);
    // Pad management closes once the Pad is empty; keep focus on a stable control.
    browseButtonRef.current?.focus();
    void persistAction((current) =>
      Object.keys(current).length > 0 ? { placements: {}, message: "Cleared the Pad" } : null,
    );
  };

  // A quick start removes the empty-Pad overlay (and the focused button with
  // it). Focus the first placed marker so arranging can start at once, or
  // Browse models when nothing was placed.
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
        browseButtonRef.current?.focus();
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
      );
      if (!layout) return null;
      return {
        placements: { ...layout.placements, ...layout.added },
        message: addedSuggestionsMessage(Object.keys(layout.added).length),
      };
    });
  };

  /**
   * Show up to eight suggestions for `percentiles` as ghosts on the Pad, saving
   * nothing. Focus moves to the first one only when asked (the Preview button).
   */
  const previewSuggestions = ({
    percentiles = benchmarkPercentiles,
    focus = true,
  }: { percentiles?: ReadonlyMap<string, number>; focus?: boolean } = {}) => {
    flushPendingMove();
    const chosen = previewBenchmarkSuggestions(entries, percentiles, {
      placements,
      pinned: pinnedModels,
      recent: recentModels,
    });
    const layout = layoutBenchmarkSuggestions(placements, visibleValues, chosen);
    const suggestions = layout
      ? chosen.flatMap(({ value }) =>
          layout.added[value] ? [{ value, placement: layout.added[value] }] : [],
        )
      : [];
    setSuggestionPreview(
      layout && suggestions.length > 0 ? { gridSize: layout.gridSize, suggestions } : undefined,
    );
    if (focus) focusValueRef.current = suggestions[0]?.value;
    setAnnouncement(
      suggestions.length > 0
        ? `${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"} shown on the Pad. Accept one at a time, or accept all.`
        : "No suggestions to show.",
    );
  };

  const changeMetric = (metric: ModelPadMetric) => {
    if (metric === benchmarkMetric) return;
    savePadPreferences({ modelPadMetric: metric }).catch(() => {
      toast.error(SAVE_ERROR_MESSAGE);
      // The ghosts were laid out for the score that didn't save.
      setSuggestionPreview(undefined);
    });
    // An open preview follows the new score; focus stays on the metric buttons.
    if (suggestionPreview) {
      previewSuggestions({ percentiles: modelBenchmarkPercentiles(entries, metric), focus: false });
    }
  };

  /** Keep focus near the suggestions once the one that had it goes away. */
  const focusAfterAccepting = (value: string) => {
    if (document.activeElement?.getAttribute("data-value") !== value) return;
    const remaining = shownSuggestions.filter((suggestion) => suggestion.value !== value);
    const index = shownSuggestions.findIndex((suggestion) => suggestion.value === value);
    focusValueRef.current = (remaining[index] ?? remaining[index - 1])?.value ?? value;
  };

  /** Keep the preview alive until an accept's save settles (see `acceptsInFlight`). */
  const trackAccept = (save: Promise<boolean>): Promise<boolean> => {
    setAcceptsInFlight((count) => count + 1);
    return save.finally(() => setAcceptsInFlight((count) => count - 1));
  };

  // Accepting never removes a ghost itself. It stops showing once the
  // optimistic layout holds its model (pendingSuggestions skips placed models);
  // a failed save rolls that layout back before the save settles, so the ghost
  // shows again, and the preview stays alive meanwhile (`acceptsInFlight`).
  const acceptSuggestion = (suggestion: ModelPadSuggestion, entry: ModelEntry) => {
    const preview = suggestionPreview;
    if (!preview) return;
    flushPendingMove();
    focusAfterAccepting(suggestion.value);
    const focusTarget = focusValueRef.current;
    void trackAccept(
      persistAction((current) => {
        if (current[suggestion.value]) return null;
        // The Pad already shows its models on the preview grid; save them there.
        const next = reflowVisibleModelPadPlacements(current, visibleValues, preview.gridSize);
        next[suggestion.value] = suggestion.placement;
        return { placements: next, message: `Added ${placementLabel(entry)}` };
      }),
    ).then((saved) => {
      // Never leave focus armed for a marker that will not appear.
      if (!saved && focusValueRef.current === focusTarget) focusValueRef.current = undefined;
    });
  };

  const acceptAllSuggestions = () => {
    const preview = suggestionPreview;
    if (!preview) return;
    const accepted = shownSuggestions;
    flushPendingMove();
    // The preview ends once the saved layout holds every suggestion; a failed
    // save rolls back and leaves the ghosts in place.
    runQuickStart(() =>
      trackAccept(
        persistAction((current) => {
          const next = reflowVisibleModelPadPlacements(current, visibleValues, preview.gridSize);
          let added = 0;
          for (const suggestion of accepted) {
            if (current[suggestion.value]) continue;
            next[suggestion.value] = suggestion.placement;
            added += 1;
          }
          return added > 0 ? { placements: next, message: addedSuggestionsMessage(added) } : null;
        }),
      ),
    );
  };

  const dismissSuggestions = () => {
    setSuggestionPreview(undefined);
    setAnnouncement("Suggestions dismissed.");
    const preview = previewButtonRef.current;
    (preview && !preview.closest("[hidden]") ? preview : insightsButtonRef.current)?.focus();
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
  });

  return (
    <FieldSet className="model-pad-fieldset">
      <Field
        orientation="vertical"
        className="model-pad-field"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2" aria-live="polite">
            <Badge>{placedCount} on Pad</Badge>
            <Badge>
              {gridSize}×{gridSize} dots
            </Badge>
          </div>
          <div className="model-pad-toolbar-actions flex flex-wrap justify-end gap-2">
            <Button
              ref={browseButtonRef}
              size="small"
              variant={activePanel === "models" ? "filled" : "transparent"}
              aria-expanded={activePanel === "models"}
              aria-controls={modelsPanelId}
              onClick={(event) => toggleSupportingPanel("models", event.detail > 0)}
            >
              <Layers3 />
              Browse models
            </Button>
            <Button
              size="small"
              variant={activePanel === "insights" ? "filled" : "transparent"}
              ref={insightsButtonRef}
              aria-expanded={activePanel === "insights"}
              aria-controls={insightsPanelId}
              onClick={(event) => toggleSupportingPanel("insights", event.detail > 0)}
            >
              <ProviderIcon providerId="openrouter" providerLabel="OpenRouter" className="size-4" />
              Benchmark insights
            </Button>
          </div>
        </div>

        {activePanel === "models" ? (
          <div className="model-pad-panel-below">
            <Button
              size="small"
              variant="transparent"
              aria-label="Scroll down to the model list"
              title="Scroll to the model list, or enlarge the window to view it beside the Pad"
              onClick={scrollToModelBrowser}
            >
              Model list below
              <ChevronDown aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
        ) : null}

        <div
          className="settings-model-pad-grid grid gap-4"
          data-panel-open={activePanel === "models" ? "true" : "false"}
        >
          <div className="model-pad-canvas min-w-0">
            <div className="model-pad-axis-label mb-2 flex items-center justify-center">
              More capable
            </div>
            <div
              ref={padRef}
              aria-describedby={`${helpId} ${statusId}`}
              aria-label="Personal Model Pad arrangement"
              role="group"
              data-dragging={dragState ? "true" : "false"}
              data-grid-size={gridSize}
              className="model-pad relative aspect-square w-full touch-none overflow-hidden rounded-card"
              onPointerDown={(event) => {
                const target = event.target;
                if (target instanceof Element && !target.closest(".model-pad-marker")) {
                  setActiveValue(undefined);
                }
              }}
            >
              {Array.from({ length: gridSize * gridSize }, (_, index) => {
                const column = index % gridSize;
                const row = Math.floor(index / gridSize);
                // A node under a marker (including a dragged one) would read as a dot inside
                // a hollow ring, so occupied cells skip it; the marker itself is the affordance.
                const cell = `${column}:${row}`;
                if (occupiedCells.has(cell) || suggestionCells.has(cell)) return null;
                return (
                  <span
                    key={index}
                    aria-hidden="true"
                    data-grid-cell=""
                    className="model-pad-node absolute size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/16"
                    style={{
                      left: `${MODEL_PAD_INSET_PERCENT + (column / (gridSize - 1)) * MODEL_PAD_RANGE_PERCENT}%`,
                      top: `${MODEL_PAD_INSET_PERCENT + (row / (gridSize - 1)) * MODEL_PAD_RANGE_PERCENT}%`,
                    }}
                  />
                );
              })}

              {placedCount === 0 && !previewActive ? (
                <div className="model-pad-empty-state">
                  <div className="model-pad-empty-state-content">
                    <Text
                      as="p"
                      variant="small"
                      color="secondary"
                      className="model-pad-empty-hint max-w-52 text-pretty"
                    >
                      Add a few models from the list, then drag them into place.
                    </Text>
                    <div className="pointer-events-auto flex max-w-full flex-wrap justify-center gap-2">
                      <ModelPadQuickStart
                        icon={<Pin />}
                        label="Add pinned & recent"
                        disabledReason={
                          quickStartsLoading
                            ? QUICK_START_LOADING_REASON
                            : hasPinnedOrRecentToAdd
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
                            : !modelInsights.data?.ready
                              ? "Connect benchmark insights first"
                              : suggestionCount === 0
                                ? "None of your visible models has a score for this benchmark yet"
                                : undefined
                        }
                        onClick={() =>
                          runQuickStart(placeBenchmarkSuggestions)
                        }
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              {placed.map((entry) => {
                const placement = pointForValue(entry.value);
                const sourcePlacement = snappedPlacements[entry.value];
                if (!placement || !sourcePlacement) return null;
                const selected = activeValue === entry.value;
                const dragging = dragState?.value === entry.value;
                const placementKind = modelPadPlacementKind(sourcePlacement);
                const labelPlacement = modelPadLabelPlacement(placement);
                const paceDescription =
                  sourcePlacement.xSource === "neutral"
                    ? "Pace unmeasured; horizontal spread is for readability"
                    : gridLocation(placement, gridSize);
                return (
                  <button
                    key={entry.value}
                    type="button"
                    aria-label={`${placementLabel(entry)}, ${MODEL_PAD_PLACEMENT_KIND_LABELS[placementKind]}, ${paceDescription}. Drag to another dot; use arrow keys to move one dot.`}
                    aria-pressed={selected}
                    data-value={entry.value}
                    data-placement-source={placementKind}
                    data-selected={selected ? "true" : "false"}
                    data-label-align={labelPlacement.align}
                    data-label-side={labelPlacement.side}
                    className={cn(
                      "model-pad-chip model-pad-marker group absolute z-10 grid size-6 -translate-x-1/2 -translate-y-1/2 cursor-grab place-items-center rounded-full bg-transparent outline-none transition-[left,top,opacity] duration-150 ease-out active:cursor-grabbing focus-visible:outline-none",
                      selected && "z-30",
                      dragging && "z-30 cursor-grabbing opacity-80 duration-75",
                    )}
                    style={{
                      left: `${modelPadLeftPercent(placement.x)}%`,
                      top: `${modelPadTopPercent(placement.y)}%`,
                    }}
                    onFocus={() => setActiveValue(entry.value)}
                    onBlur={flushPendingMove}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      flushPendingMove();
                      setActiveValue(entry.value);
                      event.currentTarget.focus();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      const snapped = snapPointer(entry.value, event);
                      if (snapped) setDragState({ value: entry.value, ...snapped });
                    }}
                    onPointerMove={(event) => {
                      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                      const snapped = snapPointer(entry.value, event);
                      if (snapped) setDragState({ value: entry.value, ...snapped });
                    }}
                    onPointerUp={(event) => {
                      const snapped = snapPointer(entry.value, event);
                      const point = snapped?.point ?? dragState?.point;
                      const displaced = snapped?.displaced ?? dragState?.displaced ?? false;
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      }
                      const moved =
                        point &&
                        modelPadPointKey(point, gridSize) !==
                          modelPadPointKey(sourcePlacement, gridSize);
                      if (point && moved) {
                        dropPlacement(entry, point);
                        setAnnouncement(
                          `${entry.label} moved to ${gridLocation(point, gridSize)}.${
                            displaced
                              ? " The requested dot was occupied, so Aiden used the closest open dot."
                              : ""
                          }`,
                        );
                      }
                      setDragState(undefined);
                    }}
                    onPointerCancel={(event) => {
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      }
                      setDragState(undefined);
                      setAnnouncement(`${entry.label} movement cancelled.`);
                    }}
                    onKeyDown={(event) => {
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
                      nudgePlacement(
                        entry,
                        direction as ModelPadDirection,
                        event.shiftKey ? 3 : 1,
                      );
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="model-pad-marker-visual block size-3 rounded-full"
                    />
                    <span aria-hidden="true" className="model-pad-marker-label">
                      <span className="block truncate text-small-strong text-primary">
                        {entry.label}
                      </span>
                      <span className="mt-0.5 block truncate text-mini font-normal text-secondary">
                        {entry.providerLabel} · {paceDescription}
                      </span>
                    </span>
                  </button>
                );
              })}

              {shownSuggestions.map(({ entry, ...suggestion }) => {
                const labelPlacement = modelPadLabelPlacement(suggestion.placement);
                return (
                  <button
                    key={suggestion.value}
                    type="button"
                    aria-label={`Accept suggestion: ${placementLabel(entry)}`}
                    data-value={suggestion.value}
                    data-placement-source="suggestion"
                    data-label-align={labelPlacement.align}
                    data-label-side={labelPlacement.side}
                    className="model-pad-marker absolute z-10 grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-transparent outline-none focus-visible:outline-none"
                    style={{
                      left: `${modelPadLeftPercent(suggestion.placement.x)}%`,
                      top: `${modelPadTopPercent(suggestion.placement.y)}%`,
                    }}
                    onClick={() => acceptSuggestion(suggestion, entry)}
                  >
                    <span
                      aria-hidden="true"
                      className="model-pad-marker-visual block size-3 rounded-full"
                    />
                    <span aria-hidden="true" className="model-pad-marker-label">
                      <span className="block truncate text-small-strong text-primary">
                        {entry.label}
                      </span>
                      <span className="mt-0.5 block truncate text-mini font-normal text-secondary">
                        {entry.providerLabel} · Suggested · Click to accept
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="model-pad-axis-label mt-2 flex items-center justify-between">
              <span>Faster</span>
              <span>More deliberate</span>
            </div>
            <ModelPadLegend
              heightCaption={
                previewActive || modelPadHasBenchmarkHeight(placements, visibleValues)
                  ? modelPadHeightCaption(benchmarkMetric)
                  : undefined
              }
              showSuggestions={previewActive}
            >
              {previewActive ? (
                <span
                  role="group"
                  aria-label="Benchmark suggestions"
                  className="flex flex-wrap items-center gap-2"
                >
                  <Button size="small" onClick={acceptAllSuggestions}>
                    Accept all ({shownSuggestions.length})
                  </Button>
                  <Button size="small" variant="transparent" onClick={dismissSuggestions}>
                    Dismiss
                  </Button>
                </span>
              ) : null}
            </ModelPadLegend>
            <p id={helpId} className="sr-only">
              Move models vertically by personal capability and horizontally by perceived response
              pace. This Pad has {gridSize} rows and {gridSize} columns. Arrow keys move one dot;
              Shift plus an arrow moves three dots. Occupied dots are skipped.
            </p>
            <p id={statusId} className="sr-only" aria-live="polite">
              {announcement}
            </p>
          </div>

          <aside
            ref={modelsPanelRef}
            id={modelsPanelId}
            hidden={activePanel !== "models"}
            className="model-pad-browser min-w-0 rounded-card bg-background/35 p-2"
            aria-label="Browse models for the Pad"
          >
            <div className="model-pad-browser-header mb-2 px-1">
              <div className="min-w-0">
                <Text as="h3" variant="small-strong">
                  Browse models
                </Text>
                <Text as="p" variant="small" color="secondary">
                  Add or remove visible models.
                </Text>
              </div>
              <span
                className="model-pad-browser-count"
                aria-label={`${entries.length} models available`}
              >
                <span aria-hidden="true">{entries.length} models</span>
              </span>
            </div>
            <label className="relative block">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-tertiary"
              />
              <Input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter models…"
                aria-label="Filter models available for the Pad"
                className="pl-8"
              />
            </label>
            <div
              className="model-pad-catalog-shell mt-2"
              data-more-below={catalogScrollState.hasMoreBelow ? "true" : "false"}
            >
              <div
                ref={catalogRef}
                className={cn(
                  "model-pad-catalog overflow-y-auto rounded-control bg-background/35 p-1",
                  catalogScrollState.scrollable && "pb-10",
                )}
                onScroll={(event) => updateCatalogScrollState(event.currentTarget)}
              >
                {loading ? (
                  <div className="flex items-center justify-center gap-2 px-3 py-8 text-small text-secondary">
                    <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                    Loading models…
                  </div>
                ) : filteredEntries.length === 0 ? (
                  <Text as="p" variant="small" color="secondary" className="px-3 py-8 text-center">
                    {entries.length === 0
                      ? "Connect or discover a chat model first."
                      : "No models match this filter."}
                  </Text>
                ) : (
                  filteredEntries.map((entry) => {
                    const onPad = Boolean(placements[entry.value]);
                    return (
                      <div
                        key={entry.value}
                        className="flex min-h-11 items-center gap-2 rounded-control px-2 py-1.5 hover:bg-list-hover"
                      >
                        <ProviderIcon
                          providerId={entry.providerId}
                          providerLabel={entry.providerLabel}
                          modelId={entry.model}
                          artwork={entry.providerArtwork}
                          className="size-3.5 text-tertiary"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-small-strong text-primary">
                            {entry.label}
                          </span>
                          <span className="block truncate text-mini text-tertiary">
                            {entry.providerLabel}
                            {entry.isLocal ? " · Local" : " · Hosted"}
                          </span>
                        </span>
                        <Button
                          size="small"
                          variant="transparent"
                          iconOnly
                          aria-label={
                            onPad
                              ? `Remove ${placementLabel(entry)} from Pad`
                              : `Add ${placementLabel(entry)} to Pad`
                          }
                          title={onPad ? "Remove from Pad" : "Add to Pad"}
                          onClick={() => (onPad ? removeModel(entry) : addModel(entry))}
                        >
                          {onPad ? <X /> : <Plus />}
                        </Button>
                      </div>
                    );
                  })
                )}
              </div>
              {catalogScrollState.hasMoreBelow ? (
                <Button
                  size="small"
                  variant="filled"
                  className="model-pad-catalog-more"
                  aria-label="Scroll down to more available models"
                  title="Scroll for more models or enlarge the window"
                  onClick={scrollToMoreModels}
                >
                  More models below
                  <ChevronDown aria-hidden="true" className="size-3.5" />
                </Button>
              ) : null}
            </div>
          </aside>
        </div>

        <section
          id={insightsPanelId}
          hidden={activePanel !== "insights"}
          className="model-pad-disclosure rounded-card bg-well p-3"
          aria-label="Benchmark insights"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-background/45 px-3 py-2.5">
            <div className="min-w-0 flex-1 basis-72">
              <Text as="h3" variant="small-strong">
                Suggest placements
              </Text>
              <Text as="p" variant="small" color="secondary" className="mt-0.5">
                {modelInsights.data?.ready
                  ? suggestionCount > 0
                    ? `${suggestionCount} unplaced model${suggestionCount === 1 ? " has" : "s have"} cached capability evidence. Preview up to ${MODEL_PAD_QUICK_START_LIMIT} on the Pad, then accept the ones you want. Scores set height; horizontal spread is only for readability until you rate pace.`
                    : "No unplaced models currently have cached benchmark positions."
                  : "Connect OpenRouter below to fetch optional capability evidence for your visible models."}
              </Text>
              {modelInsights.data?.ready ? (
                <div
                  className="mt-2 flex flex-wrap gap-1"
                  role="group"
                  aria-label="Benchmark capability metric"
                >
                  {MODEL_PAD_METRICS.map((metric) => (
                    <Button
                      key={metric}
                      size="small"
                      variant={benchmarkMetric === metric ? "accent" : "transparent"}
                      aria-pressed={benchmarkMetric === metric}
                      onClick={() => changeMetric(metric)}
                    >
                      {MODEL_PAD_METRIC_LABELS[metric]}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
            <Button
              ref={previewButtonRef}
              size="small"
              onClick={() => previewSuggestions()}
              disabled={!modelInsights.data?.ready || suggestionCount === 0}
            >
              <ProviderIcon providerId="openrouter" providerLabel="OpenRouter" className="size-4" />
              Preview suggestions
            </Button>
          </div>
          <ModelPadBenchmarkConnection />
        </section>

        {(placedCount > 0 || hasUnavailablePlacements) && (
          <details id={managementId} className="model-pad-management group rounded-control">
            <summary className="cursor-default list-none rounded-control px-2 py-1.5 text-small text-secondary outline-none hover:bg-list-hover focus-visible:bg-list-selection">
              Pad management
            </summary>
            <div className="grid gap-2 px-2 pb-2 pt-1">
              {hasUnavailablePlacements ? (
                <Text as="p" variant="small" color="secondary">
                  Saved positions for temporarily unavailable models are retained and return when
                  those models are available again.
                </Text>
              ) : null}
              {placedCount > 0 ? (
                <Button
                  size="small"
                  variant="transparent"
                  className="w-fit text-secondary"
                  onClick={removeAll}
                >
                  Remove all models from Pad
                </Button>
              ) : null}
            </div>
          </details>
        )}
      </Field>
    </FieldSet>
  );
}
