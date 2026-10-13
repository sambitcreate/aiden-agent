// Compact provider + model picker for the composer. A searchable list and a
// tactile spatial pad share the original menu footprint; model metadata stays
// in a separate, read-only detail surface beside the picker.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Text,
  toast,
} from "./ui";
import { ModelPickerPad } from "./model-picker-pad";
import { cn } from "../lib/ui-utils";
import { prefersReducedMotion } from "../lib/appearance-runtime";
import {
  alsoViaLabel,
  createModelEntries,
  encodeSelection,
  modelInfoByValue,
  modelSiblings,
  orderModelEntries,
  positionSavedModels,
  recentModelsForList,
  visibleModelEntries,
  type ModelEntry,
} from "../lib/model-picker-data";
import { useModelPaceSummaries, useProvidersModelInfo } from "../lib/queries";
import {
  BENCHMARK_STALE_DAYS,
  formatListPrice,
  isOlderThanDays,
  showsListPrice,
} from "../lib/model-details";
import { formatModelPace } from "../lib/model-pad-pace";
import type { ModelPaceSummary } from "../shared/model-pace";
import {
  BASE_MODEL_PAD_GRID_SIZE,
  addModelPadPlacement,
  modelPadGridSizeForPlacements,
  modelPadHeightMetric,
  type ModelPadPlacement,
} from "../lib/model-pad-layout";
import { useModelPadPreferences } from "../lib/model-pad-preferences";
import { recordRecentModel } from "../shared/model-pad-preferences";
import type { ModelInfo, Provider } from "../lib/types";
import { Check, Grid2x2Check, Grid2x2Plus, Pin, SlidersHorizontal } from "lucide-react";
import { ModelPadLattice } from "./model-pad-lattice";
import { ProviderIcon } from "./provider-icon";
import type { HiddenModelsByProvider } from "../shared/model-visibility";
import { providerDeploymentLabel } from "../shared/provider-deployment";

interface ModelPickerProps {
  providers: Provider[];
  providerId: string;
  model: string;
  onChange: (providerId: string, model: string) => void;
  disabled?: boolean;
  settingsBlockedReason?: string;
  hiddenModelsByProvider?: HiddenModelsByProvider;
}

const BENCHMARK_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function formatTokens(value: number | undefined): string | null {
  if (!value || !Number.isFinite(value)) return null;
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
  }
  return String(value);
}

function formatBenchmarkDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? BENCHMARK_DATE_FORMATTER.format(date) : null;
}

function formatInputs(info: ModelInfo | undefined): string {
  if (!info?.matched) return "Not listed";
  const inputs = info.inputModalities?.length
    ? info.inputModalities
    : info.vision === true
      ? ["text", "image"]
      : info.vision === false
        ? ["text"]
        : [];
  if (inputs.length === 0) return "Unknown";
  return inputs.map((input) => input.charAt(0).toLocaleUpperCase() + input.slice(1)).join(", ");
}

function formatCapabilities(info: ModelInfo | undefined): string {
  if (!info?.matched) return "Not listed";
  const capabilities = [
    info.reasoning ? "Reasoning" : null,
    info.toolCall ? "Tools" : null,
    info.vision ? "Vision" : null,
    info.openWeights ? "Open weights" : null,
  ].filter((value): value is string => Boolean(value));
  if (capabilities.length > 0) return capabilities.join(", ");
  const hasKnownCapability = [info.reasoning, info.toolCall, info.vision, info.openWeights].some(
    (value) => value !== undefined,
  );
  return hasKnownCapability ? "Standard generation" : "Unknown";
}

function deploymentSuffix(entry: Pick<ModelEntry, "providerId" | "isLocal">): string {
  return ` · ${providerDeploymentLabel(entry.providerId, entry.isLocal).tag}`;
}

function describeModel(entry: ModelEntry): string {
  const details = [
    `Provider ${entry.providerLabel}`,
    providerDeploymentLabel(entry.providerId, entry.isLocal).description,
    `Inputs ${formatInputs(entry.info)}`,
    `Capabilities ${formatCapabilities(entry.info)}`,
  ];
  const context = formatTokens(entry.info?.contextLength);
  const output = formatTokens(entry.info?.outputLimit);
  if (context) details.push(`Context ${context} tokens`);
  if (output) details.push(`Maximum output ${output} tokens`);
  if (entry.info?.benchmark) details.push(`Benchmark ${entry.info.benchmark.sourceLabel}`);
  details.push(`Model ID ${entry.model}`);
  return details.join(". ");
}

