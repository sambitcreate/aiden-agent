// Provider + model picker for the composer. Compact trigger (icon + name +
// chevrons) opens a searchable dropdown: hosted models (cloud icon) and local
// models (chip icon), each with an optional quant/format tag, a check on the
// active model, and a pin toggle that floats favourites to the top.

import * as React from "react";
import {
  Button,
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CustomDropdownMenu,
  CustomDropdownMenuContent,
  CustomDropdownMenuTrigger,
  Text,
} from "./ui";
import { cn } from "../lib/ui-utils";
import { Check, ChevronsUpDown, Cloud, Cpu, Pin } from "lucide-react";
import type { Provider } from "../lib/types";

export function encodeSelection(providerId: string, model: string): string {
  return `${providerId}::${model}`;
}

export function decodeSelection(value: string): { providerId: string; model: string } {
  const idx = value.indexOf("::");
  if (idx < 0) return { providerId: value, model: "" };
  return { providerId: value.slice(0, idx), model: value.slice(idx + 2) };
}

/** A provider is usable once it has models listed and (if required) a key. */
export function isUsable(p: Provider): boolean {
  return p.models.length > 0 && (p.hasKey || !p.needsKey);
}

const PINNED_KEY = "aiden-agent.pinnedModels";
// Trailing quant/format token in a model name, e.g. "…-mlx", "… Q4_K_S", "…-GGUF".
const FORMAT_RE = /[\s._-](MLX|GGUF|GGML|FP16|BF16|F16|INT8|AWQ|GPTQ|Q\d(?:_[A-Z0-9]+)*)$/i;

function providerIsLocal(p: Provider): boolean {
  try {
    const hostname = new URL(p.baseUrl).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "::1" || /^127\./.test(hostname);
  } catch {
    return false;
  }
}

/** Split a model id into a display label and an optional quant/format tag. */
function parseModel(name: string): { label: string; format: string | null } {
  const m = name.match(FORMAT_RE);
  if (!m || m.index === undefined) return { label: name, format: null };
  return { label: name.slice(0, m.index).trim() || name, format: m[1].toUpperCase() };
}

interface ModelEntry {
  value: string;
  providerId: string;
  model: string;
  label: string;
  format: string | null;
  providerLabel: string;
  isLocal: boolean;
}

interface ModelPickerProps {
  providers: Provider[];
  providerId: string;
  model: string;
  onChange: (providerId: string, model: string) => void;
  disabled?: boolean;
}

export function ModelPicker({
  providers,
  providerId,
  model,
  onChange,
  disabled,
}: ModelPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [pinned, setPinned] = React.useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(PINNED_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });

  const togglePin = React.useCallback((value: string) => {
    setPinned((prev) => {
      const next = prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value];
      localStorage.setItem(PINNED_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // Flatten usable providers into entries, hosted providers first then local.
  const entries = React.useMemo<ModelEntry[]>(() => {
    const usable = providers.filter(isUsable);
    const ordered = [...usable].sort(
      (a, b) => Number(providerIsLocal(a)) - Number(providerIsLocal(b)),
    );
    const list: ModelEntry[] = [];
    for (const p of ordered) {
      const local = providerIsLocal(p);
      for (const m of p.models) {
        const { label, format } = parseModel(m);
        list.push({
          value: encodeSelection(p.id, m),
          providerId: p.id,
          model: m,
          label,
          format,
          providerLabel: p.label,
          isLocal: local,
        });
      }
    }
    // Pinned entries float to the top, in pin order.
    const pinnedSet = new Set(pinned);
    const pinnedEntries = pinned
      .map((v) => list.find((e) => e.value === v))
      .filter((e): e is ModelEntry => Boolean(e));
    const rest = list.filter((e) => !pinnedSet.has(e.value));
    return [...pinnedEntries, ...rest];
  }, [providers, pinned]);

  const selectedValue = providerId && model ? encodeSelection(providerId, model) : "";
  const selected = entries.find((e) => e.value === selectedValue);
  const hasUnavailableSelection = Boolean(selectedValue && !selected);
  const hasModels = entries.length > 0;
  const unavailableMessage =
    "No chat models are available. Open Settings → Providers to discover models for a connection.";

  const choose = (entry: ModelEntry) => {
    onChange(entry.providerId, entry.model);
    setOpen(false);
  };

  return (
    <CustomDropdownMenu open={open} onOpenChange={setOpen}>
      <CustomDropdownMenuTrigger asChild>
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
      </CustomDropdownMenuTrigger>

      <CustomDropdownMenuContent align="start" className="w-72 p-0">
        <Command
          label="Chat model"
          // cmdk owns filtering + arrow-key nav; keep those keys from reaching the
          // Radix menu, but let Escape bubble up so the menu can still close.
          onKeyDown={(e) => {
            if (e.key !== "Escape") e.stopPropagation();
          }}
        >
          <div className="px-3 pt-2">
            <Text variant="small" color="tertiary">
              Model
            </Text>
          </div>
          <CommandInput aria-label="Filter chat models" placeholder="Filter models…" />
          <CommandList>
            <CommandEmpty>No models found.</CommandEmpty>
            {entries.map((entry) => {
              const isActive = entry.value === selectedValue;
              const isPinned = pinned.includes(entry.value);
              return (
                <CommandItem
                  key={entry.value}
                  value={`${entry.label} ${entry.providerLabel} ${entry.format ?? ""}`}
                  onSelect={() => choose(entry)}
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
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
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
      </CustomDropdownMenuContent>
    </CustomDropdownMenu>
  );
}
