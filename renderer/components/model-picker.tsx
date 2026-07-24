// Compact provider + model picker for the composer. A searchable list and a
// tactile spatial pad share the original menu footprint; model metadata stays
// in a separate, read-only detail surface beside the picker.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Button,
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Text,
} from "./ui";
import { ModelPickerPad } from "./model-picker-pad";
import { cn } from "../lib/ui-utils";
import {
  createModelEntries,
  encodeSelection,
  orderModelEntries,
  PINNED_MODELS_KEY,
  positionSavedModels,
  positionModels,
  type ModelEntry,
  type PositionedModel,
} from "../lib/model-picker-data";
import { useProvidersModelInfo } from "../lib/queries";
import { useModelPadLayout } from "../lib/model-pad-layout";
import type { ModelInfo, Provider } from "../lib/types";
import { Check, ChevronsUpDown, Cloud, Cpu, Pin, SlidersHorizontal } from "lucide-react";

interface ModelPickerProps {
  providers: Provider[];
  providerId: string;
  model: string;
  onChange: (providerId: string, model: string) => void;
  disabled?: boolean;
  settingsBlockedReason?: string;
}

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

function describeModel(entry: ModelEntry): string {
  const details = [
    `Provider ${entry.providerLabel}`,
    `Inputs ${formatInputs(entry.info)}`,
    `Capabilities ${formatCapabilities(entry.info)}`,
  ];
  const context = formatTokens(entry.info?.contextLength);
  const output = formatTokens(entry.info?.outputLimit);
  if (context) details.push(`Context ${context} tokens`);
  if (output) details.push(`Maximum output ${output} tokens`);
  if (entry.ranking) details.push(`Benchmark ${entry.ranking.source}`);
  else if (entry.info?.metadataSource === "artificial-analysis") {
    details.push("Model data Artificial Analysis");
  }
  details.push(`Model ID ${entry.model}`);
  return details.join(". ");
}

