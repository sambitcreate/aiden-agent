import * as React from "react";
import { Check, Loader2, Plus, Save, Search, Sparkles, Undo2, X } from "lucide-react";
import { Badge, Button, Field, FieldSet, Input, Text, toast } from "../ui";
import { ProviderIcon } from "../provider-icon";
import {
  createModelEntries,
  encodeSelection,
  visibleModelEntries,
  type ModelEntry,
} from "../../lib/model-picker-data";
import {
  emptyModelPadLayout,
  modelPadLayoutsEqual,
  nextModelPadPlacement,
  readModelPadLayout,
  writeModelPadLayout,
} from "../../lib/model-pad-layout";
import {
  useArtificialAnalysisStatus,
  useProviders,
  useProvidersModelInfo,
  useSettings,
} from "../../lib/queries";
import type { ModelInfo } from "../../lib/types";
import { cn } from "../../lib/ui-utils";

const PAD_INSET_PERCENT = 8;
const PAD_RANGE_PERCENT = 100 - PAD_INSET_PERCENT * 2;

function padLeft(x: number): number {
  return PAD_INSET_PERCENT + x * PAD_RANGE_PERCENT;
}

function padTop(y: number): number {
  return PAD_INSET_PERCENT + (1 - y) * PAD_RANGE_PERCENT;
}

function pointFromPointer(event: React.PointerEvent, rect: DOMRect): { x: number; y: number } {
  const inset = PAD_INSET_PERCENT / 100;
  const range = PAD_RANGE_PERCENT / 100;
  const rawX = (event.clientX - rect.left) / rect.width;
  const rawY = (event.clientY - rect.top) / rect.height;
  return {
    x: Math.min(1, Math.max(0, (rawX - inset) / range)),
    y: 1 - Math.min(1, Math.max(0, (rawY - inset) / range)),
  };
}

function placementLabel(entry: ModelEntry): string {
  return `${entry.label} from ${entry.providerLabel}`;
}

