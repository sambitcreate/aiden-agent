import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  KeyRound,
  Layers3,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { AlertDialog, Badge, Button, Callout, Field, FieldSet, Input, Text, toast } from "../ui";
import { modelInsightsApi } from "../../lib/ipc";
import { ProviderIcon } from "../provider-icon";
import {
  createModelEntries,
  encodeSelection,
  modelBenchmarkPercentiles,
  visibleModelEntries,
  type ModelEntry,
} from "../../lib/model-picker-data";
import {
  distributeCapabilityOnlyModelPadSuggestions,
  emptyModelPadLayout,
  modelPadGridSize,
  modelPadLeftPercent,
  modelPadLayoutsEqual,
  modelPadPointKey,
  modelPadTopPercent,
  moveModelPadPoint,
  nearestAvailableModelPadPoint,
  nextModelPadPlacement,
  readModelPadLayout,
  reflowVisibleModelPadPlacements,
  snapToModelPadGrid,
  writeModelPadLayout,
  MODEL_PAD_INSET_PERCENT,
  MODEL_PAD_RANGE_PERCENT,
  type ModelPadDirection,
  type ModelPadPoint,
} from "../../lib/model-pad-layout";
import {
  beginModelInsightsAction,
  commitModelInsightsState,
  refreshModelInsightsState,
  useModelInsightsStatus,
  useProviders,
  useProvidersModelInfo,
  useSettings,
} from "../../lib/queries";
import type { ModelBenchmarkMetric, ModelInfo } from "../../lib/types";
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

        <div className="mt-3 rounded-control border border-separator/70 bg-background/35 px-3 py-2.5">
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
            Stored with macOS secure encryption; normalized public scores stay in Aiden’s local
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
        description="Aiden will remove the dedicated encrypted key and cached benchmark data from this Mac. Your providers, model list, and saved Model Pad positions will not change."
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

