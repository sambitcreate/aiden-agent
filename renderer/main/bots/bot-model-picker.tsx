import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  InlineMetadata,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui";
import { ProviderIcon } from "../../components/provider-icon";
import { useProviders } from "../../lib/queries";
import type { Provider } from "../../lib/types";
import type { BotCapabilityCatalog } from "../../shared/bot-capabilities";
import { findBotModel } from "./bot-model-choice";

/**
 * cmdk's default filter is fuzzy, so "seer" would also surface a model whose
 * service name merely contains those letters in order. A short model list reads
 * better with a plain substring match over the model and service names (never the opaque ids).
 */
function matchesModelFilter(_id: string, search: string, keywords?: string[]): number {
  const needle = search.trim().toLowerCase();
  if (!needle) return 1;
  return (keywords ?? []).join(" ").toLowerCase().includes(needle) ? 1 : 0;
}

export function botModelCapabilityLabel(supportsImages: boolean | undefined): "Reads images" | "Text only" {
  return supportsImages ? "Reads images" : "Text only";
}

/**
 * A model's mark: the provider's logo, or a Claude or Grok model's own mark.
 * The model's display name stands in for its id as the hint, since the catalog's
 * model id is opaque and names like "Claude Opus 4.1" carry the family.
 */
function BotModelMark({
  providerLabel,
  modelLabel,
  mark,
}: {
  providerLabel: string;
  modelLabel: string;
  mark: { id?: string; artwork?: Provider["artwork"] };
}) {
  return (
    <ProviderIcon
      providerId={mark.id ?? ""}
      providerLabel={providerLabel}
      modelId={modelLabel}
      artwork={mark.artwork}
      className="size-4 shrink-0 text-tertiary"
    />
  );
}

/**
 * The Bot's model chooser: a one-line trigger naming the model, and a
 * searchable list grouped by service. Models of a service that isn't set up
 * stay listed but can't be chosen.
 */
export function BotModelPicker({
  catalog,
  label,
  providerId,
  modelId,
  imagesOnly = false,
  recommended,
  disabled = false,
  onSelect,
}: {
  catalog: BotCapabilityCatalog;
  /** The trigger's accessible name, e.g. "AI model" or "Model for photos". */
  label: string;
  providerId?: string;
  modelId?: string;
  imagesOnly?: boolean;
  recommended?: { providerId: string; modelId: string };
  disabled?: boolean;
  onSelect(providerId: string, modelId: string): void;
}) {
  const [open, setOpen] = React.useState(false);
  // Bot catalog ids are opaque grant ids, so the catalog can't name a logo. Main
  // copies each provider's label into the catalog unchanged, so a label that
  // names exactly one provider in the providers list gives back its real id
  // (for the logo) and its artwork (a custom connection's picture). Anything
  // ambiguous keeps the neutral initial rather than guessing.
  const providers = useProviders();
  const markFor = (label: string): { id?: string; artwork?: Provider["artwork"] } => {
    const matches = providers.data?.filter((provider) => provider.label === label) ?? [];
    return matches.length === 1 ? { id: matches[0].id, artwork: matches[0].artwork } : {};
  };
  const selected = findBotModel(catalog, providerId, modelId);
  const isRecommended = Boolean(
    selected && recommended
      && recommended.providerId === selected.provider.id
      && recommended.modelId === selected.model.id,
  );
  const groups = catalog.providers
    .map((provider) => ({
      provider,
      models: provider.models.filter((model) => !imagesOnly || model.supportsImages === true),
    }))
    .filter(({ models }) => models.length > 0);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="filled"
          size="medium"
          disabled={disabled}
          aria-label={label}
          className="w-full min-w-0 max-w-full flex-nowrap justify-start gap-2 whitespace-nowrap"
        >
          {selected ? (
            <BotModelMark
              providerLabel={selected.provider.label}
              modelLabel={selected.model.label}
              mark={markFor(selected.provider.label)}
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-left">{selected?.model.label ?? "Choose a model"}</span>
          {isRecommended ? <InlineMetadata className="shrink-0">Recommended</InlineMetadata> : null}
          <ChevronDown className="size-4 shrink-0 text-tertiary" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(20rem,calc(100vw-1.5rem))] p-0">
        {/* cmdk names the filter input from the Command label, so it carries the input's name. */}
        <Command
          label="Filter models"
          filter={matchesModelFilter}
          onKeyDown={(event) => {
            // Keep Escape for the popover; other keys stay inside the list.
            if (event.key !== "Escape") event.stopPropagation();
          }}
        >
          <CommandInput placeholder="Filter models…" />
          <CommandList label={label}>
            <CommandEmpty>No models found.</CommandEmpty>
            {groups.map(({ provider, models }) => (
              <CommandGroup
                key={provider.id}
                heading={provider.available ? provider.label : `${provider.label} · Not set up`}
              >
                {models.map((model) => {
                  const usable = provider.available && model.available;
                  const isSelected = selected?.provider.id === provider.id && selected.model.id === model.id;
                  return (
                    <CommandItem
                      key={model.id}
                      value={`${provider.id}/${model.id}`}
                      keywords={[model.label, provider.label]}
                      disabled={!usable}
                      onSelect={() => {
                        onSelect(provider.id, model.id);
                        setOpen(false);
                      }}
                      className="gap-2"
                    >
                      <BotModelMark
                        providerLabel={provider.label}
                        modelLabel={model.label}
                        mark={markFor(provider.label)}
                      />
                      <span className="min-w-0 flex-1 truncate">{model.label}</span>
                      <InlineMetadata className="shrink-0">{botModelCapabilityLabel(model.supportsImages)}</InlineMetadata>
                      {isSelected ? <Check className="size-4 shrink-0" role="img" aria-label="Selected" /> : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
