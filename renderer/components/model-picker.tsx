// Compact provider + model picker: the searchable list (ModelListPanel) in a
// popover, with a read-only detail card beside it on wide windows. A Bot's
// chat uses it, since a Bot's model is its own and never a slider stop; the
// chat composer and Quick Chat use AgentModelPopover instead.

import * as React from "react";
import { Button, Popover, PopoverContent, PopoverTrigger } from "./ui";
import { cn } from "../lib/ui-utils";
import {
  alsoViaLabel,
  createModelEntries,
  encodeSelection,
  modelInfoByValue,
  modelSiblings,
  visibleModelEntries,
  type ModelEntry,
} from "../lib/model-picker-data";
import { useProvidersModelInfo } from "../lib/queries";
import type { Provider } from "../lib/types";
import { ProviderIcon } from "./provider-icon";
import type { HiddenModelsByProvider } from "../shared/model-visibility";
import {
  ModelHoverDetails,
  ModelListPanel,
  useExternalModelDetails,
  useRecordRecentModel,
} from "./model-list-panel";

interface ModelPickerProps {
  providers: Provider[];
  providerId: string;
  model: string;
  onChange: (providerId: string, model: string) => void;
  disabled?: boolean;
  hiddenModelsByProvider?: HiddenModelsByProvider;
  /** Optional observer for popover open/close transitions. */
  onOpenChange?: (open: boolean) => void;
  /** Optional async hook awaited before opening the popover (return false to cancel). */
  beforeOpen?: () => Promise<boolean | void>;
  /** Incrementing signal that closes any open popover and cancels pending beforeOpen calls. */
  closeSignal?: number;
}

export function ModelPicker({
  providers,
  providerId,
  model,
  onChange,
  disabled,
  hiddenModelsByProvider,
  onOpenChange,
  beforeOpen,
  closeSignal,
}: ModelPickerProps) {
  const [open, setOpen] = React.useState(false);
  const openRequestRef = React.useRef(0);
  const prevCloseSignalRef = React.useRef(closeSignal);
  const [search, setSearch] = React.useState("");
  const [previewValue, setPreviewValue] = React.useState<string>();
  const [showing, setShowing] = React.useState(0);
  React.useEffect(
    () => () => {
      openRequestRef.current += 1;
    },
    [],
  );
  React.useEffect(() => {
    if (closeSignal === prevCloseSignalRef.current) return;
    prevCloseSignalRef.current = closeSignal;
    openRequestRef.current += 1;
    setOpen(false);
    setPreviewValue(undefined);
  }, [closeSignal]);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const showExternalDetails = useExternalModelDetails();
  const recordRecent = useRecordRecentModel();
  const listId = React.useId();

  const catalog = useProvidersModelInfo(providers);
  // The composer re-renders on every streamed token. Keep the catalog derivation
  // keyed on its real inputs, and derive siblings only while the popover is open.
  // `catalog.data` keeps its identity until some provider's model info changes.
  const allEntries = React.useMemo(
    () => createModelEntries(providers, modelInfoByValue(providers, catalog.data)),
    [providers, catalog.data],
  );
  const entries = React.useMemo(
    () => visibleModelEntries(allEntries, hiddenModelsByProvider),
    [allEntries, hiddenModelsByProvider],
  );
  // Other visible routes to the same model, named on the detail card.
  const siblingsByValue = React.useMemo(
    () => (open ? modelSiblings(entries) : new Map<string, ModelEntry[]>()),
    [open, entries],
  );
  const selectedValue = providerId && model ? encodeSelection(providerId, model) : "";
  const selected = allEntries.find((entry) => entry.value === selectedValue);
  const activeEntry: ModelEntry | undefined = open
    ? (entries.find((entry) => entry.value === previewValue) ??
      entries.find((entry) => entry.value === selectedValue) ??
      entries[0])
    : undefined;
  const hasUnavailableSelection = Boolean(selectedValue && !selected);
  const hasModels = entries.length > 0;
  const unavailableMessage =
    "No chat models are available. Open Settings → Providers to discover models for a connection.";

  const closePicker = React.useCallback(() => {
    setOpen(false);
    onOpenChange?.(false);
    setPreviewValue(undefined);
  }, [onOpenChange]);

  const choose = (entry: ModelEntry) => {
    if (entry.value !== selectedValue) onChange(entry.providerId, entry.model);
    recordRecent(entry.value);
    closePicker();
  };

  const applyOpenState = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
    if (next) {
      // Cleared on open rather than close, so the list keeps its filter while the
      // popover animates out.
      setSearch("");
      setShowing((count) => count + 1);
      setPreviewValue(selectedValue || undefined);
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
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={{ top: 40, right: 12, bottom: 12, left: 12 }}
        className="flex w-max max-w-[calc(100vw-1.5rem)] items-start gap-2 overflow-visible bg-transparent p-0 shadow-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => searchRef.current?.focus());
        }}
      >
        <div className="relative w-[min(19.75rem,calc(100vw-1.5rem))] overflow-hidden rounded-popover bg-popover shadow-popover">
          <ModelListPanel
            entries={entries}
            selectedValue={selectedValue}
            active={open}
            search={search}
            onSearchChange={setSearch}
            previewValue={previewValue}
            onPreviewChange={setPreviewValue}
            onChoose={choose}
            searchRef={searchRef}
            pageKey={`${showing}`}
            sectionProps={{ id: listId, "aria-label": "Models" }}
          />
        </div>
        {showExternalDetails ? (
          <ModelHoverDetails
            model={activeEntry}
            alsoVia={activeEntry ? alsoViaLabel(siblingsByValue.get(activeEntry.value)) : undefined}
            metadataLoading={catalog.isLoading}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
