// Compact provider + model picker with the Model Pad. A searchable list
// (ModelListPanel) and a tactile spatial pad share the original menu
// footprint; model metadata stays in a separate, read-only detail surface
// beside the picker. The chat composer and Quick Chat use AgentModelPopover
// instead; this picker stays for Bot chats until the Pad UI is removed.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button, Popover, PopoverContent, PopoverTrigger, Text, toast } from "./ui";
import { ModelPickerPad } from "./model-picker-pad";
import { cn } from "../lib/ui-utils";
import { prefersReducedMotion } from "../lib/appearance-runtime";
import {
  alsoViaLabel,
  createModelEntries,
  encodeSelection,
  modelInfoByValue,
  modelSiblings,
  positionSavedModels,
  visibleModelEntries,
  type ModelEntry,
} from "../lib/model-picker-data";
import { useModelPaceSummaries, useProvidersModelInfo } from "../lib/queries";
import {
  BASE_MODEL_PAD_GRID_SIZE,
  addModelPadPlacement,
  modelPadGridSizeForPlacements,
  modelPadHeightMetric,
  type ModelPadPlacement,
} from "../lib/model-pad-layout";
import { useModelPadPreferences } from "../lib/model-pad-preferences";
import type { Provider } from "../lib/types";
import { SlidersHorizontal } from "lucide-react";
import { ModelPadLattice } from "./model-pad-lattice";
import { ProviderIcon } from "./provider-icon";
import type { HiddenModelsByProvider } from "../shared/model-visibility";
import type { SettingsSection } from "../shared/settings-section";
import {
  ModelHoverDetails,
  ModelListPanel,
  useExternalModelDetails,
  useRecordRecentModel,
} from "./model-list-panel";

export { ModelHoverDetails };

