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
import type { ModelEntry } from "../../../lib/model-picker-data";

/** How many pinned and recent models the Recent section lists at most. */
export const MODEL_PAD_ADD_RECENT_LIMIT = 5;

function placementLabel(entry: ModelEntry): string {
  return `${entry.label} from ${entry.providerLabel}`;
}

/** Every model the Add list offers: by provider, then by name. */
export function sortModelsForAdding(entries: readonly ModelEntry[]): ModelEntry[] {
  return [...entries].sort(
    (left, right) =>
      left.providerLabel.localeCompare(right.providerLabel) || left.label.localeCompare(right.label),
  );
}

function AddRow({
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
      aria-label={
        onPad ? `Remove ${placementLabel(entry)} from Pad` : `Add ${placementLabel(entry)} to Pad`
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
}

/**
 * The header's Add button: a searchable list of visible models. Each row
 * toggles its model on or off the Pad and the list stays open, so several
 * models can be added in a row.
 */
export function ModelPadAddPopover({
  triggerRef,
  entries,
  recentEntries,
  isOnPad,
  loading,
  onToggle,
}: {
  triggerRef?: React.Ref<HTMLButtonElement>;
  /** Visible models. */
  entries: readonly ModelEntry[];
  /** Pinned, then recent visible models that are not on the Pad. */
  recentEntries: readonly ModelEntry[];
  isOnPad: (value: string) => boolean;
  loading: boolean;
  onToggle: (entry: ModelEntry) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  // Recent keeps the rows it opened with until the list closes: toggling one
  // off the list must not remove its row, or the highlight would jump to
  // another model and a second Enter would add that one instead. The rows are
  // only picked up later when there were none yet (still loading on open).
  const [shownRecent, setShownRecent] = React.useState<readonly ModelEntry[]>([]);
  React.useEffect(() => {
    if (open && shownRecent.length === 0 && recentEntries.length > 0) setShownRecent(recentEntries);
  }, [open, shownRecent.length, recentEntries]);
  const term = query.trim().toLocaleLowerCase();
  const sorted = React.useMemo(() => sortModelsForAdding(entries), [entries]);
  const matches = term
    ? sorted.filter((entry) =>
        `${entry.label} ${entry.providerLabel} ${entry.model}`.toLocaleLowerCase().includes(term),
      )
    : sorted;
  const recent = term ? [] : shownRecent.slice(0, MODEL_PAD_ADD_RECENT_LIMIT);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setShownRecent(next ? recentEntries : []);
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
        <Command shouldFilter={false} loop label="Search models">
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
                        onPad={isOnPad(entry.value)}
                        onToggle={onToggle}
                      />
                    ))}
                  </CommandGroup>
                ) : null}
                {matches.length > 0 ? (
                  <CommandGroup heading={term ? undefined : "All models"}>
                    {matches.map((entry) => (
                      <AddRow
                        key={entry.value}
                        entry={entry}
                        section="all"
                        onPad={isOnPad(entry.value)}
                        onToggle={onToggle}
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