export function ModelPadSettings() {
  const providersQuery = useProviders();
  const providers = providersQuery.data ?? [];
  const catalog = useProvidersModelInfo(providers);
  const modelInsights = useModelInsightsStatus();
  const settings = useSettings();
  const [saved, setSaved] = React.useState(readModelPadLayout);
  const [draft, setDraft] = React.useState(readModelPadLayout);
  const [filter, setFilter] = React.useState("");
  const [activeValue, setActiveValue] = React.useState<string>();
  const [benchmarkMetric, setBenchmarkMetric] = React.useState<ModelBenchmarkMetric>("coding");
  const [activePanel, setActivePanel] = React.useState<"models" | "insights" | null>(null);
  const [dragState, setDragState] = React.useState<ModelPadDragState>();
  const [announcement, setAnnouncement] = React.useState("");
  const padRef = React.useRef<HTMLDivElement | null>(null);
  const catalogRef = React.useRef<HTMLDivElement | null>(null);
  const modelsPanelRef = React.useRef<HTMLElement | null>(null);
  const panelTransitionRef = React.useRef<ViewTransition | null>(null);
  const [catalogScrollState, setCatalogScrollState] = React.useState({
    scrollable: false,
    hasMoreBelow: false,
  });
  const helpId = React.useId();
  const statusId = React.useId();
  const modelsPanelId = React.useId();
  const insightsPanelId = React.useId();
  const managementId = React.useId();

  const infoByValue: Record<string, ModelInfo | undefined> = {};
  providers.forEach((provider) => {
    const data = catalog.data[provider.id];
    for (const modelId of provider.models) {
      infoByValue[encodeSelection(provider.id, modelId)] = data?.[modelId];
    }
  });
  const entries = visibleModelEntries(
    createModelEntries(providers, infoByValue),
    settings.data?.hiddenModelsByProvider,
  );
  const visibleValues = entries.map((entry) => entry.value);
  const gridSize = modelPadGridSize(entries.length);
  const snappedDraftPlacements = reflowVisibleModelPadPlacements(
    draft.placements,
    visibleValues,
    gridSize,
  );
  const snappedSavedPlacements = reflowVisibleModelPadPlacements(
    saved.placements,
    visibleValues,
    gridSize,
  );
  const normalizedDraft = { ...draft, placements: snappedDraftPlacements };
  const normalizedSaved = { ...saved, placements: snappedSavedPlacements };
  const entriesByValue = new Map(entries.map((entry) => [entry.value, entry]));
  const placed = entries.filter((entry) => snappedDraftPlacements[entry.value]);
  const draftPlacementCount = placed.length;
  const query = filter.trim().toLocaleLowerCase();
  const filteredEntries = query
    ? entries.filter((entry) =>
        `${entry.label} ${entry.providerLabel} ${entry.model}`.toLocaleLowerCase().includes(query),
      )
    : entries;
  const benchmarkPercentiles = modelBenchmarkPercentiles(entries, benchmarkMetric);
  const suggestionCount = entries.filter(
    (entry) => !draft.placements[entry.value] && benchmarkPercentiles.has(entry.value),
  ).length;
  const dirty = !modelPadLayoutsEqual(normalizedSaved, normalizedDraft);
  const loading = providersQuery.isLoading || catalog.isLoading;

  const toggleSupportingPanel = (panel: Exclude<typeof activePanel, null>, animate: boolean) => {
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

  const pointForValue = (value: string): ModelPadPoint | undefined =>
    dragState?.value === value ? dragState.point : snappedDraftPlacements[value];

  const occupiedPoints = (exceptValue?: string): ModelPadPoint[] =>
    placed.flatMap((entry) => {
      if (entry.value === exceptValue) return [];
      const placement = pointForValue(entry.value);
      return placement ? [placement] : [];
    });

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

  const updatePlacement = (value: string, point: ModelPadPoint) => {
    setDraft((current) => ({
      ...current,
      placements: {
        ...reflowVisibleModelPadPlacements(current.placements, visibleValues, gridSize),
        [value]: { ...point, xSource: "user", ySource: "user" },
      },
    }));
  };

  const nudgePlacement = (value: string, direction: ModelPadDirection, steps: number) => {
    const placement = snappedDraftPlacements[value];
    if (!placement) return;
    const occupied = visibleValues.flatMap((candidate) =>
      candidate !== value && snappedDraftPlacements[candidate]
        ? [snappedDraftPlacements[candidate]]
        : [],
    );
    const point = moveModelPadPoint(placement, direction, steps, gridSize, occupied);
    if (modelPadPointKey(point, gridSize) === modelPadPointKey(placement, gridSize)) return;
    setDraft((current) => {
      const reflowed = reflowVisibleModelPadPlacements(current.placements, visibleValues, gridSize);
      const currentPlacement = reflowed[value];
      if (!currentPlacement) return current;
      return {
        ...current,
        placements: {
          ...reflowed,
          [value]: {
            ...currentPlacement,
            ...point,
            xSource: direction === "up" || direction === "down" ? currentPlacement.xSource : "user",
            ySource:
              direction === "left" || direction === "right" ? currentPlacement.ySource : "user",
          },
        },
      };
    });
    setAnnouncement(
      `${entriesByValue.get(value)?.label ?? "Model"} moved to ${gridLocation(point, gridSize)}.`,
    );
  };

  const addModel = (value: string) => {
    setDraft((current) => {
      if (current.placements[value]) return current;
      const reflowed = reflowVisibleModelPadPlacements(current.placements, visibleValues, gridSize);
      const visiblePlacements = Object.fromEntries(
        visibleValues.flatMap((candidate) =>
          reflowed[candidate] ? [[candidate, reflowed[candidate]] as const] : [],
        ),
      );
      return {
        ...current,
        placements: {
          ...reflowed,
          [value]: nextModelPadPlacement(visiblePlacements, entries.length),
        },
      };
    });
    setActiveValue(value);
  };

  const removeModel = (value: string) => {
    setDraft((current) => {
      const placements = { ...current.placements };
      delete placements[value];
      return { ...current, placements };
    });
    setActiveValue((current) => (current === value ? undefined : current));
  };

  const suggestUnplaced = () => {
    const placements = { ...snappedDraftPlacements };
    const occupied: ModelPadPoint[] = visibleValues.flatMap((value) =>
      placements[value] ? [placements[value]] : [],
    );

    // OpenRouter's benchmark feed measures capability, not pace. Pack those
    // models across free columns for legibility while keeping X provenance
    // neutral so the presentation spread is never mistaken for speed data.
    const capabilityOnly = entries.flatMap((entry) => {
      if (draft.placements[entry.value]) return [];
      const capabilityPercentile = benchmarkPercentiles.get(entry.value);
      return capabilityPercentile === undefined
        ? []
        : [{ value: entry.value, capabilityPercentile }];
    });
    const distributed = distributeCapabilityOnlyModelPadSuggestions(
      capabilityOnly,
      gridSize,
      occupied,
    );
    Object.assign(placements, distributed);
    setDraft({ ...draft, placements });
  };

  const save = () => {
    try {
      const next = writeModelPadLayout(normalizedDraft);
      setSaved(next);
      setDraft(next);
      toast.success(
        draftPlacementCount === 0
          ? "Model Pad cleared."
          : `${draftPlacementCount} model${draftPlacementCount === 1 ? "" : "s"} saved to your Pad.`,
      );
    } catch {
      toast.error("Aiden couldn’t save your Model Pad on this Mac.");
    }
  };

  const activePoint = activeValue ? pointForValue(activeValue) : undefined;
  const activeColumn = activePoint ? Math.round(activePoint.x * (gridSize - 1)) : -1;
  const activeRow = activePoint ? Math.round((1 - activePoint.y) * (gridSize - 1)) : -1;

  return (
    <FieldSet title="Personal Model Pad" className="model-pad-fieldset">
      <Field
        label="Arrange your models"
        description="Choose the models you want close at hand, then snap them to dots by how capable and responsive they feel for your work. The dot matrix adapts to your visible models."
        orientation="vertical"
        className="model-pad-field"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2" aria-live="polite">
            <Badge>{placed.length} on Pad</Badge>
            <Badge>
              {gridSize}×{gridSize} dots
            </Badge>
            {dirty ? <Badge color="blue">Unsaved changes</Badge> : null}
            {!dirty && placed.length > 0 ? (
              <Badge className="gap-1">
                <Check aria-hidden="true" className="size-3 text-green" />
                Saved locally
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
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
              aria-expanded={activePanel === "insights"}
              aria-controls={insightsPanelId}
              onClick={(event) => toggleSupportingPanel("insights", event.detail > 0)}
            >
              <ProviderIcon providerId="openrouter" providerLabel="OpenRouter" className="size-4" />
              Benchmark insights
            </Button>
            <Button
              size="small"
              variant="transparent"
              onClick={() => setDraft(saved)}
              disabled={!dirty}
            >
              <Undo2 />
              Reset changes
            </Button>
            <Button size="small" variant="accent" onClick={save} disabled={!dirty}>
              <Save />
              Save Pad
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
                const targeted = column === activeColumn && row === activeRow;
                const occupied = placed.some((entry) => {
                  const placement = pointForValue(entry.value);
                  return (
                    placement &&
                    Math.round(placement.x * (gridSize - 1)) === column &&
                    Math.round((1 - placement.y) * (gridSize - 1)) === row
                  );
                });
                return (
                  <span
                    key={index}
                    aria-hidden="true"
                    className={cn(
                      "model-pad-node absolute size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/16",
                      occupied && "bg-primary/32",
                      targeted && "z-[5] size-1.5 bg-accent ring-4 ring-accent/20",
                    )}
                    style={{
                      left: `${MODEL_PAD_INSET_PERCENT + (column / (gridSize - 1)) * MODEL_PAD_RANGE_PERCENT}%`,
                      top: `${MODEL_PAD_INSET_PERCENT + (row / (gridSize - 1)) * MODEL_PAD_RANGE_PERCENT}%`,
                    }}
                  />
                );
              })}

              {placed.length === 0 ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-10 text-center">
                  <Text as="p" variant="small" color="secondary" className="max-w-52 text-pretty">
                    Add a few models from the list, then drag them into place.
                  </Text>
                </div>
              ) : null}

              {placed.map((entry) => {
                const placement = pointForValue(entry.value);
                const sourcePlacement = snappedDraftPlacements[entry.value];
                if (!placement || !sourcePlacement) return null;
                const selected = activeValue === entry.value;
                const dragging = dragState?.value === entry.value;
                const personalPlacement =
                  sourcePlacement.xSource === "user" && sourcePlacement.ySource === "user";
                const placementSourceDescription = personalPlacement
                  ? "Placed by you"
                  : "Benchmark-assisted";
                const labelAlign =
                  placement.x < 0.16 ? "start" : placement.x > 0.84 ? "end" : "center";
                const labelSide = placement.y > 0.82 ? "bottom" : "top";
                const paceDescription =
                  sourcePlacement.xSource === "neutral"
                    ? "Pace unmeasured; horizontal spread is for readability"
                    : gridLocation(placement, gridSize);
                return (
                  <button
                    key={entry.value}
                    type="button"
                    aria-label={`${placementLabel(entry)}, ${placementSourceDescription}, ${paceDescription}. Drag to another dot; use arrow keys to move one dot.`}
                    aria-pressed={selected}
                    data-placement-source={personalPlacement ? "personal" : "benchmark"}
                    data-selected={selected ? "true" : "false"}
                    data-label-align={labelAlign}
                    data-label-side={labelSide}
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
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
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
                        updatePlacement(entry.value, point);
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
                        entry.value,
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
                      <span className="mt-0.5 block truncate text-[11px] font-normal text-secondary">
                        {entry.providerLabel} · {paceDescription}
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
            <div className="model-pad-legend mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-tertiary">
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="model-pad-legend-marker"
                  data-source="personal"
                />
                Placed by you
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="model-pad-legend-marker"
                  data-source="benchmark"
                />
                Benchmark-assisted
              </span>
              <span className="ml-auto">Hover, focus, or select a marker to see its model.</span>
            </div>
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
                    const onPad = Boolean(draft.placements[entry.value]);
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
                          <span className="block truncate text-[11px] text-tertiary">
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
                          onClick={() => (onPad ? removeModel(entry.value) : addModel(entry.value))}
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
                    ? `${suggestionCount} unplaced model${suggestionCount === 1 ? " has" : "s have"} cached capability evidence. Scores set height; horizontal spread is only for readability until you rate pace.`
                    : "No unplaced models currently have cached benchmark positions."
                  : "Connect OpenRouter below to fetch optional capability evidence for your visible models."}
              </Text>
              {modelInsights.data?.ready ? (
                <div
                  className="mt-2 flex flex-wrap gap-1"
                  role="group"
                  aria-label="Benchmark capability metric"
                >
                  {(
                    [
                      ["intelligence", "General"],
                      ["coding", "Coding"],
                      ["agentic", "Agentic"],
                    ] as const
                  ).map(([metric, label]) => (
                    <Button
                      key={metric}
                      size="small"
                      variant={benchmarkMetric === metric ? "accent" : "transparent"}
                      aria-pressed={benchmarkMetric === metric}
                      onClick={() => setBenchmarkMetric(metric)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
            <Button
              size="small"
              onClick={suggestUnplaced}
              disabled={!modelInsights.data?.ready || suggestionCount === 0}
            >
              <ProviderIcon providerId="openrouter" providerLabel="OpenRouter" className="size-4" />
              Suggest unplaced
            </Button>
          </div>
          <ModelPadBenchmarkConnection />
        </section>

        {(draftPlacementCount > 0 ||
          Object.keys(draft.placements).some((value) => !entriesByValue.has(value))) && (
          <details id={managementId} className="model-pad-management group rounded-control">
            <summary className="cursor-default list-none rounded-control px-2 py-1.5 text-small text-secondary outline-none hover:bg-list-hover focus-visible:bg-list-selection">
              Pad management
            </summary>
            <div className="grid gap-2 px-2 pb-2 pt-1">
              {Object.keys(draft.placements).some((value) => !entriesByValue.has(value)) ? (
                <Text as="p" variant="small" color="secondary">
                  Saved positions for temporarily unavailable models are retained and return when
                  those models are available again.
                </Text>
              ) : null}
              {draftPlacementCount > 0 ? (
                <Button
                  size="small"
                  variant="transparent"
                  className="w-fit text-secondary"
                  onClick={() => setDraft(emptyModelPadLayout())}
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