function readPinnedModels(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_MODELS_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
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
  onOpenSettings,
  settingsBlockedReason,
}: {
  onOpenSettings: () => void;
  settingsBlockedReason?: string;
}) {
  const gridSize = 9;
  const blockedReasonId = React.useId();
  return (
    <div className="model-pad relative aspect-square w-full overflow-hidden rounded-card">
      <div aria-hidden="true" className="absolute inset-0 opacity-55">
        {Array.from({ length: gridSize * gridSize }, (_, index) => {
          const column = index % gridSize;
          const row = Math.floor(index / gridSize);
          return (
            <span
              key={index}
              className="absolute size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/20"
              style={{
                left: `${8 + (column / (gridSize - 1)) * 84}%`,
                top: `${8 + (row / (gridSize - 1)) * 84}%`,
              }}
            />
          );
        })}
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

function ModelHoverDetails({
  model,
  metadataLoading,
  showArtificialAnalysisAttribution,
}: {
  model: PositionedModel | undefined;
  metadataLoading: boolean;
  showArtificialAnalysisAttribution: boolean;
}) {
  if (!model) return null;

  const info = model.info;
  const context = formatTokens(info?.contextLength);
  const output = formatTokens(info?.outputLimit);
  const inputs = formatInputs(info);
  const attributionUrl =
    model.ranking?.sourceUrl ??
    (info?.metadataSource === "artificial-analysis"
      ? "https://artificialanalysis.ai"
      : showArtificialAnalysisAttribution
        ? "https://artificialanalysis.ai"
        : undefined);
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
    info?.releaseDate ? ["Released", info.releaseDate] : null,
    info?.knowledge ? ["Knowledge", info.knowledge] : null,
  ].filter((row): row is [string, string] => Boolean(row));

  return (
    <aside className="pointer-events-none absolute left-[calc(100%+0.5rem)] top-0 w-56 rounded-popover bg-popover p-3 text-primary shadow-popover">
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 shrink-0 text-tertiary">
          {model.isLocal ? <Cpu className="size-4" /> : <Cloud className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <Text variant="small-strong" as="h3" truncate>
            {model.label}
          </Text>
          <Text variant="small" color="tertiary" as="p" truncate>
            {model.providerLabel}
            {model.format ? ` · ${model.format}` : ""}
          </Text>
        </div>
      </div>

      {info?.matched ? (
        <>
          {capabilities.length > 0 ? (
            <p className="mt-2 text-small text-secondary">{capabilities.join(" · ")}</p>
          ) : null}
          {detailRows.length > 0 ? (
            <dl className="mt-2 grid gap-1 border-t border-separator pt-2 text-small">
              {detailRows.map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-tertiary">{label}</dt>
                  <dd className="min-w-0 truncate text-right text-secondary tabular-nums">
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
          className="truncate font-mono text-[10px] leading-4 text-quaternary"
          title={model.model}
        >
          {model.model}
        </div>
        {attributionUrl ? (
          <a
            href={attributionUrl}
            target="_blank"
            rel="noreferrer"
            className="pointer-events-auto mt-1 inline-block text-[10px] leading-4 text-tertiary underline decoration-separator underline-offset-2 hover:text-secondary"
          >
            {model.ranking ? "Benchmark data" : "Model data"} · Artificial Analysis
          </a>
        ) : null}
      </div>
    </aside>
  );
}

export function ModelPicker({
  providers,
  providerId,
  model,
  onChange,
  disabled,
  settingsBlockedReason,
}: ModelPickerProps) {
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<"pad" | "list">("list");
  const [previewValue, setPreviewValue] = React.useState<string>();
  const [pinned, setPinned] = React.useState<string[]>(readPinnedModels);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const showExternalDetails = useExternalModelDetails();
  const modelPadLayout = useModelPadLayout();
  const pickerId = React.useId();
  const listTabId = `${pickerId}-list-tab`;
  const padTabId = `${pickerId}-pad-tab`;
  const listPanelId = `${pickerId}-list-panel`;
  const padPanelId = `${pickerId}-pad-panel`;

  const catalog = useProvidersModelInfo(providers);

  const infoByValue: Record<string, ModelInfo | undefined> = {};
  providers.forEach((provider) => {
    const data = catalog.data[provider.id];
    for (const modelId of provider.models) {
      infoByValue[encodeSelection(provider.id, modelId)] = data?.[modelId];
    }
  });

  const entries = createModelEntries(providers, infoByValue);
  const orderedEntries = orderModelEntries(entries, pinned);
  const detailPositions = positionModels(entries);
  const positioned = positionSavedModels(entries, modelPadLayout.placements);
  const hasPadModels = positioned.length > 0;
  const usesArtificialAnalysis =
    entries.some((entry) => entry.info?.metadataSource === "artificial-analysis") ||
    positioned.some((entry) => entry.confidence === "suggested");
  const selectedValue = providerId && model ? encodeSelection(providerId, model) : "";
  const selected = entries.find((entry) => entry.value === selectedValue);
  const selectedPosition = positioned.find((entry) => entry.value === selectedValue);
  const detailPosition = detailPositions.find((entry) => entry.value === previewValue);
  const activePosition =
    view === "pad"
      ? (positioned.find((entry) => entry.value === previewValue) ??
        selectedPosition ??
        positioned[0])
      : (detailPosition ??
        detailPositions.find((entry) => entry.value === selectedValue) ??
        detailPositions[0]);
  const hasUnavailableSelection = Boolean(selectedValue && !selected);
  const hasModels = entries.length > 0;
  const metadataLoading = catalog.isLoading;
  const unavailableMessage =
    "No chat models are available. Open Settings → Providers to discover models for a connection.";

  const setPinnedModels = React.useCallback((next: string[]) => {
    setPinned(next);
    try {
      localStorage.setItem(PINNED_MODELS_KEY, JSON.stringify(next));
    } catch {
      // A pin is a convenience preference; selection remains usable if storage is unavailable.
    }
  }, []);

  const togglePin = React.useCallback(
    (value: string) => {
      setPinnedModels(
        pinned.includes(value) ? pinned.filter((entry) => entry !== value) : [...pinned, value],
      );
    },
    [pinned, setPinnedModels],
  );

  const commit = React.useCallback(
    (entry: ModelEntry, close = false) => {
      if (entry.value !== selectedValue) onChange(entry.providerId, entry.model);
      setPreviewValue(entry.value);
      if (close) setOpen(false);
    },
    [onChange, selectedValue],
  );

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setView(hasPadModels ? "pad" : "list");
      setPreviewValue(selectedValue || positioned[0]?.value);
    } else {
      setPreviewValue(undefined);
    }
  };

  const switchView = (next: "pad" | "list", focusPanel = true) => {
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
      contentRef.current
        ?.querySelector<HTMLElement>('[aria-roledescription="two-dimensional model picker"]')
        ?.focus();
    });
  };

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
                ? `Selected model: ${selected.label} from ${selected.providerLabel}. Choose a model.`
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
            selected.isLocal ? (
              <Cpu className="size-4 shrink-0 text-tertiary" />
            ) : (
              <Cloud className="size-4 shrink-0 text-tertiary" />
            )
          ) : null}
          <span className="min-w-0 truncate">
            {selected
              ? `${selected.label} · ${selected.providerLabel}`
              : hasUnavailableSelection
                ? "Model unavailable"
                : hasModels
                  ? "Select model"
                  : "No models"}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-tertiary" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        ref={contentRef}
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={{
          top: 40,
          right: showExternalDetails && (view === "list" || hasPadModels) ? 244 : 12,
          bottom: 12,
          left: 12,
        }}
        className="relative w-[min(19.75rem,calc(100vw-1.5rem))] overflow-visible p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => {
            if (!hasPadModels) {
              searchRef.current?.focus();
              return;
            }
            const pad = contentRef.current?.querySelector<HTMLElement>(
              '[aria-roledescription="two-dimensional model picker"]',
            );
            pad?.focus();
          });
        }}
      >
        <div className="p-1.5 pb-0">
          <div
            className="grid grid-cols-2 rounded-control bg-control/60 p-0.5"
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
              radius="rounded"
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
              radius="rounded"
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
        </div>

        {view === "pad" ? (
          <section
            id={padPanelId}
            role="tabpanel"
            aria-labelledby={padTabId}
            className="min-w-0 p-2"
          >
            {hasPadModels ? (
              <ModelPickerPad
                models={positioned}
                selectedValue={selectedValue}
                previewValue={previewValue}
                onPreview={setPreviewValue}
                onCommit={(entry) => commit(entry)}
              />
            ) : (
              <EmptyModelPad
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
                aria-label="Filter chat models"
                placeholder="Filter models…"
              />
              <CommandList className="h-[min(300px,calc(100vh-9rem))] max-h-[min(300px,calc(100vh-9rem))]">
                <CommandEmpty>No models found.</CommandEmpty>
                {orderedEntries.map((entry) => {
                  const isActive = entry.value === selectedValue;
                  const isPinned = pinned.includes(entry.value);
                  const descriptionId = `model-description-${entry.value.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
                  return (
                    <CommandItem
                      key={entry.value}
                      value={entry.value}
                      keywords={[entry.label, entry.providerLabel, entry.model, entry.format ?? ""]}
                      aria-describedby={descriptionId}
                      onSelect={() => commit(entry, true)}
                      onMouseEnter={() => setPreviewValue(entry.value)}
                      className="group gap-2"
                    >
                      {entry.isLocal ? (
                        <Cpu className="size-4 shrink-0 text-tertiary" />
                      ) : (
                        <Cloud className="size-4 shrink-0 text-tertiary" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-small-strong">{entry.label}</span>
                        <span className="block truncate text-small text-tertiary">
                          {entry.providerLabel}
                        </span>
                      </span>
                      {entry.format ? (
                        <span className="shrink-0 text-small text-tertiary">{entry.format}</span>
                      ) : null}
                      <span id={descriptionId} className="sr-only">
                        {describeModel(entry)}
                      </span>
                      {isActive ? <Check className="size-4 shrink-0 text-accent" /> : null}
                      <button
                        type="button"
                        aria-label={isPinned ? `Unpin ${entry.label}` : `Pin ${entry.label}`}
                        aria-pressed={isPinned}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          togglePin(entry.value);
                        }}
                        className={cn(
                          "shrink-0 rounded-md p-0.5 text-tertiary outline-none transition-[background-color,box-shadow,color,opacity] duration-150 ease-out hover:bg-list-hover hover:text-secondary active:bg-list-selection focus-visible:ring-2 focus-visible:ring-focus-ring",
                          isPinned
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                        )}
                      >
                        <Pin className={cn("size-3.5", isPinned && "fill-current text-accent")} />
                      </button>
                    </CommandItem>
                  );
                })}
              </CommandList>
            </Command>
          </section>
        )}

        {showExternalDetails && (view === "list" || hasPadModels) ? (
          <ModelHoverDetails
            model={activePosition}
            metadataLoading={metadataLoading}
            showArtificialAnalysisAttribution={usesArtificialAnalysis}
          />
        ) : usesArtificialAnalysis ? (
          <div className="border-t border-separator px-3 py-1.5 text-[10px] leading-4">
            <a
              href="https://artificialanalysis.ai"
              target="_blank"
              rel="noreferrer"
              className="text-tertiary underline decoration-separator underline-offset-2 hover:text-secondary"
            >
              Model data · Artificial Analysis
            </a>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