interface ModelPickerProps {
  providers: Provider[];
  providerId: string;
  model: string;
  onChange: (providerId: string, model: string) => void;
  disabled?: boolean;
  settingsBlockedReason?: string;
  hiddenModelsByProvider?: HiddenModelsByProvider;
  /** Optional override for windows without TanStack Router (e.g. Quick Chat). */
  onOpenSettings?: (section: SettingsSection) => void;
  /** Optional observer for popover open/close transitions. */
  onOpenChange?: (open: boolean) => void;
  /** Show only the searchable model list (hides Model Pad tabs, Pad toggles, and hover details). */
  listOnly?: boolean;
  /** Optional async hook awaited before opening the popover (return false to cancel). */
  beforeOpen?: () => Promise<boolean | void>;
  /** Incrementing signal that closes any open popover and cancels pending beforeOpen calls. */
  closeSignal?: number;
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

/** Matches the knob's 250ms confirm transition closely enough to read as one beat. */
const PAD_COMMIT_CLOSE_DELAY_MS = 200;
/** One toast for list-row removals, so only the latest removal offers Undo. */
const REMOVE_FROM_PAD_TOAST_ID = "model-picker-remove-from-pad";

export function ModelPicker(props: ModelPickerProps) {
  if (props.onOpenSettings) {
    return <ModelPickerInner {...props} openSettings={props.onOpenSettings} />;
  }
  return <ModelPickerWithRouter {...props} />;
}

function ModelPickerWithRouter(props: ModelPickerProps) {
  const navigate = useNavigate();
  const openSettings = React.useCallback(
    (section: SettingsSection) => {
      void navigate({ to: "/settings", search: { section } });
    },
    [navigate],
  );
  return <ModelPickerInner {...props} openSettings={openSettings} />;
}

function ModelPickerInner({
  providers,
  providerId,
  model,
  onChange,
  disabled,
  settingsBlockedReason,
  hiddenModelsByProvider,
  openSettings,
  onOpenChange,
  listOnly = false,
  beforeOpen,
  closeSignal,
}: ModelPickerProps & { openSettings: (section: SettingsSection) => void }) {
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<"pad" | "list">("list");
  const openRequestRef = React.useRef(0);
  const prevCloseSignalRef = React.useRef(closeSignal);
  const [search, setSearch] = React.useState("");
  const [previewValue, setPreviewValue] = React.useState<string>();
  React.useEffect(() => () => {
    openRequestRef.current += 1;
  }, []);
  React.useEffect(() => {
    if (closeSignal === prevCloseSignalRef.current) return;
    prevCloseSignalRef.current = closeSignal;
    openRequestRef.current += 1;
    setOpen(false);
    setPreviewValue(undefined);
  }, [closeSignal]);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const showExternalDetails = useExternalModelDetails();
  const {
    placements: modelPadPlacements,
    metric: modelPadMetric,
    save: saveModelPadPreferences,
  } = useModelPadPreferences();
  const recordRecent = useRecordRecentModel();
  const pickerId = React.useId();
  const listTabId = `${pickerId}-list-tab`;
  const padTabId = `${pickerId}-pad-tab`;
  const listPanelId = `${pickerId}-list-panel`;
  const padPanelId = `${pickerId}-pad-panel`;

  const catalog = useProvidersModelInfo(providers);
  // Device-local measured speed for the detail card; display-only. Read afresh
  // each time the picker opens so new chats show up without a remount.
  const paceSummaries = useModelPaceSummaries({ enabled: open && !listOnly, staleTime: 0 }).data;
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
  const selectedValue = providerId && model ? encodeSelection(providerId, model) : "";
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
    /** Resolves to whether the model is now on the Pad, or null when saving failed. */
    (value: string): Promise<boolean | null> => {
      const visibleValues = entries.map((entry) => entry.value);
      const label = entries.find((entry) => entry.value === value)?.label ?? value;
      let removed: ModelPadPlacement | undefined;
      return saveModelPadPreferences(({ placements }) => {
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
          if (!placement) return true;
          toast(`Removed ${label} from your Pad`, {
            id: REMOVE_FROM_PAD_TOAST_ID,
            action: { label: "Undo", onClick: () => restoreOnPad(value, placement) },
          });
          return false;
        },
        (error: unknown) => {
          toast.error(error instanceof Error ? error.message : "Couldn’t update your Pad.");
          return null;
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

  const closePicker = React.useCallback(() => {
    setOpen(false);
    onOpenChange?.(false);
    setPreviewValue(undefined);
  }, [onOpenChange]);

  const commit = React.useCallback(
    (entry: ModelEntry, close = false) => {
      if (entry.value !== selectedValue) onChange(entry.providerId, entry.model);
      setPreviewValue(entry.value);
      if (close) closePicker();
      recordRecent(entry.value);
    },
    [closePicker, onChange, selectedValue, recordRecent],
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
        closePicker();
      },
      prefersReducedMotion() ? 0 : PAD_COMMIT_CLOSE_DELAY_MS,
    );
  };

  const applyOpenState = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
    if (next) {
      // Cleared on open rather than close, so the list keeps its filter while the
      // popover animates out.
      setSearch("");
      setView(listOnly ? "list" : hasPadModels ? "pad" : "list");
      setPreviewValue(selectedValue || positioned[0]?.value);
    } else {
      setPreviewValue(undefined);
    }
  };

  const handleOpenChange = (next: boolean) => {
    const requestId = ++openRequestRef.current;
    if (next && beforeOpen) {
      void beforeOpen().then(
        (proceed) => {
          if (proceed !== false && openRequestRef.current === requestId) applyOpenState(true);
        },
        () => undefined,
      );
      return;
    }
    applyOpenState(next);
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
    handleOpenChange(false);
    openSettings("modelData");
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
          className={cn(
            "min-w-0 shrink max-w-[min(14rem,45vw)] gap-1.5",
            selected && "composer-model-trigger",
          )}
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
          {/* With a provider icon to stand in, a narrow composer drops the label (see styles.css). */}
          <span className={cn("min-w-0 truncate", selected && "composer-model-label")}>
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
            if (listOnly || !hasPadModels) {
              searchRef.current?.focus();
              return;
            }
            focusPad();
          });
        }}
      >
        <div className="relative w-[min(19.75rem,calc(100vw-1.5rem))] overflow-hidden rounded-popover bg-popover shadow-popover">
        {!listOnly ? (
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
        ) : null}

        {!listOnly && view === "pad" ? (
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
          <ModelListPanel
            entries={entries}
            selectedValue={selectedValue}
            active={open}
            search={search}
            onSearchChange={setSearch}
            previewValue={previewValue}
            onPreviewChange={setPreviewValue}
            onChoose={(choice) => commit(choice, true)}
            searchRef={searchRef}
            pad={
              listOnly
                ? undefined
                : { isOnPad: (value) => Boolean(modelPadPlacements[value]), toggle: toggleOnPad }
            }
            pageKey={`${open}:${view}`}
            sectionProps={{
              id: listPanelId,
              role: listOnly ? undefined : "tabpanel",
              "aria-labelledby": listOnly ? undefined : listTabId,
              "aria-label": listOnly ? "Models" : undefined,
            }}
          />
        )}

        {!listOnly && !(showExternalDetails && (view === "list" || hasPadModels)) && activeAttribution ? (
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
        {!listOnly && showExternalDetails && (view === "list" || hasPadModels) ? (
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
