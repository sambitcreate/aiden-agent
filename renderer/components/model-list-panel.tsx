// The searchable model list: a filter field, pinned and recent groups, one row
// per model with its Pin toggle, a Show more row, and the read-only detail
// card that sits beside it. Shared by the Bot chat's model picker, the
// composer's model popover (its "Other models" and reassign sub-view) and the
// Agent Slider editor's model chooser.

import * as React from "react";
import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Command,
  Text,
  toast,
} from "./ui";
import { cn } from "../lib/ui-utils";
import { orderModelEntries, recentModelsForList, type ModelEntry } from "../lib/model-picker-data";
import { formatListPrice, showsListPrice } from "../lib/model-details";
import { useModelPreferences } from "../lib/model-preferences";
import { recordRecentModel } from "../shared/model-preferences";
import type { ModelInfo } from "../lib/types";
import { Check, Ellipsis, Pin } from "lucide-react";
import { ProviderIcon } from "./provider-icon";
import { providerDeploymentLabel } from "../shared/provider-deployment";
import { rankMatches, type MatchRange } from "../lib/text-match";
import { resultCountMessage, useDebouncedAnnouncement } from "../lib/use-debounced-announcement";
import { MatchText } from "./match-text";
import { limitRows, showMoreLabel, useListLimit } from "../lib/list-limit";
import { ariaKeyShortcut, matchesAccelerator, prettyAccelerator } from "../shared/keybindings";
import { isComposingKey } from "../lib/dismiss-key";
import { revealInList } from "../lib/reveal-in-list";

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

/** Pins or unpins the highlighted List row. */
const PIN_SHORTCUT = "Command+Shift+P";
/** Model rows the List renders before a Show more row. */
const MODEL_LIST_PAGE = 100;
const SHOW_MORE_MODELS = "show-more-models";

/**
 * A secondary action inside a cmdk list row (Pin), for the mouse.
 * An option can't hold a focusable control, so it isn't one: keyboard and
 * screen reader users get the row's shortcut, named in its description. A
 * press never chooses the row.
 */
function ModelRowAction({
  label,
  shortcut,
  active,
  onToggle,
  children,
}: {
  label: string;
  shortcut: string;
  /** Pinned: the action stays visible instead of appearing on hover. */
  active: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <span
      aria-hidden="true"
      title={`${label} (${prettyAccelerator(shortcut)})`}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        "shrink-0 rounded-full p-0.5 text-tertiary transition-[background-color,color,opacity] duration-150 ease-out hover:bg-list-hover hover:text-secondary active:bg-list-selection",
        active
          ? "opacity-100"
          : "opacity-0 group-hover:opacity-100 group-data-[selected=true]:opacity-100",
      )}
    >
      {children}
    </span>
  );
}

/** What a row's description says about its Pin state and shortcut. */
function rowActionsDescription(isPinned: boolean): string {
  const pin = prettyAccelerator(PIN_SHORTCUT);
  return `${isPinned ? "Pinned" : "Not pinned"}. ${pin} ${isPinned ? "unpins it" : "pins it"}`;
}

const NO_RANGES: MatchRange[] = [];

