// Compact provider + model picker for the composer. A searchable list and a
// tactile spatial pad share the original menu footprint; model metadata stays
// in a separate, read-only detail surface beside the picker.

import * as React from "react";
import { useQueries } from "@tanstack/react-query";
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
  isUsable,
  orderModelEntries,
  PINNED_MODELS_KEY,
  positionModels,
  type ModelEntry,
  type PositionedModel,
} from "../lib/model-picker-data";
import { modelsApi } from "../lib/ipc";
import { queryKeys } from "../lib/queries";
import type { ModelInfo, Provider } from "../lib/types";
import { Check, ChevronsUpDown, Cloud, Cpu, Pin } from "lucide-react";

interface ModelPickerProps {
  providers: Provider[];
  providerId: string;
  model: string;
  onChange: (providerId: string, model: string) => void;
  disabled?: boolean;
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

function ModelHoverDetails({
  model,
  metadataLoading,
}: {
  model: PositionedModel | undefined;
  metadataLoading: boolean;
}) {
  if (!model) return null;

  const info = model.info;
  const context = formatTokens(info?.contextLength);
  const output = formatTokens(info?.outputLimit);
  const capabilities = [
    info?.vision ? "Vision" : null,
    info?.toolCall ? "Tools" : null,
    info?.reasoning ? "Reasoning" : null,
    info?.openWeights ? "Open weights" : null,
  ].filter((value): value is string => Boolean(value));
  const detailRows = [
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
    </aside>
  );
}

export function ModelPicker({
  providers,
  providerId,
  model,
  onChange,
  disabled,
}: ModelPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<"pad" | "list">("pad");
  const [previewValue, setPreviewValue] = React.useState<string>();
  const [pinned, setPinned] = React.useState<string[]>(readPinnedModels);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const showExternalDetails = useExternalModelDetails();
  const pickerId = React.useId();
  const listTabId = `${pickerId}-list-tab`;
  const padTabId = `${pickerId}-pad-tab`;
  const listPanelId = `${pickerId}-list-panel`;
  const padPanelId = `${pickerId}-pad-panel`;

  const metadataProviders = React.useMemo(() => providers.filter(isUsable), [providers]);
  const metadataQueries = useQueries({
    queries: metadataProviders.map((provider) => {
      const key = [...provider.models].sort().join(",");
      return {
        queryKey: [...queryKeys.modelInfo(provider.id), key],
        queryFn: () => modelsApi.info(provider.id, provider.models),
        enabled: open,
        staleTime: 60 * 60 * 1000,
      };
    }),
  });

  const infoByValue: Record<string, ModelInfo | undefined> = {};
  metadataProviders.forEach((provider, providerIndex) => {
    const data = metadataQueries[providerIndex]?.data;
    for (const modelId of provider.models) {
      infoByValue[encodeSelection(provider.id, modelId)] = data?.[modelId];
    }
  });

  const entries = createModelEntries(providers, infoByValue);
  const orderedEntries = orderModelEntries(entries, pinned);
  const positioned = positionModels(entries);
  const selectedValue = providerId && model ? encodeSelection(providerId, model) : "";
  const selected = entries.find((entry) => entry.value === selectedValue);
  const selectedPosition = positioned.find((entry) => entry.value === selectedValue);
  const activePosition =
    positioned.find((entry) => entry.value === previewValue) ?? selectedPosition ?? positioned[0];
  const hasUnavailableSelection = Boolean(selectedValue && !selected);
  const hasModels = entries.length > 0;
  const metadataLoading = metadataQueries.some((query) => query.isLoading);
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
      setView("pad");
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
      contentRef.current
        ?.querySelector<HTMLElement>('[aria-roledescription="two-dimensional model picker"]')
        ?.focus();
    });
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
          className="min-w-0 max-w-[min(14rem,45vw)] gap-1.5"
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
          right: showExternalDetails ? 244 : 12,
          bottom: 12,
          left: 12,
        }}
        className="relative w-[min(19.75rem,calc(100vw-1.5rem))] overflow-visible p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => {
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
            <ModelPickerPad
              models={positioned}
              selectedValue={selectedValue}
              previewValue={previewValue}
              onPreview={setPreviewValue}
              onCommit={(entry) => commit(entry)}
            />
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
                  return (
                    <CommandItem
                      key={entry.value}
                      value={entry.value}
                      keywords={[entry.label, entry.providerLabel, entry.format ?? ""]}
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

        {showExternalDetails ? (
          <ModelHoverDetails model={activePosition} metadataLoading={metadataLoading} />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
