import * as React from "react";
import { Check, Loader2, Plus } from "lucide-react";
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
} from "../../ui";
import { InfoHint } from "../../ui-info-hint";
import { ProviderIcon } from "../../provider-icon";
import {
  modelPlacementLabel,
  sortModelsByProviderAndName,
  type ModelEntry,
} from "../../../lib/model-picker-data";

/**
 * A row matches when every word of the search appears in its name, provider or
 * model id, so "nova acme" finds Nova from Acme. Matches score 1 and the rest
 * 0, which keeps the provider → name order.
 */
function filterAddRow(_value: string, search: string, keywords?: string[]): number {
  const haystack = (keywords ?? []).join(" ").toLocaleLowerCase();
  const terms = search.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return terms.every((term) => haystack.includes(term)) ? 1 : 0;
}

const AddRow = React.memo(function AddRow({
  entry,
  section,
  onPad,
  onToggle,
}: {
  entry: ModelEntry;
  section: "recent" | "all";
  onPad: boolean;
  onToggle: (entry: ModelEntry) => void;
}) {
  return (
    <CommandItem
      value={`${section}:${entry.value}`}
      keywords={[entry.label, entry.providerLabel, entry.model]}
      aria-label={
        onPad ? `Remove ${modelPlacementLabel(entry)} from Pad` : `Add ${modelPlacementLabel(entry)} to Pad`
      }
      data-on-pad={onPad ? "true" : undefined}
      className="min-h-9 py-1"
      onSelect={() => onToggle(entry)}
    >
      <ProviderIcon
        providerId={entry.providerId}
        providerLabel={entry.providerLabel}
        modelId={entry.model}
        artwork={entry.providerArtwork}
        className="size-4 shrink-0 text-tertiary"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-small-strong text-primary">{entry.label}</span>
        <span className="block truncate text-mini text-tertiary">
          {entry.providerLabel}
          {entry.isLocal ? " · Local" : ""}
        </span>
      </span>
      <span aria-hidden="true" className="grid size-4 shrink-0 place-items-center text-accent">
        {onPad ? <Check className="size-3.5" /> : null}
      </span>
    </CommandItem>
  );
});

/**
 * The header's Add button: a searchable list of visible models. Each row
 * toggles its model on or off the Pad and the list stays open, so several
 * models can be added in a row.
 */
export function ModelPadAddPopover({
  triggerRef,
  entries,
  recentEntries,
  placedValues,
  loading,
  recentReady,
  onToggle,
}: {
  triggerRef?: React.Ref<HTMLButtonElement>;
  /** Visible models. */
  entries: readonly ModelEntry[];
  /** Pinned, then recent visible models that are not on the Pad, already capped. */
  recentEntries: readonly ModelEntry[];
  /** Values of the models on the Pad. */
  placedValues: ReadonlySet<string>;
  loading: boolean;
  /** Whether `recentEntries` has loaded (models and pinned/recent history). */
  recentReady: boolean;
  onToggle: (entry: ModelEntry) => void;
}) {
  // One stable toggle for every row, so a row re-renders only when its own state changes.
  const onToggleRef = React.useRef(onToggle);
  React.useLayoutEffect(() => {
    onToggleRef.current = onToggle;
  });
  const toggle = React.useCallback((entry: ModelEntry) => onToggleRef.current(entry), []);
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  // Recent keeps the rows it opened with until the list closes: toggling one
  // must neither remove nor add a row, or the highlight would jump to another
  // model and a second Enter would toggle that one instead. Only a list opened
  // before its data loaded picks the rows up once, when they arrive.
  const [shownRecent, setShownRecent] = React.useState<readonly ModelEntry[]>([]);
  const [awaitingRecent, setAwaitingRecent] = React.useState(false);
  React.useEffect(() => {
    if (!open || !awaitingRecent || !recentReady) return;
    setAwaitingRecent(false);
    setShownRecent(recentEntries);
  }, [open, awaitingRecent, recentReady, recentEntries]);
  const searching = query.trim().length > 0;
  const sorted = React.useMemo(() => sortModelsByProviderAndName(entries), [entries]);
  // Recent is for browsing; a search looks through every model once.
  const recent = searching ? [] : shownRecent;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setShownRecent(next ? recentEntries : []);
        setAwaitingRecent(next && !recentReady);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button ref={triggerRef} size="small" variant="accent">
          <Plus aria-hidden="true" />
          Add
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Add models to the Pad"
        className="w-80 max-w-[calc(100vw-2rem)] p-1.5"
      >
        <Command filter={filterAddRow} loop label="Search models">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={`Search ${entries.length} model${entries.length === 1 ? "" : "s"}`}
            showSeparator={false}
            containerClassName="h-8 rounded-control border border-field bg-input px-2.5 focus-within:bg-control"
            className="text-small"
          />
          <CommandList className="mt-1.5 h-auto max-h-[min(340px,calc(100vh-12rem))] p-0">
            {loading ? (
              <div className="flex items-center justify-center gap-2 px-3 py-6 text-small text-secondary">
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                Loading models…
              </div>
            ) : (
              <>
                <CommandEmpty>
                  {entries.length === 0
                    ? "Connect or discover a chat model first."
                    : "No models match."}
                </CommandEmpty>
                {recent.length > 0 ? (
                  <CommandGroup heading="Recent">
                    {recent.map((entry) => (
                      <AddRow
                        key={entry.value}
                        entry={entry}
                        section="recent"
                        onPad={placedValues.has(entry.value)}
                        onToggle={toggle}
                      />
                    ))}
                  </CommandGroup>
                ) : null}
                {sorted.length > 0 ? (
                  <CommandGroup heading={searching ? undefined : "All models"}>
                    {sorted.map((entry) => (
                      <AddRow
                        key={entry.value}
                        entry={entry}
                        section="all"
                        onPad={placedValues.has(entry.value)}
                        onToggle={toggle}
                      />
                    ))}
                  </CommandGroup>
                ) : null}
              </>
            )}
          </CommandList>
        </Command>
        <div className="mt-1 flex items-center gap-1 px-2 pb-0.5 pt-1.5 text-mini text-tertiary">
          Hidden models stay out
          <InfoHint topic="hidden models" side="top">
            <p>Only models visible in Settings → Providers can go on the Pad.</p>
          </InfoHint>
        </div>
      </PopoverContent>
    </Popover>
  );
}