/** One model row in the List, with its Pin toggle. */
function ModelListRow({
  entry,
  ranges,
  isActive,
  isPinned,
  onChoose,
  onPreview,
  onTogglePin,
}: {
  entry: ModelEntry;
  /** What the filter matched in the label. */
  ranges: readonly MatchRange[];
  isActive: boolean;
  isPinned: boolean;
  onChoose: (entry: ModelEntry) => void;
  onPreview: (value: string) => void;
  onTogglePin: (value: string) => unknown;
}) {
  const descriptionId = `model-description-${entry.value.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
  return (
    <CommandItem
      value={entry.value}
      aria-describedby={descriptionId}
      aria-keyshortcuts={ariaKeyShortcut(PIN_SHORTCUT)}
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
        <span className="block truncate text-small-strong">
          <MatchText text={entry.label} ranges={ranges} />
        </span>
        <span className="block truncate text-small text-tertiary">
          {entry.providerLabel}
          {deploymentSuffix(entry)}
        </span>
      </span>
      {entry.format ? (
        <span className="shrink-0 text-small text-tertiary">{entry.format}</span>
      ) : null}
      {/* Read through aria-describedby only, so the option's name stays the model's. */}
      <span id={descriptionId} className="sr-only" aria-hidden="true">
        {`${describeModel(entry)}. ${rowActionsDescription(isPinned)}.`}
      </span>
      {isActive ? <Check className="size-4 shrink-0 text-accent-text" /> : null}
      <ModelRowAction
        label={isPinned ? "Unpin" : "Pin"}
        shortcut={PIN_SHORTCUT}
        active={isPinned}
        onToggle={() => onTogglePin(entry.value)}
      >
        <Pin className={cn("size-3.5", isPinned && "fill-current text-accent-text")} />
      </ModelRowAction>
    </CommandItem>
  );
}

export function ModelHoverDetails({
  model,
  alsoVia,
  metadataLoading,
}: {
  model: ModelEntry | undefined;
  /** Other providers serving the same model, such as "Also via OpenRouter". */
  alsoVia?: string;
  metadataLoading: boolean;
}) {
  if (!model) return null;

  const info = model.info;
  const context = formatTokens(info?.contextLength);
  const output = formatTokens(info?.outputLimit);
  const inputs = formatInputs(info);
  const listPrice = showsListPrice(model) ? formatListPrice(info?.cost) : undefined;
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
    info?.releaseDate ? ["Released", info.releaseDate] : null,
    info?.knowledge ? ["Knowledge", info.knowledge] : null,
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
                      (such as a list price) is the part that matters. */}
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
        </div>
      </div>
    </aside>
  );
}

/** Wide enough windows show the detail card beside the list. */
export { useExternalModelDetails };

/**
 * Record a chosen model as the newest recent one. Recents are history: the
 * choice already happened, so a failed write is not worth interrupting anyone
 * for.
 */
export function useRecordRecentModel(): (value: string) => void {
  const { save } = useModelPreferences();
  return React.useCallback(
    (value: string) => {
      void save(({ recentModels: recent }) => {
        const next = recordRecentModel(recent, value);
        // Already the newest recent: nothing to write.
        const unchanged =
          next.length === recent.length && next.every((entry, index) => entry === recent[index]);
        return unchanged ? {} : { recentModels: next };
      }).catch((error: unknown) => {
        console.warn("Couldn’t record the recent model.", error);
      });
    },
    [save],
  );
}

export interface ModelListPanelProps {
  /** The models to list (hidden models already left out). */
  entries: readonly ModelEntry[];
  /** `provider::model` of the current model, marked with a check. */
  selectedValue: string;
  /** False while the surrounding popover is closed: grouping and announcements pause. */
  active: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  /** The highlighted row, shared with the detail card. */
  previewValue: string | undefined;
  onPreviewChange: (value: string | undefined) => void;
  onChoose: (entry: ModelEntry) => void;
  searchRef?: React.Ref<HTMLInputElement>;
  /** Changes when the list is shown afresh, so it starts on its first page again. */
  pageKey: string;
  /** The accessible name of the list ("Chat model"). */
  label?: string;
  /** The filter field's accessible name. */
  filterLabel?: string;
  placeholder?: string;
  /** Says what the section is when it is not a tab panel. */
  sectionProps?: React.HTMLAttributes<HTMLElement>;
}

/**
 * The searchable list. With an empty filter it groups pinned models, then
 * recent ones, then the rest; a filter shows one flat, ranked list with the
 * matched part of each label marked. The provider (name or ID), model ID and
 * format match without a mark. Each model is listed once.
 */
export function ModelListPanel({
  entries,
  selectedValue,
  active,
  search,
  onSearchChange,
  previewValue,
  onPreviewChange,
  onChoose,
  searchRef,
  pageKey,
  label = "Chat model",
  filterLabel = "Filter chat models",
  placeholder = "Filter models…",
  sectionProps,
}: ModelListPanelProps) {
  const { pinnedModels: pinned, recentModels, save: saveModelPreferences } = useModelPreferences();
  const sectionRef = React.useRef<HTMLElement | null>(null);
  const orderedEntries = React.useMemo(
    () => (active ? orderModelEntries([...entries], pinned) : []),
    [active, entries, pinned],
  );
  const listSections = React.useMemo(() => {
    if (search.trim()) {
      const ranked = rankMatches(orderedEntries, search, (entry) => ({
        title: entry.label,
        keywords: [entry.providerLabel, entry.providerId, entry.model, entry.format ?? ""],
      }));
      return {
        leading: ranked.map(({ item }) => item),
        recent: [],
        rest: [],
        ranges: new Map(ranked.map(({ item, ranges }) => [item.value, ranges])),
      };
    }
    const ranges = new Map<string, MatchRange[]>();
    const recent =
      active && search === ""
        ? recentModelsForList(entries, recentModels, { selectedValue, pinned })
        : [];
    if (!recent.length) return { leading: orderedEntries, recent, rest: [], ranges };
    const pinnedSet = new Set(pinned);
    const recentSet = new Set(recent.map((entry) => entry.value));
    return {
      leading: orderedEntries.filter((entry) => pinnedSet.has(entry.value)),
      recent,
      rest: orderedEntries.filter(
        (entry) => !pinnedSet.has(entry.value) && !recentSet.has(entry.value),
      ),
      ranges,
    };
  }, [active, search, entries, recentModels, selectedValue, pinned, orderedEntries]);

  const togglePin = React.useCallback(
    /** Resolves to whether the model is now pinned, or null when saving failed. */
    (value: string): Promise<boolean | null> =>
      // Selection stays usable if saving fails; the pin reverts and says why.
      saveModelPreferences(({ pinnedModels }) => ({
        pinnedModels: pinnedModels.includes(value)
          ? pinnedModels.filter((entry) => entry !== value)
          : [...pinnedModels, value],
      })).then(
        (saved) => Boolean(saved.pinnedModels?.includes(value)),
        (error: unknown) => {
          toast.error(error instanceof Error ? error.message : "Couldn’t update pinned models.");
          return null;
        },
      ),
    [saveModelPreferences],
  );

  const [listAnnouncement] = useDebouncedAnnouncement(
    resultCountMessage(listSections.leading.length, search),
    500,
  );
  // Pin changes made with a row's shortcut, said politely.
  const [actionAnnouncement, setActionAnnouncement] = React.useState("");
  const listLimit = useListLimit(MODEL_LIST_PAGE, `${pageKey}:${search}`);
  // The current and the highlighted model stay mounted past the cap (in their
  // place), so cmdk can select them and Enter can choose them.
  const listPage = limitRows(
    [listSections.leading, listSections.recent, listSections.rest],
    listLimit.limit,
    (entry) => entry.value === selectedValue || entry.value === previewValue,
  );
  const [shownLeading, shownRecent, shownRest] = listPage.sections;
  const showMoreModels =
    listPage.hidden > 0 ? showMoreLabel(listPage.hidden, MODEL_LIST_PAGE) : null;
  const announceTimerRef = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (announceTimerRef.current !== null) window.clearTimeout(announceTimerRef.current);
    },
    [],
  );
  // A fresh showing starts with nothing left to say.
  React.useEffect(() => {
    if (announceTimerRef.current !== null) window.clearTimeout(announceTimerRef.current);
    setActionAnnouncement("");
  }, [pageKey]);
  const activeRef = React.useRef(active);
  activeRef.current = active;
  const announceAction = (message: string) => {
    // A save that settles after the list closed has nobody to tell.
    if (!activeRef.current) return;
    // Cleared first, so the same words said twice are announced twice.
    setActionAnnouncement("");
    if (announceTimerRef.current !== null) window.clearTimeout(announceTimerRef.current);
    announceTimerRef.current = window.setTimeout(() => setActionAnnouncement(message), 100);
  };
  // A pin or unpin from the keyboard moves the highlighted row; keep it in view.
  const revealAfterPinRef = React.useRef(false);
  React.useLayoutEffect(() => {
    if (!revealAfterPinRef.current) return;
    revealAfterPinRef.current = false;
    const list = sectionRef.current?.querySelector<HTMLElement>("[cmdk-list]");
    const row = list?.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]');
    if (row) revealInList(row, list);
  }, [pinned]);
  const handleRowShortcut = (event: React.KeyboardEvent) => {
    if (!matchesAccelerator(event, PIN_SHORTCUT)) return;
    event.preventDefault();
    if (event.repeat || isComposingKey(event)) return;
    const entry = listPage.sections.flat().find((row) => row.value === previewValue);
    if (!entry) return;
    revealAfterPinRef.current = true;
    void togglePin(entry.value).then((nowPinned) => {
      if (nowPinned === null) revealAfterPinRef.current = false;
      else announceAction(`${nowPinned ? "Pinned" : "Unpinned"} ${entry.label}`);
    });
  };
  const renderListRow = (entry: ModelEntry) => (
    <ModelListRow
      key={entry.value}
      entry={entry}
      ranges={listSections.ranges.get(entry.value) ?? NO_RANGES}
      isActive={entry.value === selectedValue}
      isPinned={pinned.includes(entry.value)}
      onChoose={onChoose}
      onPreview={onPreviewChange}
      onTogglePin={togglePin}
    />
  );

  return (
    <section
      ref={sectionRef}
      {...sectionProps}
      className={cn("min-w-0 pt-1", sectionProps?.className)}
    >
      <Command
        label={label}
        // Models are filtered and ranked in listSections, in render order.
        shouldFilter={false}
        value={previewValue}
        onValueChange={onPreviewChange}
        onKeyDown={(event) => {
          if (event.key !== "Escape") event.stopPropagation();
          handleRowShortcut(event);
        }}
      >
        <CommandInput
          ref={searchRef}
          value={search}
          onValueChange={onSearchChange}
          aria-label={filterLabel}
          placeholder={placeholder}
        />
        <CommandList>
          <CommandEmpty>No models found.</CommandEmpty>
          {shownLeading.map(renderListRow)}
          {shownRecent.length ? (
            <CommandGroup heading="Recent">{shownRecent.map(renderListRow)}</CommandGroup>
          ) : null}
          {shownRest.map(renderListRow)}
          {showMoreModels || listLimit.grown ? (
            <CommandItem
              value={SHOW_MORE_MODELS}
              aria-label={showMoreModels?.label}
              disabled={!showMoreModels}
              hidden={!showMoreModels}
              onSelect={() => {
                // The first model revealed takes this row's place, so the
                // keyboard stays where it was.
                if (listPage.next) onPreviewChange(listPage.next.value);
                listLimit.showMore();
              }}
              className="gap-2"
            >
              <Ellipsis className="size-4 text-tertiary" />
              <span className="min-w-0 flex-1 truncate text-small-strong">
                {showMoreModels?.title}
              </span>
              <span className="shrink-0 text-small text-tertiary">{showMoreModels?.detail}</span>
            </CommandItem>
          ) : null}
        </CommandList>
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {listAnnouncement}
        </div>
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {actionAnnouncement}
        </div>
      </Command>
    </section>
  );
}
