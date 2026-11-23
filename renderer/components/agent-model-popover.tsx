// The composer's model popover: the Agent Slider on top, then "Other models…"
// (the full searchable list as a sub-view) and "Customize slider…". Choosing
// a stop moves the chat to that stop's model and effort; choosing from the list
// changes the model only, exactly as the old picker did. A stop that can't run
// opens the list in reassign mode, which saves a model onto that stop.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Search, SlidersHorizontal } from "lucide-react";
import { Button, Popover, PopoverContent, PopoverTrigger, Text, toast } from "./ui";
import { AgentSlider } from "./agent-slider";
import {
  ModelHoverDetails,
  ModelListPanel,
  useExternalModelDetails,
  useRecordRecentModel,
} from "./model-list-panel";
import { ProviderIcon } from "./provider-icon";
import { cn } from "../lib/ui-utils";
import {
  alsoViaLabel,
  createModelEntries,
  encodeSelection,
  modelInfoByValue,
  modelSiblings,
  parseModel,
  visibleModelEntries,
  type ModelEntry,
} from "../lib/model-picker-data";
import { useModelPaceSummaries, useProvidersModelInfo } from "../lib/queries";
import {
  agentSliderPosition,
  agentSliderStopViews,
  effortLabel,
  homeStopIndex,
} from "../lib/agent-slider-view";
import { composerThinkingLevels } from "../lib/composer-thinking-levels";
import { saveAgentSlider, seedAgentSliderIfAbsent } from "../lib/agent-slider-seed";
import type { AgentSliderSettings } from "../shared/agent-slider";
import type { GenerationThinkingLevel } from "../shared/generation-thinking";
import type { HiddenModelsByProvider } from "../shared/model-visibility";
import type { SettingsSection } from "../shared/settings-section";
import { OTHER_MODELS_SHORTCUT } from "../shared/built-in-keys";
import { ariaKeyShortcut, matchesAccelerator, prettyAccelerator } from "../shared/keybindings";
import { isComposingKey } from "../lib/dismiss-key";
import type { Provider } from "../lib/types";

/**
 * Where "Customize slider…" goes. PR 3 of the Agent Slider stack replaces the
 * Model Pad page in this section with the slider editor; retarget it then if
 * the editor gets its own section.
 */
export const AGENT_SLIDER_SETTINGS_SECTION: SettingsSection = "modelData";

export interface AgentModelPopoverProps {
  providers: Provider[];
  providerId: string;
  model: string;
  /** The chat's (or new-chat pick's) own effort; absent: the model's saved level. */
  thinkingLevel?: GenerationThinkingLevel;
  /** The saved slider; absent until seeded. */
  slider: AgentSliderSettings | undefined;
  /** Settings have loaded, so an absent slider really is absent. */
  settingsLoaded: boolean;
  /** The effort the current model runs at now, for the first-run seed's home stop. */
  seedThinkingLevel?: GenerationThinkingLevel;
  /** A model from the list: the same call the old picker made. */
  onChange: (providerId: string, model: string) => void;
  /** A stop: its model and effort. No level clears the chat's own level. */
  onSelectStop: (
    providerId: string,
    model: string,
    thinkingLevel: GenerationThinkingLevel | undefined,
  ) => void;
  disabled?: boolean;
  settingsBlockedReason?: string;
  hiddenModelsByProvider?: HiddenModelsByProvider;
  /** For windows without TanStack Router (Quick Chat). */
  onOpenSettings?: (section: SettingsSection) => void;
  onOpenChange?: (open: boolean) => void;
  /** Awaited before opening (return false to cancel). */
  beforeOpen?: () => Promise<boolean | void>;
  /** Incrementing signal that closes the popover and cancels pending opens. */
  closeSignal?: number;
  /** Show the model detail card beside the list (off in Quick Chat's small window). */
  showDetails?: boolean;
}

type View = { kind: "slider" } | { kind: "list" } | { kind: "reassign"; stopId: string };

export function AgentModelPopover(props: AgentModelPopoverProps) {
  if (props.onOpenSettings) {
    return <AgentModelPopoverInner {...props} openSettings={props.onOpenSettings} />;
  }
  return <AgentModelPopoverWithRouter {...props} />;
}

function AgentModelPopoverWithRouter(props: AgentModelPopoverProps) {
  const navigate = useNavigate();
  const openSettings = React.useCallback(
    (section: SettingsSection) => {
      void navigate({ to: "/settings", search: { section } });
    },
    [navigate],
  );
  return <AgentModelPopoverInner {...props} openSettings={openSettings} />;
}