function useExternalModelDetails(): boolean {
  const [showDetails, setShowDetails] = React.useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
    return window.matchMedia("(min-width: 620px)").matches;
  });

  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(min-width: 620px)");
    const update = () => setShowDetails(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return showDetails;
}

function EmptyModelPad({
  gridSize,
  onOpenSettings,
  settingsBlockedReason,
}: {
  gridSize: number;
  onOpenSettings: () => void;
  settingsBlockedReason?: string;
}) {
  const blockedReasonId = React.useId();
  return (
    <div className="model-pad relative aspect-square w-full overflow-hidden rounded-card">
      <div aria-hidden="true" className="absolute inset-0 opacity-55">
        <ModelPadLattice gridSize={gridSize} dotClassName="bg-primary/20" />
      </div>
      <div className="absolute inset-0 bg-popover/45 backdrop-blur-[2px]" />
      <div className="relative flex h-full flex-col items-center justify-center px-8 text-center">
        <span className="mb-3 flex size-9 items-center justify-center rounded-full bg-control text-secondary shadow-control">
          <SlidersHorizontal className="size-4.5" />
        </span>
        <Text variant="small-strong" as="h3">
          Your Model Pad is empty
        </Text>
        <Text variant="small" color="secondary" as="p" className="mt-1 max-w-52 text-pretty">
          Choose a few models and arrange them by capability and pace in Settings.
        </Text>
        <Button
          data-model-pad-settings
          size="small"
          className={cn("mt-4", settingsBlockedReason && "opacity-45")}
          onClick={onOpenSettings}
          aria-disabled={Boolean(settingsBlockedReason)}
          aria-describedby={settingsBlockedReason ? blockedReasonId : undefined}
          title={settingsBlockedReason}
        >
          Customize Model Pad
        </Button>
        {settingsBlockedReason ? (
          <Text
            id={blockedReasonId}
            variant="small"
            color="secondary"
            as="p"
            className="mt-2 max-w-52"
          >
            {settingsBlockedReason}.
          </Text>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A secondary action inside a cmdk list row (Pin, Pad toggle). It never chooses
 * the row: pointer presses don't reach cmdk's selection, and Enter is kept from
 * the command root so the button's native activation runs instead.
 */
function ModelRowAction({
  label,
  active,
  onToggle,
  children,
}: {
  label: string;
  /** Pinned or on the Pad: the action stays visible instead of appearing on hover. */
  active: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        "shrink-0 rounded-full p-0.5 text-tertiary outline-none transition-[background-color,box-shadow,color,opacity] duration-150 ease-out hover:bg-list-hover hover:text-secondary active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-none",
        active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
      )}
    >
      {children}
    </button>
  );
}

/** One model row in the List, with its Pin and Pad toggles. */
function ModelListRow({
  entry,
  isActive,
  isPinned,
  isOnPad,
  onChoose,
  onPreview,
  onTogglePin,
  onTogglePad,
}: {
  entry: ModelEntry;
  isActive: boolean;
  isPinned: boolean;
  isOnPad: boolean;
  onChoose: (entry: ModelEntry) => void;
  onPreview: (value: string) => void;
  onTogglePin: (value: string) => void;
  onTogglePad: (value: string) => void;
}) {
  const descriptionId = `model-description-${entry.value.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
  return (
    <CommandItem
      value={entry.value}
      keywords={[entry.label, entry.providerLabel, entry.model, entry.format ?? ""]}
      aria-describedby={descriptionId}
      onSelect={() => onChoose(entry)}
      onMouseEnter={() => onPreview(entry.value)}
      className="group gap-2"
    >
      <ProviderIcon
        providerId={entry.providerId}
        providerLabel={entry.providerLabel}
        modelId={entry.model}
        artwork={entry.providerArtwork}
        className="size-4 text-tertiary"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-small-strong">{entry.label}</span>
        <span className="block truncate text-small text-tertiary">
          {entry.providerLabel}
          {deploymentSuffix(entry)}
        </span>
      </span>
      {entry.format ? (
        <span className="shrink-0 text-small text-tertiary">{entry.format}</span>
      ) : null}
      <span id={descriptionId} className="sr-only">
        {describeModel(entry)}
      </span>
      {isActive ? <Check className="size-4 shrink-0 text-accent" /> : null}
      <ModelRowAction
        label={isPinned ? `Unpin ${entry.label}` : `Pin ${entry.label}`}
        active={isPinned}
        onToggle={() => onTogglePin(entry.value)}
      >
        <Pin className={cn("size-3.5", isPinned && "fill-current text-accent")} />
      </ModelRowAction>
      <ModelRowAction
        label={isOnPad ? `Remove ${entry.label} from Pad` : `Add ${entry.label} to Pad`}
        active={isOnPad}
        onToggle={() => onTogglePad(entry.value)}
      >
        {isOnPad ? (
          <Grid2x2Check className="size-3.5 text-accent" />
        ) : (
          <Grid2x2Plus className="size-3.5" />
        )}
      </ModelRowAction>
    </CommandItem>
  );
}

export function ModelHoverDetails({
  model,
  alsoVia,
  pace,
  metadataLoading,
}: {
  model: ModelEntry | undefined;
  /** Other providers serving the same model, such as "Also via OpenRouter". */
  alsoVia?: string;
  /** Device-local speed measured from this model's chat responses. */
  pace?: ModelPaceSummary;
  metadataLoading: boolean;
}) {
  if (!model) return null;

  const info = model.info;
  const context = formatTokens(info?.contextLength);
  const output = formatTokens(info?.outputLimit);
  const inputs = formatInputs(info);
  const listPrice = showsListPrice(model) ? formatListPrice(info?.cost) : undefined;
  const speed =
    pace && pace.sampleCount >= 1
      ? `${formatModelPace(pace)} (${pace.sampleCount} run${pace.sampleCount === 1 ? "" : "s"})`
      : undefined;
  const benchmarkDate = formatBenchmarkDate(info?.benchmark?.asOf);
  const benchmarkAsOf =
    benchmarkDate && isOlderThanDays(info?.benchmark?.asOf, BENCHMARK_STALE_DAYS)
      ? `${benchmarkDate} (over ${BENCHMARK_STALE_DAYS} days old)`
      : benchmarkDate;
  const benchmark = info?.benchmark;
  const capabilities = [
    info?.vision ? "Vision" : null,
    info?.toolCall ? "Tools" : null,
    info?.reasoning ? "Reasoning" : null,
    info?.openWeights ? "Open weights" : null,
  ].filter((value): value is string => Boolean(value));
  const detailRows = [
    info?.matched ? ["Inputs", inputs] : null,
    info?.parameterCount ? ["Parameters", info.parameterCount] : null,
    context ? ["Context", context] : null,
    output ? ["Max output", output] : null,
    listPrice ? ["List price", listPrice] : null,
    speed ? ["Your speed", speed] : null,
    info?.releaseDate ? ["Released", info.releaseDate] : null,
    info?.knowledge ? ["Knowledge", info.knowledge] : null,
    info?.benchmark?.intelligence !== undefined
      ? ["Intelligence", info.benchmark.intelligence.toFixed(1)]
      : null,
    info?.benchmark?.coding !== undefined ? ["Coding", info.benchmark.coding.toFixed(1)] : null,
    info?.benchmark?.agentic !== undefined ? ["Agentic", info.benchmark.agentic.toFixed(1)] : null,
    benchmarkAsOf ? ["Benchmark as of", benchmarkAsOf] : null,
  ].filter((row): row is [string, string] => Boolean(row));

  return (
    <aside className="pointer-events-auto flex h-[min(22.5rem,70vh)] w-56 shrink-0 flex-col overflow-hidden rounded-popover bg-popover p-3 text-primary shadow-popover">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain">
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 shrink-0 text-tertiary">
          <ProviderIcon
            providerId={model.providerId}
            providerLabel={model.providerLabel}
            modelId={model.model}
            artwork={model.providerArtwork}
            className="size-4"
          />
        </span>
        <div className="min-w-0 flex-1">
          <Text variant="small-strong" as="h3" truncate>
            {model.label}
          </Text>
          <Text variant="small" color="tertiary" as="p" truncate>
            {model.providerLabel}
            {deploymentSuffix(model)}
            {model.format ? ` · ${model.format}` : ""}
          </Text>
          {alsoVia ? (
            <Text variant="small" color="tertiary" as="p" truncate>
              {alsoVia}
            </Text>
          ) : null}
        </div>
      </div>

      {capabilities.length > 0 || detailRows.length > 0 ? (
        <>
          {capabilities.length > 0 ? (
            <p className="mt-2 text-small text-secondary">{capabilities.join(" · ")}</p>
          ) : null}
          {detailRows.length > 0 ? (
            <dl className="mt-2 grid gap-1 border-t border-separator pt-2 text-small">
              {detailRows.map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3">
                  <dt className="shrink-0 text-tertiary">{label}</dt>
                  {/* Values wrap rather than truncate: the tail of a long value
                      (run count, staleness) is the part that matters. */}
                  <dd className="min-w-0 break-words text-right text-secondary tabular-nums">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      ) : (
        <Text
          variant="small"
          color="tertiary"
          as="p"
          className="mt-2 border-t border-separator pt-2"
        >
          {metadataLoading ? "Loading model details…" : "No additional model details."}
        </Text>
      )}

      <div className="mt-2 border-t border-separator pt-2">
        <div
          className="truncate font-mono text-mini leading-4 text-quaternary"
          title={model.model}
        >
          {model.model}
        </div>
        {benchmark ? (
          <a
            href={benchmark.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block text-mini leading-4 text-tertiary underline decoration-separator underline-offset-2 hover:text-secondary"
          >
            {`${benchmark.sourceLabel} · ${benchmark.license}`}
          </a>
        ) : null}
      </div>
      </div>
    </aside>
  );
}

/** Matches the knob's 250ms confirm transition closely enough to read as one beat. */
const PAD_COMMIT_CLOSE_DELAY_MS = 200;
/** One toast for list-row removals, so only the latest removal offers Undo. */
const REMOVE_FROM_PAD_TOAST_ID = "model-picker-remove-from-pad";

export function ModelPicker({
  providers,
  providerId,
  model,
  onChange,
  disabled,
  settingsBlockedReason,
  hiddenModelsByProvider,
}: ModelPickerProps) {
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<"pad" | "list">("list");
  const [search, setSearch] = React.useState("");
  const [previewValue, setPreviewValue] = React.useState<string>();
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const showExternalDetails = useExternalModelDetails();
  const {
    placements: modelPadPlacements,
    pinnedModels: pinned,
    recentModels,
    metric: modelPadMetric,
    save: saveModelPadPreferences,
  } = useModelPadPreferences();
  const pickerId = React.useId();
  const listTabId = `${pickerId}-list-tab`;
  const padTabId = `${pickerId}-pad-tab`;
  const listPanelId = `${pickerId}-list-panel`;
  const padPanelId = `${pickerId}-pad-panel`;

  const catalog = useProvidersModelInfo(providers);
  // Device-local measured speed for the detail card; display-only. Read afresh
  // each time the picker opens so new chats show up without a remount.
  const paceSummaries = useModelPaceSummaries({ enabled: open, staleTime: 0 }).data;
  // The composer re-renders on every streamed token. Keep the catalog derivation
  // keyed on its real inputs, and derive list order and detail positions only
  // while the popover is open.
  // `catalog.data` keeps its identity until some provider's model info changes.
  const allEntries = React.useMemo(
    () => createModelEntries(providers, modelInfoByValue(providers, catalog.data)),
    [providers, catalog.data],
  );
  const entries = React.useMemo(
    () => visibleModelEntries(allEntries, hiddenModelsByProvider),
    [allEntries, hiddenModelsByProvider],
  );
  const positioned = React.useMemo(
    () => positionSavedModels(entries, modelPadPlacements),
    [entries, modelPadPlacements],
  );
  // Other visible routes to the same model, linked visually on the Pad and side card.
  const siblingsByValue = React.useMemo(
    () => (open ? modelSiblings(entries) : new Map<string, ModelEntry[]>()),
    [open, entries],
  );
  const orderedEntries = React.useMemo(
    () => (open ? orderModelEntries(entries, pinned) : []),
    [open, entries, pinned],
  );
  const selectedValue = providerId && model ? encodeSelection(providerId, model) : "";
  // With an empty filter the List groups pinned models, then recent ones, then the
  // rest; a filter shows one flat, ranked list. Each model is listed once.
  const listSections = React.useMemo(() => {
    const recent =
      open && search === ""
        ? recentModelsForList(entries, recentModels, { selectedValue, pinned })
        : [];
    if (!recent.length) return { leading: orderedEntries, recent, rest: [] };
    const pinnedSet = new Set(pinned);
    const recentSet = new Set(recent.map((entry) => entry.value));
    return {
      leading: orderedEntries.filter((entry) => pinnedSet.has(entry.value)),
      recent,
      rest: orderedEntries.filter(
        (entry) => !pinnedSet.has(entry.value) && !recentSet.has(entry.value),
      ),
    };
  }, [open, search, entries, recentModels, selectedValue, pinned, orderedEntries]);
  const hasPadModels = positioned.length > 0;
  // Named only while some model on the Pad takes its height from a benchmark:
  // the score those heights came from, or "mixed" when they differ.
  const heightMetric = React.useMemo(
    () =>
      modelPadHeightMetric(
        modelPadPlacements,
        positioned.map((entry) => entry.value),
        modelPadMetric,
      ),
    [modelPadPlacements, positioned, modelPadMetric],
  );
  // Same sizing as positionSavedModels and the settings editor: placed, visible
  // models only. The empty Pad shows the base grid.
  const padGridSize = React.useMemo(
    () =>
      hasPadModels
        ? modelPadGridSizeForPlacements(
            modelPadPlacements,
            entries.map((entry) => entry.value),
          )
        : BASE_MODEL_PAD_GRID_SIZE,
    [hasPadModels, modelPadPlacements, entries],
  );
  const selected = allEntries.find((entry) => entry.value === selectedValue);
  const selectedPosition = positioned.find((entry) => entry.value === selectedValue);
  // The current model is available but not placed (the Pad may be empty): the Pad
  // shows no active model and offers to add it. A model hidden from the picker
  // could not appear, so it is not offered.
  const selectedOffPad = selectedPosition
    ? undefined
    : entries.find((entry) => entry.value === selectedValue);
  const activePosition: ModelEntry | undefined = !open
    ? undefined
    : view === "pad"
      ? // The empty Pad has no detail card. Otherwise an unplaced current model is
        // described as itself, and an unavailable one leaves the card empty rather
        // than describing a different model.
        hasPadModels
        ? (positioned.find((entry) => entry.value === previewValue) ??
          selectedPosition ??
          selected ??
          (selectedValue ? undefined : positioned[0]))
        : undefined
      : (entries.find((entry) => entry.value === previewValue) ??
        entries.find((entry) => entry.value === selectedValue) ??
        entries[0]);
  const activeAttribution = activePosition?.info?.benchmark
    ? {
        url: activePosition.info.benchmark.sourceUrl,
        label: `${activePosition.info.benchmark.sourceLabel} · ${activePosition.info.benchmark.license}`,
      }
    : null;
  const hasUnavailableSelection = Boolean(selectedValue && !selected);
  const hasModels = entries.length > 0;
  const metadataLoading = catalog.isLoading;
  const unavailableMessage =
    "No chat models are available. Open Settings → Providers to discover models for a connection.";

  const togglePin = React.useCallback(
    (value: string) => {
      // Selection stays usable if saving fails; the pin reverts and says why.
      void saveModelPadPreferences(({ pinnedModels }) => ({
        pinnedModels: pinnedModels.includes(value)
          ? pinnedModels.filter((entry) => entry !== value)
          : [...pinnedModels, value],
      })).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Couldn’t update pinned models.");
      });
    },
    [saveModelPadPreferences],
  );

  const restoreOnPad = React.useCallback(
    (value: string, placement: ModelPadPlacement) => {
      void saveModelPadPreferences(({ placements }) =>
        // Placed again meanwhile (another window): keep that placement.
        placements[value] ? {} : { modelPadPlacements: { ...placements, [value]: placement } },
      ).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Couldn’t update your Pad.");
      });
    },
    [saveModelPadPreferences],
  );

  const toggleOnPad = React.useCallback(
    (value: string) => {
      const visibleValues = entries.map((entry) => entry.value);
      const label = entries.find((entry) => entry.value === value)?.label ?? value;
      let removed: ModelPadPlacement | undefined;
      void saveModelPadPreferences(({ placements }) => {
        removed = undefined;
        if (!placements[value]) {
          return { modelPadPlacements: addModelPadPlacement(placements, visibleValues, value) };
        }
        const { [value]: placement, ...rest } = placements;
        removed = placement;
        return { modelPadPlacements: rest };
      }).then(
        () => {
          // Adding stays quiet; a removal can be undone from its toast.
          const placement = removed;
          if (!placement) return;
          toast(`Removed ${label} from your Pad`, {
            id: REMOVE_FROM_PAD_TOAST_ID,
            action: { label: "Undo", onClick: () => restoreOnPad(value, placement) },
          });
        },
        (error: unknown) => {
          toast.error(error instanceof Error ? error.message : "Couldn’t update your Pad.");
        },
      );
    },
    [entries, saveModelPadPreferences, restoreOnPad],
  );

  const focusPad = React.useCallback(() => {
    contentRef.current
      ?.querySelector<HTMLElement>('[aria-roledescription="two-dimensional model picker"]')
      ?.focus();
  }, []);

  const focusPadAfterAddRef = React.useRef(false);
  const addSelectedToPad = () => {
    if (!selectedOffPad) return;
    const value = selectedOffPad.value;
    const visibleValues = entries.map((entry) => entry.value);
    focusPadAfterAddRef.current = true;
    setPreviewValue(value);
    void saveModelPadPreferences(({ placements }) => ({
      modelPadPlacements: addModelPadPlacement(placements, visibleValues, value),
    })).catch((error: unknown) => {
      focusPadAfterAddRef.current = false;
      toast.error(error instanceof Error ? error.message : "Couldn’t add the model to your Pad.");
    });
  };

  // The Add button disappears once the model is placed; keep focus on the Pad,
  // where the knob now rests on the added model.
  React.useEffect(() => {
    if (!selectedPosition || !focusPadAfterAddRef.current) return;
    focusPadAfterAddRef.current = false;
    focusPad();
  }, [selectedPosition, focusPad]);

  const commit = React.useCallback(
    (entry: ModelEntry, close = false) => {
      if (entry.value !== selectedValue) onChange(entry.providerId, entry.model);
      setPreviewValue(entry.value);
      if (close) setOpen(false);
      // Recents are history: the choice already happened, so a failed write is
      // not worth interrupting anyone for.
      void saveModelPadPreferences(({ recentModels: recent }) => {
        const next = recordRecentModel(recent, entry.value);
        // Already the newest recent: nothing to write.
        const unchanged =
          next.length === recent.length && next.every((value, index) => value === recent[index]);
        return unchanged ? {} : { recentModels: next };
      }).catch((error: unknown) => {
        console.warn("Couldn’t record the recent model.", error);
      });
    },
    [onChange, selectedValue, saveModelPadPreferences],
  );

  // Choosing on the Pad closes the picker once the knob's confirm pulse has shown,
  // like choosing in the list. The timer never outlives the popover it was set for.
  const padCloseTimerRef = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (padCloseTimerRef.current !== null) window.clearTimeout(padCloseTimerRef.current);
      padCloseTimerRef.current = null;
    },
    [open],
  );
  const commitFromPad = (entry: ModelEntry) => {
    commit(entry);
    if (padCloseTimerRef.current !== null) window.clearTimeout(padCloseTimerRef.current);
    padCloseTimerRef.current = window.setTimeout(
      () => {
        padCloseTimerRef.current = null;
        setOpen(false);
      },
      prefersReducedMotion() ? 0 : PAD_COMMIT_CLOSE_DELAY_MS,
    );
  };

  const renderListRow = (entry: ModelEntry) => (
    <ModelListRow
      key={entry.value}
      entry={entry}
      isActive={entry.value === selectedValue}
      isPinned={pinned.includes(entry.value)}
      isOnPad={Boolean(modelPadPlacements[entry.value])}
      onChoose={(choice) => commit(choice, true)}
      onPreview={setPreviewValue}
      onTogglePin={togglePin}
      onTogglePad={toggleOnPad}
    />
  );

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      // Cleared on open rather than close, so the list keeps its filter while the
      // popover animates out.
      setSearch("");
      setView(hasPadModels ? "pad" : "list");
      setPreviewValue(selectedValue || positioned[0]?.value);
    } else {
      setPreviewValue(undefined);
    }
  };

  const switchView = (next: "pad" | "list", focusPanel = true, seed = "") => {
    // Re-selecting the current view keeps what was typed in the filter.
    if (next !== view || seed) setSearch(seed);
    setView(next);
    setPreviewValue(selectedValue || positioned[0]?.value);
    if (!focusPanel) return;
    requestAnimationFrame(() => {
      if (next === "list") {
        searchRef.current?.focus();
        return;
      }
      if (!hasPadModels) {
        contentRef.current?.querySelector<HTMLElement>("[data-model-pad-settings]")?.focus();
        return;
      }
      focusPad();
    });
  };

  const customizeBlockedReasonId = `${pickerId}-customize-blocked`;
  const openModelDataSettings = () => {
    if (settingsBlockedReason) return;
    setOpen(false);
    void navigate({ to: "/settings", search: { section: "modelData" } });
  };

  const handleViewTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    let next: "pad" | "list" | undefined;
    if (event.key === "ArrowLeft" || event.key === "Home") next = "list";
    if (event.key === "ArrowRight" || event.key === "End") next = "pad";
    if (!next) return;

    event.preventDefault();
    switchView(next, false);
    requestAnimationFrame(() => {
      document.getElementById(next === "list" ? listTabId : padTabId)?.focus();
    });
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="transparent"
          size="small"
          disabled={disabled || !hasModels}
          className="min-w-0 shrink max-w-[min(14rem,45vw)] gap-1.5"
          aria-label={
            hasUnavailableSelection
              ? "Selected model is unavailable. Choose a model."
              : selected
                ? `Selected model: ${selected.label}. Choose a model.`
                : hasModels
                  ? "Choose a model"
                  : unavailableMessage
          }
          title={
            hasUnavailableSelection
              ? "Selected model is unavailable."
              : hasModels
                ? undefined
                : unavailableMessage
          }
        >
          {selected ? (
            <ProviderIcon
              providerId={selected.providerId}
              providerLabel={selected.providerLabel}
              modelId={selected.model}
              artwork={selected.providerArtwork}
              className="size-4 text-tertiary"
            />
          ) : null}
          <span className="min-w-0 truncate">
            {selected
              ? selected.label
              : hasUnavailableSelection
                ? "Model unavailable"
                : hasModels
                  ? "Select model"
                  : "No models"}
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent
        ref={contentRef}
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={{ top: 40, right: 12, bottom: 12, left: 12 }}
        className="flex w-max max-w-[calc(100vw-1.5rem)] items-start gap-2 overflow-visible bg-transparent p-0 shadow-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => {
            if (!hasPadModels) {
              searchRef.current?.focus();
              return;
            }
            focusPad();
          });
        }}
      >
        <div className="relative w-[min(19.75rem,calc(100vw-1.5rem))] overflow-hidden rounded-popover bg-popover shadow-popover">
        <div className="flex items-center gap-1 p-1.5 pb-0">
          <div
            className="grid min-w-0 flex-1 grid-cols-2 rounded-control bg-control/60 p-0.5"
            role="tablist"
            aria-label="Model picker view"
          >
            <Button
              id={listTabId}
              role="tab"
              aria-selected={view === "list"}
              aria-controls={listPanelId}
              tabIndex={view === "list" ? 0 : -1}
              variant="transparent"
              size="small"
              className={cn(
                "h-6 justify-center px-2",
                view === "list" && "bg-popover shadow-control",
              )}
              onClick={() => switchView("list")}
              onKeyDown={handleViewTabKeyDown}
            >
              List
            </Button>
            <Button
              id={padTabId}
              role="tab"
              aria-selected={view === "pad"}
              aria-controls={padPanelId}
              tabIndex={view === "pad" ? 0 : -1}
              variant="transparent"
              size="small"
              className={cn(
                "h-6 justify-center px-2",
                view === "pad" && "bg-popover shadow-control",
              )}
              onClick={() => switchView("pad")}
              onKeyDown={handleViewTabKeyDown}
              aria-label="Personal Model Pad"
            >
              Pad
            </Button>
          </div>
          {hasPadModels ? (
            // The empty Pad has its own Customize call to action.
            <>
              <Button
                variant="transparent"
                size="small"
                iconOnly
                className={cn("shrink-0", settingsBlockedReason && "opacity-45")}
                aria-label="Customize Model Pad"
                aria-disabled={Boolean(settingsBlockedReason)}
                aria-describedby={settingsBlockedReason ? customizeBlockedReasonId : undefined}
                title={settingsBlockedReason ?? "Customize Model Pad"}
                onClick={openModelDataSettings}
              >
                <SlidersHorizontal />
              </Button>
              {settingsBlockedReason ? (
                <span id={customizeBlockedReasonId} className="sr-only">
                  {settingsBlockedReason}.
                </span>
              ) : null}
            </>
          ) : null}
        </div>

        {view === "pad" ? (
          <section
            id={padPanelId}
            role="tabpanel"
            aria-labelledby={padTabId}
            className="min-w-0 p-2"
          >
            {selectedOffPad ? (
              <div className="mb-2 flex min-w-0 items-center gap-2 rounded-control bg-control/60 py-1 pr-1 pl-2.5">
                <Text variant="small" color="secondary" as="p" className="flex min-w-0 flex-1">
                  <span className="min-w-0 truncate" title={selectedOffPad.label}>
                    {selectedOffPad.label}
                  </span>
                  <span className="shrink-0">{"\u00a0"}isn’t on your Pad</span>
                </Text>
                <Button size="small" className="shrink-0" onClick={addSelectedToPad}>
                  Add to Pad
                </Button>
              </div>
            ) : null}
            {hasPadModels ? (
              <ModelPickerPad
                models={positioned}
                gridSize={padGridSize}
                selectedValue={selectedValue}
                previewValue={previewValue}
                onPreview={setPreviewValue}
                onCommit={commitFromPad}
                heightMetric={heightMetric}
                siblingsByValue={siblingsByValue}
                onTypeToSearch={(character) => {
                  // A model was just chosen and the picker is about to close.
                  if (padCloseTimerRef.current !== null) return;
                  switchView("list", true, character);
                }}
              />
            ) : (
              <EmptyModelPad
                gridSize={padGridSize}
                onOpenSettings={openModelDataSettings}
                settingsBlockedReason={settingsBlockedReason}
              />
            )}
          </section>
        ) : (
          <section
            id={listPanelId}
            role="tabpanel"
            aria-labelledby={listTabId}
            className="min-w-0 pt-1"
          >
            <Command
              label="Chat model"
              value={previewValue}
              onValueChange={setPreviewValue}
              onKeyDown={(event) => {
                if (event.key !== "Escape") event.stopPropagation();
              }}
            >
              <CommandInput
                ref={searchRef}
                value={search}
                onValueChange={setSearch}
                aria-label="Filter chat models"
                placeholder="Filter models…"
              />
              <CommandList>
                <CommandEmpty>No models found.</CommandEmpty>
                {listSections.leading.map(renderListRow)}
                {listSections.recent.length ? (
                  <CommandGroup heading="Recent">
                    {listSections.recent.map(renderListRow)}
                  </CommandGroup>
                ) : null}
                {listSections.rest.map(renderListRow)}
              </CommandList>
            </Command>
          </section>
        )}

        {!(showExternalDetails && (view === "list" || hasPadModels)) && activeAttribution ? (
          <div className="border-t border-separator px-3 py-1.5 text-mini leading-4">
            <a
              href={activeAttribution.url}
              target="_blank"
              rel="noreferrer"
              className="text-tertiary underline decoration-separator underline-offset-2 hover:text-secondary"
            >
              {activeAttribution.label}
            </a>
          </div>
        ) : null}
        </div>
        {showExternalDetails && (view === "list" || hasPadModels) ? (
          <ModelHoverDetails
            model={activePosition}
            alsoVia={
              activePosition ? alsoViaLabel(siblingsByValue.get(activePosition.value)) : undefined
            }
            pace={activePosition ? paceSummaries?.[activePosition.value] : undefined}
            metadataLoading={metadataLoading}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