export function ModelPadSettings() {
  const providersQuery = useProviders();
  const providers = providersQuery.data ?? [];
  const catalog = useProvidersModelInfo(providers);
  const artificialAnalysis = useArtificialAnalysisStatus();
  const settings = useSettings();
  const [saved, setSaved] = React.useState(readModelPadLayout);
  const [draft, setDraft] = React.useState(readModelPadLayout);
  const [filter, setFilter] = React.useState("");
  const [activeValue, setActiveValue] = React.useState<string>();
  const padRef = React.useRef<HTMLDivElement | null>(null);
  const helpId = React.useId();

  const infoByValue: Record<string, ModelInfo | undefined> = {};
  providers.forEach((provider) => {
    const data = catalog.data[provider.id];
    for (const modelId of provider.models) {
      infoByValue[encodeSelection(provider.id, modelId)] = data?.[modelId];
    }
  });
  const entries = visibleModelEntries(
    createModelEntries(providers, infoByValue),
    settings.data?.hiddenModelsByProvider,
  );
  const entriesByValue = new Map(entries.map((entry) => [entry.value, entry]));
  const placed = entries.filter((entry) => draft.placements[entry.value]);
  const draftPlacementCount = Object.keys(draft.placements).length;
  const query = filter.trim().toLocaleLowerCase();
  const filteredEntries = query
    ? entries.filter((entry) =>
        `${entry.label} ${entry.providerLabel} ${entry.model}`.toLocaleLowerCase().includes(query),
      )
    : entries;
  const suggestionCount = entries.filter(
    (entry) => !draft.placements[entry.value] && entry.ranking,
  ).length;
  const dirty = !modelPadLayoutsEqual(saved, draft);
  const loading = providersQuery.isLoading || catalog.isLoading;

  const updatePlacement = React.useCallback((value: string, point: { x: number; y: number }) => {
    setDraft((current) => ({
      ...current,
      placements: {
        ...current.placements,
        [value]: { ...point, source: "user" },
      },
    }));
  }, []);

  const addModel = (value: string) => {
    setDraft((current) => {
      if (current.placements[value]) return current;
      return {
        ...current,
        placements: {
          ...current.placements,
          [value]: nextModelPadPlacement(current.placements),
        },
      };
    });
    setActiveValue(value);
  };

  const removeModel = (value: string) => {
    setDraft((current) => {
      const placements = { ...current.placements };
      delete placements[value];
      return { ...current, placements };
    });
    setActiveValue((current) => (current === value ? undefined : current));
  };

  const suggestUnplaced = () => {
    setDraft((current) => {
      const placements = { ...current.placements };
      for (const entry of entries) {
        if (placements[entry.value] || !entry.ranking) continue;
        placements[entry.value] = {
          x: Math.min(0.92, Math.max(0.08, entry.ranking.responseTimePercentile)),
          y: Math.min(0.92, Math.max(0.08, entry.ranking.capabilityPercentile)),
          source: "artificial-analysis",
        };
      }
      return { ...current, placements };
    });
  };

  const save = () => {
    try {
      const next = writeModelPadLayout(draft);
      setSaved(next);
      setDraft(next);
      toast.success(
        draftPlacementCount === 0
          ? "Model Pad cleared."
          : `${draftPlacementCount} model${draftPlacementCount === 1 ? "" : "s"} saved to your Pad.`,
      );
    } catch {
      toast.error("Aiden couldn’t save your Model Pad on this device.");
    }
  };

  return (
    <FieldSet title="Personal Model Pad">
      <Field
        label="Arrange your models"
        description="Choose the models you want close at hand, then place them by how capable and responsive they feel for your work. Only saved models appear on the Pad."
        orientation="vertical"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2" aria-live="polite">
            <Badge>{placed.length} on Pad</Badge>
            {dirty ? <Badge color="blue">Unsaved changes</Badge> : null}
            {!dirty && placed.length > 0 ? (
              <Badge className="gap-1">
                <Check aria-hidden="true" className="size-3 text-green" />
                Saved locally
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="small"
              variant="transparent"
              onClick={() => setDraft(saved)}
              disabled={!dirty}
            >
              <Undo2 />
              Reset changes
            </Button>
            <Button size="small" variant="accent" onClick={save} disabled={!dirty}>
              <Save />
              Save Pad
            </Button>
          </div>
        </div>

        <div className="settings-model-pad-grid grid grid-cols-[minmax(0,1fr)_13.5rem] gap-4 max-[620px]:grid-cols-1">
          <div className="min-w-0">
            <div className="mb-2 flex items-center justify-center text-[11px] text-secondary">
              More capable
            </div>
            <div
              ref={padRef}
              aria-describedby={helpId}
              aria-label="Personal Model Pad arrangement"
              className="model-pad relative aspect-square w-full overflow-hidden rounded-card"
            >
              {Array.from({ length: 49 }, (_, index) => {
                const column = index % 7;
                const row = Math.floor(index / 7);
                return (
                  <span
                    key={index}
                    aria-hidden="true"
                    className="absolute size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/16"
                    style={{
                      left: `${PAD_INSET_PERCENT + (column / 6) * PAD_RANGE_PERCENT}%`,
                      top: `${PAD_INSET_PERCENT + (row / 6) * PAD_RANGE_PERCENT}%`,
                    }}
                  />
                );
              })}

              {placed.length === 0 ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-10 text-center">
                  <Text as="p" variant="small" color="secondary" className="max-w-52 text-pretty">
                    Add a few models from the list, then drag them into place.
                  </Text>
                </div>
              ) : null}

              {placed.map((entry) => {
                const placement = draft.placements[entry.value];
                const selected = activeValue === entry.value;
                return (
                  <button
                    key={entry.value}
                    type="button"
                    aria-label={`${placementLabel(entry)}. Drag to arrange; use arrow keys to nudge.`}
                    className={cn(
                      "absolute z-10 max-w-28 -translate-x-1/2 -translate-y-1/2 cursor-grab truncate rounded-pill px-2 py-1 text-[11px] font-medium outline-none transition-[background-color,box-shadow,color] duration-150 ease-out active:cursor-grabbing focus-visible:outline-none",
                      placement.source === "user"
                        ? "bg-accent text-accent-foreground focus-visible:bg-accent-hover"
                        : "bg-popover text-primary ring-1 ring-accent/45 focus-visible:bg-list-selection",
                      selected &&
                        "bg-list-selection ring-1 ring-accent focus-visible:bg-list-selection",
                    )}
                    style={{ left: `${padLeft(placement.x)}%`, top: `${padTop(placement.y)}%` }}
                    onFocus={() => setActiveValue(entry.value)}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      setActiveValue(entry.value);
                      event.currentTarget.focus();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      const rect = padRef.current?.getBoundingClientRect();
                      if (rect) updatePlacement(entry.value, pointFromPointer(event, rect));
                    }}
                    onPointerMove={(event) => {
                      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                      const rect = padRef.current?.getBoundingClientRect();
                      if (rect) updatePlacement(entry.value, pointFromPointer(event, rect));
                    }}
                    onPointerUp={(event) => {
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      }
                    }}
                    onKeyDown={(event) => {
                      const step = event.shiftKey ? 0.1 : 0.04;
                      const current = draft.placements[entry.value];
                      const delta = {
                        ArrowLeft: { x: -step, y: 0 },
                        ArrowRight: { x: step, y: 0 },
                        ArrowUp: { x: 0, y: step },
                        ArrowDown: { x: 0, y: -step },
                      }[event.key];
                      if (!delta) return;
                      event.preventDefault();
                      updatePlacement(entry.value, {
                        x: Math.min(1, Math.max(0, current.x + delta.x)),
                        y: Math.min(1, Math.max(0, current.y + delta.y)),
                      });
                    }}
                    title={`${entry.label} · ${entry.providerLabel}`}
                  >
                    {entry.label}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] text-secondary">
              <span>Faster</span>
              <span>More deliberate</span>
            </div>
            <p id={helpId} className="sr-only">
              Move models vertically by personal capability and horizontally by perceived response
              pace. Arrow keys move four percent; Shift plus an arrow moves ten percent.
            </p>
          </div>

          <div className="min-w-0">
            <label className="relative block">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-tertiary"
              />
              <Input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter models…"
                aria-label="Filter models available for the Pad"
                className="pl-8"
              />
            </label>
            <div className="mt-2 max-h-[22rem] overflow-y-auto rounded-control bg-background/35 p-1">
              {loading ? (
                <div className="flex items-center justify-center gap-2 px-3 py-8 text-small text-secondary">
                  <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                  Loading models…
                </div>
              ) : filteredEntries.length === 0 ? (
                <Text as="p" variant="small" color="secondary" className="px-3 py-8 text-center">
                  {entries.length === 0
                    ? "Connect or discover a chat model first."
                    : "No models match this filter."}
                </Text>
              ) : (
                filteredEntries.map((entry) => {
                  const onPad = Boolean(draft.placements[entry.value]);
                  return (
                    <div
                      key={entry.value}
                      className="flex min-h-11 items-center gap-2 rounded-control px-2 py-1.5 hover:bg-list-hover"
                    >
                      <ProviderIcon
                        providerId={entry.providerId}
                        providerLabel={entry.providerLabel}
                        modelId={entry.model}
                        artwork={entry.providerArtwork}
                        className="size-3.5 text-tertiary"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-small-strong text-primary">
                          {entry.label}
                        </span>
                        <span className="block truncate text-[11px] text-tertiary">
                          {entry.providerLabel}
                          {entry.isLocal ? " · Local" : " · Hosted"}
                        </span>
                      </span>
                      <Button
                        size="small"
                        variant="transparent"
                        iconOnly
                        aria-label={
                          onPad
                            ? `Remove ${placementLabel(entry)} from Pad`
                            : `Add ${placementLabel(entry)} to Pad`
                        }
                        title={onPad ? "Remove from Pad" : "Add to Pad"}
                        onClick={() => (onPad ? removeModel(entry.value) : addModel(entry.value))}
                      >
                        {onPad ? <X /> : <Plus />}
                      </Button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-background/35 px-3 py-2.5">
          <div className="min-w-0 flex-1 basis-72">
            <Text as="p" variant="small-strong">
              Optional benchmark suggestions
            </Text>
            <Text as="p" variant="small" color="secondary" className="mt-0.5">
              {artificialAnalysis.data?.ready
                ? suggestionCount > 0
                  ? `${suggestionCount} unplaced model${suggestionCount === 1 ? " has" : "s have"} a cached Artificial Analysis position.`
                  : "No unplaced models currently have cached benchmark positions."
                : "Connect Artificial Analysis below only if you want suggestions for unplaced hosted models."}
            </Text>
          </div>
          <Button
            size="small"
            onClick={suggestUnplaced}
            disabled={!artificialAnalysis.data?.ready || suggestionCount === 0}
          >
            <Sparkles />
            Suggest unplaced
          </Button>
        </div>

        {Object.keys(draft.placements).some((value) => !entriesByValue.has(value)) ? (
          <Text as="p" variant="small" color="secondary">
            Saved positions for temporarily unavailable models are retained and will return when
            those models are available again.
          </Text>
        ) : null}

        {draftPlacementCount > 0 ? (
          <Button
            size="small"
            variant="transparent"
            className="self-start text-secondary"
            onClick={() => setDraft(emptyModelPadLayout())}
          >
            Remove all models from Pad
          </Button>
        ) : null}
      </Field>
    </FieldSet>
  );
}