function AgentModelPopoverInner({
  providers,
  providerId,
  model,
  thinkingLevel,
  slider,
  settingsLoaded,
  seedThinkingLevel,
  onChange,
  onSelectStop,
  disabled,
  settingsBlockedReason,
  hiddenModelsByProvider,
  openSettings,
  onOpenChange,
  beforeOpen,
  closeSignal,
  showDetails = true,
}: AgentModelPopoverProps & { openSettings: (section: SettingsSection) => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<View>({ kind: "slider" });
  const [search, setSearch] = React.useState("");
  const [previewValue, setPreviewValue] = React.useState<string>();
  const [listShowing, setListShowing] = React.useState(0);
  const [saving, setSaving] = React.useState(false);
  const openRequestRef = React.useRef(0);
  const prevCloseSignalRef = React.useRef(closeSignal);
  const thumbRef = React.useRef<HTMLDivElement | null>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const otherModelsRef = React.useRef<HTMLButtonElement | null>(null);
  const wide = useExternalModelDetails();
  const recordRecent = useRecordRecentModel();
  const popoverId = React.useId();
  const listId = `${popoverId}-list`;
  const listHeadingId = `${popoverId}-list-heading`;
  const customizeReasonId = `${popoverId}-customize-reason`;

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

  const catalog = useProvidersModelInfo(providers);
  const allEntries = React.useMemo(
    () => createModelEntries(providers, modelInfoByValue(providers, catalog.data)),
    [providers, catalog.data],
  );
  const entries = React.useMemo(
    () => visibleModelEntries(allEntries, hiddenModelsByProvider),
    [allEntries, hiddenModelsByProvider],
  );
  const selectedValue = providerId && model ? encodeSelection(providerId, model) : "";
  const selected = allEntries.find((entry) => entry.value === selectedValue);
  const hasModels = entries.length > 0;
  const hasUnavailableSelection = Boolean(selectedValue && !selected);

  const views = React.useMemo(() => {
    if (!slider) return [];
    const entryByValue = new Map(allEntries.map((entry) => [entry.value, entry]));
    return agentSliderStopViews(
      slider,
      { providers, hiddenModelsByProvider },
      {
        providerLabel: (id) => providers.find((provider) => provider.id === id)?.label,
        modelLabel: (id, stopModel) => entryByValue.get(encodeSelection(id, stopModel))?.label,
      },
    );
  }, [slider, allEntries, providers, hiddenModelsByProvider]);
  const position = React.useMemo(
    () =>
      slider
        ? agentSliderPosition(slider, views, { providerId, model, thinkingLevel })
        : undefined,
    [slider, views, providerId, model, thinkingLevel],
  );
  const homeIndex = slider ? homeStopIndex(slider) : 0;
  const onStop = position && !position.custom ? views[position.stopIndex] : undefined;
  const modelLabel = selected?.label ?? (model ? parseModel(model).label : "");
  const customDetail = [modelLabel || "No model", effortLabel(thinkingLevel)]
    .filter(Boolean)
    .join(" · ");

  // First run: build the slider around the model in use and save it once.
  // Main writes only while config.json has no slider at all, so other windows
  // seeding at the same time, or a malformed hand edit, are left alone.
  const seedAttemptedRef = React.useRef(false);
  React.useEffect(() => {
    if (!open || slider || !settingsLoaded || seedAttemptedRef.current) return;
    if (!selectedValue || catalog.isLoading) return;
    seedAttemptedRef.current = true;
    const provider = providers.find((candidate) => candidate.id === providerId);
    const { levels } = composerThinkingLevels(provider, model, selected?.info?.reasoning);
    const level = thinkingLevel ?? seedThinkingLevel;
    void seedAgentSliderIfAbsent(
      { providerId, model, ...(level && levels.includes(level) ? { thinkingLevel: level } : {}) },
      levels,
      queryClient,
    ).catch((error: unknown) => {
      // The list still works; the next window to open the popover tries again.
      seedAttemptedRef.current = false;
      console.warn("Couldn’t set up the Agent Slider.", error);
    });
  }, [
    open,
    slider,
    settingsLoaded,
    selectedValue,
    catalog.isLoading,
    providers,
    providerId,
    model,
    selected?.info?.reasoning,
    thinkingLevel,
    seedThinkingLevel,
    queryClient,
  ]);

  const focusSlider = React.useCallback(() => {
    requestAnimationFrame(() => {
      if (thumbRef.current) thumbRef.current.focus();
      else otherModelsRef.current?.focus();
    });
  }, []);

  // Focus moves in the same commit that swaps the view, so keys typed right
  // after the first (typing "zz" on the slider) land in the filter.
  const pendingFocusRef = React.useRef<"search" | "slider" | null>(null);
  React.useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    if (pending === "search") searchRef.current?.focus();
    else (thumbRef.current ?? otherModelsRef.current)?.focus();
  });
  const showList = (next: View, seed = "") => {
    setSearch(seed);
    setView(next);
    setListShowing((count) => count + 1);
    setPreviewValue(selectedValue || entries[0]?.value);
    pendingFocusRef.current = "search";
  };
  const backToSlider = () => {
    setView({ kind: "slider" });
    setSearch("");
    pendingFocusRef.current = "slider";
  };

  const closePopover = React.useCallback(() => {
    setOpen(false);
    onOpenChange?.(false);
    setPreviewValue(undefined);
  }, [onOpenChange]);

  const applyOpenState = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
    if (next) {
      setView({ kind: "slider" });
      setSearch("");
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

  const selectStop = (index: number) => {
    const stop = views[index];
    if (!stop?.available || !stop.providerId || !stop.model) return;
    onSelectStop(stop.providerId, stop.model, stop.thinkingLevel);
  };

  const chooseFromList = (entry: ModelEntry) => {
    if (entry.value !== selectedValue) onChange(entry.providerId, entry.model);
    recordRecent(entry.value);
    closePopover();
  };

  const reassignStop = view.kind === "reassign" ? slider?.stops.find((stop) => stop.id === view.stopId) : undefined;
  const reassignView = reassignStop ? views.find((stop) => stop.id === reassignStop.id) : undefined;
  const reassign = async (entry: ModelEntry) => {
    if (!slider || !reassignStop || saving) return;
    const provider = providers.find((candidate) => candidate.id === entry.providerId);
    const { levels, defaultLevel } = composerThinkingLevels(provider, entry.model, entry.info?.reasoning);
    const level = levels.length ? defaultLevel : undefined;
    const next: AgentSliderSettings = {
      ...slider,
      stops: slider.stops.map((stop) => {
        if (stop.id !== reassignStop.id) return stop;
        const { thinkingLevel: _replaced, ...rest } = stop;
        return {
          ...rest,
          providerId: entry.providerId,
          model: entry.model,
          ...(level ? { thinkingLevel: level } : {}),
        };
      }),
    };
    setSaving(true);
    try {
      await saveAgentSlider(next, queryClient);
      recordRecent(entry.value);
      onSelectStop(entry.providerId, entry.model, level);
      closePopover();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t save the slider stop.");
    } finally {
      setSaving(false);
    }
  };

  const openCustomize = () => {
    if (settingsBlockedReason) return;
    handleOpenChange(false);
    openSettings(AGENT_SLIDER_SETTINGS_SECTION);
  };

  const listView = view.kind !== "slider";
  const paceSummaries = useModelPaceSummaries({
    enabled: open && listView && showDetails,
    staleTime: 0,
  }).data;
  const siblingsByValue = React.useMemo(
    () => (open && listView ? modelSiblings(entries) : new Map<string, ModelEntry[]>()),
    [open, listView, entries],
  );
  const detailEntry = listView
    ? (entries.find((entry) => entry.value === previewValue) ??
      entries.find((entry) => entry.value === selectedValue) ??
      entries[0])
    : undefined;

  const triggerLabel = onStop
    ? onStop.label
    : selected
      ? selected.label
      : hasUnavailableSelection
        ? "Model unavailable"
        : hasModels
          ? "Select model"
          : "No models";
  const unavailableMessage =
    "No chat models are available. Open Settings → Providers to discover models for a connection.";

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
                ? `Selected model: ${selected.label}${onStop ? `, ${onStop.label} on the Agent Slider` : ""}. Choose a model.`
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
            {triggerLabel}
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={{ top: 40, right: 12, bottom: 12, left: 12 }}
        aria-label="Choose agent"
        className="flex w-max max-w-[calc(100vw-1.5rem)] items-start gap-2 overflow-visible bg-transparent p-0 shadow-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusSlider();
        }}
        onEscapeKeyDown={(event) => {
          // From the list, Escape goes back to the slider without saving anything.
          if (view.kind === "slider") return;
          event.preventDefault();
          backToSlider();
        }}
        onKeyDown={(event) => {
          if (view.kind !== "slider" || isComposingKey(event)) return;
          if (!matchesAccelerator(event, OTHER_MODELS_SHORTCUT)) return;
          event.preventDefault();
          showList({ kind: "list" });
        }}
      >
        <div className="relative w-[min(20rem,calc(100vw-1.5rem))] overflow-hidden rounded-popover bg-popover shadow-popover">
          {view.kind === "slider" ? (
            <div className="pt-2.5 pb-1.5">
              {slider && position ? (
                <AgentSlider
                  views={views}
                  position={position}
                  homeIndex={homeIndex}
                  customDetail={customDetail}
                  disabled={disabled}
                  disabledReason={disabled ? "You can change the agent after this response finishes" : undefined}
                  onSelectStop={selectStop}
                  onUnavailableStop={(index) => {
                    const stop = views[index];
                    if (stop) showList({ kind: "reassign", stopId: stop.id });
                  }}
                  onTypeToSearch={(character) => showList({ kind: "list" }, character)}
                  thumbRef={thumbRef}
                />
              ) : null}
              {slider ? <div role="separator" className="mx-2 mt-2.5 mb-1 h-px bg-separator" /> : null}
              <div className="flex flex-col px-1.5">
                <Button
                  ref={otherModelsRef}
                  variant="transparent"
                  size="small"
                  className="w-full justify-start gap-2 px-2.5 font-normal"
                  aria-keyshortcuts={ariaKeyShortcut(OTHER_MODELS_SHORTCUT)}
                  onClick={() => showList({ kind: "list" })}
                >
                  <Search className="size-4 text-tertiary" />
                  <span className="min-w-0 flex-1 truncate text-left">Other models…</span>
                  <kbd className="shrink-0 font-sans text-mini text-tertiary">
                    {prettyAccelerator(OTHER_MODELS_SHORTCUT)}
                  </kbd>
                </Button>
                <Button
                  variant="transparent"
                  size="small"
                  className={cn(
                    "w-full justify-start gap-2 px-2.5 font-normal",
                    settingsBlockedReason && "opacity-45",
                  )}
                  aria-disabled={Boolean(settingsBlockedReason)}
                  aria-describedby={settingsBlockedReason ? customizeReasonId : undefined}
                  title={settingsBlockedReason}
                  onClick={openCustomize}
                >
                  <SlidersHorizontal className="size-4 text-tertiary" />
                  <span className="min-w-0 flex-1 truncate text-left">Customize slider…</span>
                </Button>
                {settingsBlockedReason ? (
                  <span id={customizeReasonId} className="sr-only">
                    {settingsBlockedReason}.
                  </span>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="pt-1.5">
              <div className="flex min-w-0 items-center gap-1 px-1.5">
                <Button
                  variant="transparent"
                  size="small"
                  iconOnly
                  aria-label="Back to slider"
                  title="Back to slider"
                  onClick={backToSlider}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <div className="min-w-0 flex-1">
                  <Text id={listHeadingId} variant="small-strong" as="h3" truncate>
                    {view.kind === "reassign"
                      ? `Choose a model for ${reassignStop?.label ?? "this stop"}`
                      : "Other models"}
                  </Text>
                  {view.kind === "reassign" && reassignView?.reasonText ? (
                    <Text variant="small" color="tertiary" as="p" truncate>
                      {reassignView.reasonText}
                    </Text>
                  ) : null}
                </div>
              </div>
              <ModelListPanel
                entries={entries}
                selectedValue={view.kind === "reassign" ? "" : selectedValue}
                active={open}
                search={search}
                onSearchChange={setSearch}
                previewValue={previewValue}
                onPreviewChange={setPreviewValue}
                onChoose={(entry) => {
                  if (view.kind === "reassign") void reassign(entry);
                  else chooseFromList(entry);
                }}
                searchRef={searchRef}
                pageKey={`${listShowing}`}
                sectionProps={{ id: listId, "aria-labelledby": listHeadingId }}
              />
            </div>
          )}
        </div>
        {listView && showDetails && wide ? (
          <ModelHoverDetails
            model={detailEntry}
            alsoVia={detailEntry ? alsoViaLabel(siblingsByValue.get(detailEntry.value)) : undefined}
            pace={detailEntry ? paceSummaries?.[detailEntry.value] : undefined}
            metadataLoading={catalog.isLoading}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
