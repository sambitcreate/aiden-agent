// Settings → Agent Slider: the editor for the composer's slider. A live
// preview on top (the real slider, which moves no chat), then one row per
// stop: its name, model, effort and whether it is home, with keyboard moves
// and Remove. Add stop and the two templates sit under the rows. Every change
// saves to config.json as it is made, and its toast offers Undo.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, Plus, Trash2, TriangleAlert } from "lucide-react";
import {
  AlertDialog,
  Button,
  Callout,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FieldSet,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  toast,
} from "../ui";
import { AgentSlider } from "../agent-slider";
import { ModelListPanel } from "../model-list-panel";
import { ProviderIcon } from "../provider-icon";
import {
  createModelEntries,
  encodeSelection,
  modelInfoByValue,
  visibleModelEntries,
  type ModelEntry,
} from "../../lib/model-picker-data";
import { queryKeys, useProviders, useProvidersModelInfo, useSettings } from "../../lib/queries";
import { settingsApi } from "../../lib/ipc";
import {
  agentSliderPosition,
  agentSliderStopViews,
  effortLabel,
  homeStopIndex,
  type AgentSliderStopView,
} from "../../lib/agent-slider-view";
import { cacheAgentSlider, seedAgentSliderIfAbsent } from "../../lib/agent-slider-seed";
import { composerThinkingLevels } from "../../lib/composer-thinking-levels";
import {
  ADD_STOP_LIMIT_REASON,
  REMOVE_STOP_LIMIT_REASON,
  addAgentSliderStop,
  agentSliderLabelError,
  assignAgentSliderStop,
  effortLadderTemplate,
  localToCloudTemplate,
  moveAgentSliderStop,
  removeAgentSliderStop,
  renameAgentSliderStop,
  sameAgentSlider,
  setAgentSliderHome,
  setAgentSliderStopEffort,
  type AgentSliderLadderModel,
  type AgentSliderTemplateModel,
} from "../../lib/agent-slider-editor";
import { readModelSelection, resolveVisibleModelSelection } from "../../lib/use-model-selection";
import {
  AGENT_SLIDER_MAX_STOPS,
  AGENT_SLIDER_MIN_STOPS,
  seedAgentSlider,
  type AgentSliderSettings as Slider,
  type AgentSliderStop,
} from "../../shared/agent-slider";
import type { GenerationThinkingLevel } from "../../shared/generation-thinking";
import type { AppSettings, Provider } from "../../lib/types";

/** Typing pauses this long before a valid name is saved. */
const LABEL_SAVE_DELAY_MS = 500;
/** Every action toast shares one id, so only the latest action is ever undoable. */
const ACTION_TOAST_ID = "agent-slider-action";
const SAVE_ERROR_MESSAGE = "Aiden couldn’t save the Agent Slider.";
const STALE_UNDO_MESSAGE = "Can’t undo — the slider changed since";
const UNREADABLE_MESSAGE =
  "Your config.json Agent Slider can’t be read, so the composer shows the model list only. Fix it by hand, or replace it with a new slider.";

interface ModelChoice {
  entry: ModelEntry;
  levels: GenerationThinkingLevel[];
  defaultLevel?: GenerationThinkingLevel;
}

function levelsFor(providers: readonly Provider[], entry: ModelEntry | undefined) {
  if (!entry) return { levels: [] as GenerationThinkingLevel[] };
  const provider = providers.find((candidate) => candidate.id === entry.providerId);
  return composerThinkingLevels(provider, entry.model, entry.info?.reasoning);
}

/** The model new chats start on, if it is still listed and visible. */
function newChatEntry(
  providers: Provider[],
  entries: readonly ModelEntry[],
  hidden: AppSettings["hiddenModelsByProvider"],
): (ModelEntry & { thinkingLevel?: GenerationThinkingLevel }) | undefined {
  const stored = readModelSelection();
  const selection = resolveVisibleModelSelection(stored, providers, hidden);
  if (!selection) return undefined;
  const entry = entries.find(
    (candidate) => candidate.value === encodeSelection(selection.providerId, selection.model),
  );
  if (!entry) return undefined;
  return selection.thinkingLevel ? { ...entry, thinkingLevel: selection.thinkingLevel } : entry;
}

export function AgentSliderSettings() {
  const settings = useSettings();
  const providersQuery = useProviders();
  const providers = React.useMemo(() => providersQuery.data ?? [], [providersQuery.data]);
  const catalog = useProvidersModelInfo(providers);
  const hidden = settings.data?.hiddenModelsByProvider;
  const allEntries = React.useMemo(
    () => createModelEntries(providers, modelInfoByValue(providers, catalog.data)),
    [providers, catalog.data],
  );
  const entries = React.useMemo(() => visibleModelEntries(allEntries, hidden), [allEntries, hidden]);

  if (!settings.data || providersQuery.isLoading) {
    return (
      <Text as="p" variant="small" color="secondary" role="status">
        Loading the Agent Slider…
      </Text>
    );
  }
  if (settings.data.agentSliderUnreadable) {
    return <UnreadableSlider providers={providers} entries={entries} hidden={hidden} />;
  }
  if (!settings.data.agentSlider) {
    return (
      <AbsentSlider
        providers={providers}
        entries={entries}
        hidden={hidden}
        catalogLoading={catalog.isLoading}
      />
    );
  }
  return (
    <SliderEditor
      slider={settings.data.agentSlider}
      providers={providers}
      allEntries={allEntries}
      entries={entries}
      hidden={hidden}
    />
  );
}

/**
 * What the slider is built around, as the composer seeds it: the new-chat
 * model (else the first model listed) and its effort levels.
 */
function newChatSeed(
  providers: Provider[],
  entries: readonly ModelEntry[],
  hidden: AppSettings["hiddenModelsByProvider"],
):
  | {
      selection: { providerId: string; model: string; thinkingLevel?: GenerationThinkingLevel };
      levels: GenerationThinkingLevel[];
    }
  | undefined {
  const newChat = newChatEntry(providers, entries, hidden);
  const entry = newChat ?? entries[0];
  if (!entry) return undefined;
  const { levels } = levelsFor(providers, entry);
  const level = newChat?.thinkingLevel;
  return {
    selection: {
      providerId: entry.providerId,
      model: entry.model,
      ...(level && levels.includes(level) ? { thinkingLevel: level } : {}),
    },
    levels,
  };
}

function AbsentSlider({
  providers,
  entries,
  hidden,
  catalogLoading,
}: {
  providers: Provider[];
  entries: readonly ModelEntry[];
  hidden: AppSettings["hiddenModelsByProvider"];
  catalogLoading: boolean;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const reasonId = React.useId();
  const reason = catalogLoading
    ? "Loading your models…"
    : entries.length === 0
      ? "Connect a provider in Settings → Providers first."
      : undefined;
  const setUp = async () => {
    if (reason || busy) return;
    const seed = newChatSeed(providers, entries, hidden);
    if (!seed) return;
    setBusy(true);
    try {
      await seedAgentSliderIfAbsent(seed.selection, seed.levels, queryClient);
    } catch {
      toast.error(SAVE_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  };
  return (
    <FieldSet title="Agent Slider">
      <div className="flex flex-col items-start gap-3 p-4">
        <Text as="p" variant="small" color="secondary">
          The slider isn’t set up yet. It starts with the model new chats use, and you can change
          every stop here.
        </Text>
        <Button
          variant="accent"
          size="small"
          aria-disabled={reason || busy ? true : undefined}
          aria-describedby={reason ? reasonId : undefined}
          onClick={() => void setUp()}
        >
          Set up the Agent Slider
        </Button>
        {reason ? (
          <Text as="p" id={reasonId} variant="small" color="tertiary">
            {reason}
          </Text>
        ) : null}
      </div>
    </FieldSet>
  );
}

function UnreadableSlider({
  providers,
  entries,
  hidden,
}: {
  providers: Provider[];
  entries: readonly ModelEntry[];
  hidden: AppSettings["hiddenModelsByProvider"];
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const replace = async () => {
    const seed = newChatSeed(providers, entries, hidden);
    if (!seed) return;
    setBusy(true);
    try {
      const saved = await settingsApi.setAgentSlider(seedAgentSlider(seed.selection, seed.levels));
      queryClient.setQueryData<AppSettings>(queryKeys.settings, saved);
      setConfirming(false);
    } catch {
      toast.error(SAVE_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  };
  return (
    <FieldSet title="Agent Slider">
      <div className="flex flex-col items-start gap-3 p-4">
        <Callout color="warning" role="status" className="w-full">
          <Text as="p" variant="small">
            {UNREADABLE_MESSAGE}
          </Text>
        </Callout>
        <Button
          variant="filled"
          size="small"
          aria-disabled={entries.length === 0 ? true : undefined}
          onClick={() => {
            if (entries.length > 0) setConfirming(true);
          }}
        >
          Replace
        </Button>
      </div>
      <AlertDialog
        open={confirming}
        onOpenChange={(next) => {
          if (!busy) setConfirming(next);
        }}
        title="Replace the Agent Slider?"
        description="Aiden writes a new slider over the one in config.json that can’t be read. Your hand edit is lost."
        confirmLabel="Replace"
        confirmVariant="destructive"
        busy={busy}
        keepOpenOnConfirm
        onConfirm={() => void replace()}
      />
    </FieldSet>
  );
}

interface SliderEditorProps {
  slider: Slider;
  providers: Provider[];
  allEntries: readonly ModelEntry[];
  entries: readonly ModelEntry[];
  hidden: AppSettings["hiddenModelsByProvider"];
}

function SliderEditor({ slider, providers, allEntries, entries, hidden }: SliderEditorProps) {
  const queryClient = useQueryClient();
  const entryByValue = React.useMemo(
    () => new Map(allEntries.map((entry) => [entry.value, entry])),
    [allEntries],
  );
  const entryFor = React.useCallback(
    (stop: Pick<AgentSliderStop, "providerId" | "model">) =>
      stop.providerId && stop.model
        ? entryByValue.get(encodeSelection(stop.providerId, stop.model))
        : undefined,
    [entryByValue],
  );

  // Names as typed, kept until the field loses focus; a valid one is saved
  // after a pause, an invalid one never.
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const pendingLabelRef = React.useRef<{ stopId: string; value: string } | undefined>(undefined);
  const labelTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Bumped by every action and Undo; an older action's Undo is stale.
  const generationRef = React.useRef(0);
  const writeChainRef = React.useRef<Promise<void>>(Promise.resolve());
  // The newest queued write; only it settles the cache or reports a failure.
  const latestWriteRef = React.useRef(0);
  const mountedRef = React.useRef(false);
  const [announcement, setAnnouncement] = React.useState("");
  const [chooserStopId, setChooserStopId] = React.useState<string>();
  const [previewStopId, setPreviewStopId] = React.useState(slider.homeStopId);
  const listRef = React.useRef<HTMLOListElement | null>(null);
  const addRef = React.useRef<HTMLButtonElement | null>(null);
  const focusRequestRef = React.useRef<string | undefined>(undefined);
  const addReasonId = React.useId();
  const removeReasonId = React.useId();

  // The preview rests on home whenever home changes.
  React.useEffect(() => {
    setPreviewStopId(slider.homeStopId);
  }, [slider.homeStopId]);

  const current = React.useCallback(
    () => queryClient.getQueryData<AppSettings>(queryKeys.settings)?.agentSlider,
    [queryClient],
  );

  /**
   * Save in order; the query shows the slider at once and settles on main's
   * copy. Each write carries the whole slider, so an older write that fails
   * while a newer one is queued is simply superseded: only the newest write
   * refetches and reports a failure, and an older one never repaints over it.
   */
  const write = React.useCallback(
    (next: Slider): Promise<void> => {
      queryClient.setQueryData<AppSettings>(queryKeys.settings, (settings) =>
        settings ? { ...settings, agentSlider: next } : settings,
      );
      const writeId = ++latestWriteRef.current;
      const isLatest = () => writeId === latestWriteRef.current;
      const run = writeChainRef.current.then(() => settingsApi.setAgentSlider(next));
      writeChainRef.current = run.then(
        () => undefined,
        () => undefined,
      );
      return run.then(
        (saved) => {
          if (!isLatest()) return;
          // A refetch from an earlier failure must not land after main's copy.
          void queryClient.cancelQueries({ queryKey: queryKeys.settings });
          cacheAgentSlider(queryClient, saved);
        },
        (error: unknown) => {
          if (!isLatest()) return;
          void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
          throw error;
        },
      );
    },
    [queryClient],
  );

  const undo = React.useCallback(
    (before: Slider, after: Slider) => {
      clearTimeout(labelTimerRef.current);
      pendingLabelRef.current = undefined;
      generationRef.current += 1;
      setDrafts({});
      if (!sameAgentSlider(current(), after)) {
        toast(STALE_UNDO_MESSAGE, { id: ACTION_TOAST_ID, action: undefined });
        return;
      }
      write(before).catch(() => toast.error(SAVE_ERROR_MESSAGE));
    },
    [current, write],
  );

  /** Save one action on the latest slider; its toast offers Undo back to before it. */
  const commit = React.useCallback(
    (compute: (latest: Slider) => Slider, message: (next: Slider) => string | undefined) => {
      const before = current();
      if (!before) return;
      const next = compute(before);
      if (next === before || sameAgentSlider(before, next)) return;
      const generation = ++generationRef.current;
      const text = message(next);
      write(next).then(
        () => {
          if (!text || generation !== generationRef.current || !mountedRef.current) return;
          toast(text, {
            id: ACTION_TOAST_ID,
            action: {
              label: "Undo",
              onClick: () => {
                if (generation === generationRef.current) undo(before, next);
              },
            },
          });
        },
        () => toast.error(SAVE_ERROR_MESSAGE),
      );
    },
    [current, undo, write],
  );

  const flushLabel = React.useCallback(() => {
    clearTimeout(labelTimerRef.current);
    labelTimerRef.current = undefined;
    const pending = pendingLabelRef.current;
    if (!pending) return;
    pendingLabelRef.current = undefined;
    commit(
      (latest) => renameAgentSliderStop(latest, pending.stopId, pending.value),
      () => `Renamed the stop to “${pending.value.trim()}”`,
    );
  }, [commit]);

  // A name still waiting for its pause is saved on the way out, quietly.
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(labelTimerRef.current);
      const pending = pendingLabelRef.current;
      pendingLabelRef.current = undefined;
      const latest = queryClient.getQueryData<AppSettings>(queryKeys.settings)?.agentSlider;
      if (pending && latest) {
        const next = renameAgentSliderStop(latest, pending.stopId, pending.value);
        if (next !== latest) write(next).catch(() => toast.error(SAVE_ERROR_MESSAGE));
      }
      toast.dismiss(ACTION_TOAST_ID);
    };
  }, [queryClient, write]);

  /** A structural action saves any name still waiting first, so both land. */
  const act = React.useCallback(
    (compute: (latest: Slider) => Slider, message: (next: Slider) => string | undefined) => {
      flushLabel();
      commit(compute, message);
    },
    [commit, flushLabel],
  );

  React.useLayoutEffect(() => {
    const key = focusRequestRef.current;
    if (!key) return;
    focusRequestRef.current = undefined;
    const target =
      key === "add"
        ? addRef.current
        : // Stop ids are letters, digits, "_" and "-", so the key needs no escaping.
          listRef.current?.querySelector<HTMLElement>(`[data-focus-key="${key}"]`);
    target?.focus();
    if (target instanceof HTMLInputElement) target.select();
  });

  const labelOf = (stop: AgentSliderStop) => stop.label;
  const views = React.useMemo(
    () =>
      agentSliderStopViews(
        slider,
        { providers, hiddenModelsByProvider: hidden },
        {
          providerLabel: (id) => providers.find((provider) => provider.id === id)?.label,
          modelLabel: (id, model) => entryByValue.get(encodeSelection(id, model))?.label,
        },
      ),
    [slider, providers, hidden, entryByValue],
  );
  const homeIndex = homeStopIndex(slider);
  const previewStop = slider.stops.find((stop) => stop.id === previewStopId);
  const position = React.useMemo(
    () =>
      agentSliderPosition(slider, views, {
        providerId: previewStop?.providerId ?? "",
        model: previewStop?.model ?? "",
        thinkingLevel: previewStop?.thinkingLevel,
      }),
    [slider, views, previewStop],
  );
  const shownStop = position.custom ? undefined : views[position.stopIndex];

  const atMax = slider.stops.length >= AGENT_SLIDER_MAX_STOPS;
  const atMin = slider.stops.length <= AGENT_SLIDER_MIN_STOPS;

  // Templates.
  const ladder: AgentSliderLadderModel | undefined = React.useMemo(() => {
    const candidates: (ModelEntry | undefined)[] = [
      entryFor(slider.stops.find((stop) => stop.id === slider.homeStopId) ?? {}),
      newChatEntry(providers, entries, hidden),
      ...slider.stops.map((stop) => entryFor(stop)),
    ];
    for (const entry of candidates) {
      if (!entry) continue;
      const { levels } = levelsFor(providers, entry);
      if (levels.length >= AGENT_SLIDER_MIN_STOPS) {
        return { providerId: entry.providerId, model: entry.model, levels };
      }
    }
    return undefined;
  }, [entryFor, slider, providers, entries, hidden]);

  const applyLadder = () => {
    if (!ladder) return;
    setDrafts({});
    act(
      () => effortLadderTemplate(ladder) ?? slider,
      () => "Applied the Effort ladder",
    );
  };
  const applyLocalToCloud = () => {
    const withDefault = (entry: ModelEntry | undefined, preferred?: GenerationThinkingLevel) => {
      if (!entry) return undefined;
      const { levels, defaultLevel } = levelsFor(providers, entry);
      const level = preferred && levels.includes(preferred) ? preferred : defaultLevel;
      const model: AgentSliderTemplateModel = {
        providerId: entry.providerId,
        model: entry.model,
        ...(levels.length && level ? { thinkingLevel: level } : {}),
      };
      return model;
    };
    const local = entries.find((entry) => entry.isLocal);
    const newChat = newChatEntry(providers, entries, hidden);
    const cloud = newChat && !newChat.isLocal ? newChat : undefined;
    setDrafts({});
    act(
      () =>
        localToCloudTemplate({
          local: withDefault(local),
          cloud: withDefault(cloud, cloud?.thinkingLevel),
        }),
      () => "Applied Local to cloud",
    );
  };

  const changeLabel = (stop: AgentSliderStop, value: string) => {
    setDrafts((previous) => ({ ...previous, [stop.id]: value }));
    if (pendingLabelRef.current && pendingLabelRef.current.stopId !== stop.id) flushLabel();
    clearTimeout(labelTimerRef.current);
    if (agentSliderLabelError(value)) {
      pendingLabelRef.current = undefined;
      return;
    }
    pendingLabelRef.current = { stopId: stop.id, value };
    labelTimerRef.current = setTimeout(flushLabel, LABEL_SAVE_DELAY_MS);
  };
  const blurLabel = (stop: AgentSliderStop) => {
    flushLabel();
    setDrafts((previous) => {
      const draft = previous[stop.id];
      if (draft === undefined || agentSliderLabelError(draft)) return previous;
      const { [stop.id]: _saved, ...rest } = previous;
      return rest;
    });
  };

  const move = (stop: AgentSliderStop, index: number, direction: -1 | 1) => {
    const to = index + direction;
    if (to < 0 || to >= slider.stops.length) return;
    const name = labelOf(stop);
    focusRequestRef.current = `move-${direction === -1 ? "up" : "down"}-${stop.id}`;
    act(
      (latest) => moveAgentSliderStop(latest, stop.id, direction),
      () => `Moved ${name} ${direction === -1 ? "up" : "down"}`,
    );
    setAnnouncement(`Moved ${name} to position ${to + 1} of ${slider.stops.length}`);
  };
  const remove = (stop: AgentSliderStop) => {
    if (atMin) return;
    const name = labelOf(stop);
    setDrafts(({ [stop.id]: _gone, ...rest }) => rest);
    focusRequestRef.current = "add";
    act(
      (latest) => removeAgentSliderStop(latest, stop.id),
      () => `Removed ${name}`,
    );
  };
  const add = () => {
    if (atMax) return;
    act(
      (latest) => {
        const next = addAgentSliderStop(latest);
        const added = next.stops[next.stops.length - 1];
        if (added && next !== latest) focusRequestRef.current = `label-${added.id}`;
        return next;
      },
      (next) => `Added ${next.stops[next.stops.length - 1]?.label ?? "a stop"}`,
    );
  };
  const setHome = (stopId: string) => {
    const stop = slider.stops.find((candidate) => candidate.id === stopId);
    if (!stop) return;
    act(
      (latest) => setAgentSliderHome(latest, stopId),
      () => `${labelOf(stop)} is now the home stop`,
    );
  };
  const assign = (stop: AgentSliderStop, choice: ModelChoice) => {
    setChooserStopId(undefined);
    act(
      (latest) =>
        assignAgentSliderStop(latest, stop.id, {
          providerId: choice.entry.providerId,
          model: choice.entry.model,
          levels: choice.levels,
          ...(choice.defaultLevel ? { defaultLevel: choice.defaultLevel } : {}),
        }),
      () => `${labelOf(stop)} now uses ${choice.entry.label}`,
    );
  };
  const setEffort = (stop: AgentSliderStop, level: GenerationThinkingLevel) => {
    act(
      (latest) => setAgentSliderStopEffort(latest, stop.id, level),
      () => `${labelOf(stop)} now runs at ${effortLabel(level) ?? level} effort`,
    );
  };

  return (
    <>
      <FieldSet
        title="Preview"
        action={
          <TemplatesMenu
            ladderReason={ladder ? undefined : "Needs a model with 3 or more effort levels"}
            onEffortLadder={applyLadder}
            onLocalToCloud={applyLocalToCloud}
          />
        }
      >
        <div className="flex flex-col gap-2 p-4">
          <AgentSlider
            views={views}
            position={position}
            homeIndex={homeIndex}
            customDetail="Choose a model for a stop to try it here"
            onSelectStop={(index) => {
              const stop = slider.stops[index];
              if (stop) setPreviewStopId(stop.id);
            }}
            onUnavailableStop={(index) => {
              const stop = slider.stops[index];
              if (stop) setChooserStopId(stop.id);
            }}
            onTypeToSearch={() => undefined}
          />
          <Text as="p" variant="small" color="tertiary">
            {shownStop
              ? `Trying ${shownStop.label}: ${[shownStop.modelLabel, shownStop.effortLabel].filter(Boolean).join(" · ")}. This preview changes no chat.`
              : "No stop can run yet. This preview changes no chat."}
          </Text>
        </div>
      </FieldSet>

      <FieldSet title="Stops">
        <RadioGroup
          aria-label="Home stop"
          value={slider.homeStopId}
          onValueChange={setHome}
          className="block"
        >
          <ol ref={listRef} className="m-0 list-none p-0" aria-label="Slider stops, left to right">
            {slider.stops.map((stop, index) => (
              <StopRow
                key={stop.id}
                stop={stop}
                index={index}
                count={slider.stops.length}
                view={views[index]}
                isHome={stop.id === slider.homeStopId}
                draft={drafts[stop.id]}
                providers={providers}
                entries={entries}
                entry={entryFor(stop)}
                chooserOpen={chooserStopId === stop.id}
                onChooserOpenChange={(open) => setChooserStopId(open ? stop.id : undefined)}
                atMin={atMin}
                removeReasonId={removeReasonId}
                onLabelChange={(value) => changeLabel(stop, value)}
                onLabelBlur={() => blurLabel(stop)}
                onMove={(direction) => move(stop, index, direction)}
                onRemove={() => remove(stop)}
                onAssign={(choice) => assign(stop, choice)}
                onEffort={(level) => setEffort(stop, level)}
              />
            ))}
          </ol>
        </RadioGroup>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 p-4">
          <Button
            ref={addRef}
            variant="filled"
            size="small"
            aria-disabled={atMax ? true : undefined}
            aria-describedby={atMax ? addReasonId : undefined}
            onClick={add}
          >
            <Plus aria-hidden="true" />
            Add stop
          </Button>
          {atMax ? (
            <Text as="span" id={addReasonId} variant="small" color="tertiary">
              {ADD_STOP_LIMIT_REASON}
            </Text>
          ) : null}
          {atMin ? (
            <Text as="span" id={removeReasonId} variant="small" color="tertiary">
              {REMOVE_STOP_LIMIT_REASON}
            </Text>
          ) : null}
        </div>
      </FieldSet>
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </>
  );
}

function TemplatesMenu({
  ladderReason,
  onEffortLadder,
  onLocalToCloud,
}: {
  ladderReason: string | undefined;
  onEffortLadder: () => void;
  onLocalToCloud: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="transparent" size="small">
          Templates
          <ChevronDown aria-hidden="true" className="size-3.5 text-tertiary" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem disabled={Boolean(ladderReason)} onSelect={onEffortLadder}>
          <span className="flex min-w-0 flex-col">
            <span>Effort ladder</span>
            <span className="text-small text-tertiary">
              {ladderReason ?? "One model, one stop per effort level"}
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onLocalToCloud}>
          <span className="flex min-w-0 flex-col">
            <span>Local to cloud</span>
            <span className="text-small text-tertiary">
              A local model, one you choose, and your cloud model
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface StopRowProps {
  stop: AgentSliderStop;
  index: number;
  count: number;
  view: AgentSliderStopView | undefined;
  isHome: boolean;
  draft: string | undefined;
  providers: Provider[];
  entries: readonly ModelEntry[];
  entry: ModelEntry | undefined;
  chooserOpen: boolean;
  onChooserOpenChange: (open: boolean) => void;
  atMin: boolean;
  removeReasonId: string;
  onLabelChange: (value: string) => void;
  onLabelBlur: () => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onAssign: (choice: ModelChoice) => void;
  onEffort: (level: GenerationThinkingLevel) => void;
}

function StopRow({
  stop,
  index,
  count,
  view,
  isHome,
  draft,
  providers,
  entries,
  entry,
  chooserOpen,
  onChooserOpenChange,
  atMin,
  removeReasonId,
  onLabelChange,
  onLabelBlur,
  onMove,
  onRemove,
  onAssign,
  onEffort,
}: StopRowProps) {
  const errorId = React.useId();
  const reasonId = React.useId();
  const value = draft ?? stop.label;
  const error = draft === undefined ? undefined : agentSliderLabelError(draft);
  const name = stop.label;
  const { levels, defaultLevel } = levelsFor(providers, entry);
  const reason = view && !view.available && view.reason !== "unassigned" ? view.reasonText : undefined;
  const first = index === 0;
  const last = index === count - 1;

  return (
    <li className="relative flex flex-col gap-2 p-4 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator">
      <div className="flex flex-wrap items-center gap-2">
        <RadioGroupItem value={stop.id} aria-label={`Home stop: ${name}`} />
        <Input
          data-focus-key={`label-${stop.id}`}
          aria-label={`Name of stop ${index + 1}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          value={value}
          onChange={(event) => onLabelChange(event.currentTarget.value)}
          onBlur={onLabelBlur}
          className="h-7 w-36 min-w-0 shrink"
        />
        {isHome ? (
          <Text as="span" variant="small" color="tertiary">
            Home
          </Text>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button
            data-focus-key={`move-up-${stop.id}`}
            variant="transparent"
            size="small"
            iconOnly
            aria-label={`Move ${name} up`}
            aria-disabled={first ? true : undefined}
            onClick={() => {
              if (!first) onMove(-1);
            }}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button
            data-focus-key={`move-down-${stop.id}`}
            variant="transparent"
            size="small"
            iconOnly
            aria-label={`Move ${name} down`}
            aria-disabled={last ? true : undefined}
            onClick={() => {
              if (!last) onMove(1);
            }}
          >
            <ArrowDown aria-hidden="true" />
          </Button>
          <Button
            variant="transparent"
            size="small"
            iconOnly
            aria-label={`Remove ${name}`}
            aria-disabled={atMin ? true : undefined}
            aria-describedby={atMin ? removeReasonId : undefined}
            title={atMin ? REMOVE_STOP_LIMIT_REASON : undefined}
            onClick={() => {
              if (!atMin) onRemove();
            }}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      </div>
      {error ? (
        <Text as="p" id={errorId} variant="small" color="status-red">
          {error}
        </Text>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 pl-6">
        <ModelChooser
          stopName={name}
          entry={entry}
          view={view}
          entries={entries}
          providers={providers}
          open={chooserOpen}
          onOpenChange={onChooserOpenChange}
          describedBy={reason ? reasonId : undefined}
          onChoose={onAssign}
        />
        {levels.length > 0 ? (
          <Select
            value={
              stop.thinkingLevel && levels.includes(stop.thinkingLevel)
                ? stop.thinkingLevel
                : stop.thinkingLevel
                  ? ""
                  : defaultLevel
            }
            onValueChange={(level) => onEffort(level as GenerationThinkingLevel)}
          >
            <SelectTrigger size="small" className="w-36" aria-label={`Effort for ${name}`}>
              <SelectValue placeholder="Choose effort" />
            </SelectTrigger>
            <SelectContent>
              {levels.map((level) => (
                <SelectItem key={level} value={level}>
                  {effortLabel(level)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      {reason ? (
        <p id={reasonId} className="flex items-center gap-1.5 pl-6 text-small text-status-warning">
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          {reason}
        </p>
      ) : null}
    </li>
  );
}

function ModelChooser({
  stopName,
  entry,
  view,
  entries,
  providers,
  open,
  onOpenChange,
  describedBy,
  onChoose,
}: {
  stopName: string;
  entry: ModelEntry | undefined;
  view: AgentSliderStopView | undefined;
  entries: readonly ModelEntry[];
  providers: Provider[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  describedBy: string | undefined;
  onChoose: (choice: ModelChoice) => void;
}) {
  const [search, setSearch] = React.useState("");
  const [previewValue, setPreviewValue] = React.useState<string>();
  const [showing, setShowing] = React.useState(0);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const listId = React.useId();
  const selectedValue = entry?.value ?? "";
  const modelLabel = entry?.label ?? view?.modelLabel;

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setSearch("");
      setShowing((count) => count + 1);
      setPreviewValue(selectedValue || entries[0]?.value);
    }
    onOpenChange(next);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="filled"
          size="small"
          className="min-w-0 max-w-full gap-1.5"
          aria-label={
            modelLabel
              ? `Model for ${stopName}: ${modelLabel}. Choose a model.`
              : `Choose a model for ${stopName}`
          }
          aria-describedby={describedBy}
        >
          {entry ? (
            <ProviderIcon
              providerId={entry.providerId}
              providerLabel={entry.providerLabel}
              modelId={entry.model}
              artwork={entry.providerArtwork}
              className="size-4 text-tertiary"
            />
          ) : null}
          <span className="min-w-0 truncate">{modelLabel ?? "Choose a model"}</span>
          <ChevronDown aria-hidden="true" className="size-3.5 text-tertiary" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="w-[min(19.75rem,calc(100vw-1.5rem))] overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => searchRef.current?.focus());
        }}
      >
        <ModelListPanel
          entries={entries}
          selectedValue={selectedValue}
          active={open}
          search={search}
          onSearchChange={setSearch}
          previewValue={previewValue}
          onPreviewChange={setPreviewValue}
          onChoose={(chosen) => {
            const { levels, defaultLevel } = levelsFor(providers, chosen);
            onChoose({ entry: chosen, levels, ...(defaultLevel ? { defaultLevel } : {}) });
          }}
          searchRef={searchRef}
          pageKey={`${showing}`}
          label={`Model for ${stopName}`}
          sectionProps={{ id: listId, "aria-label": `Model for ${stopName}` }}
        />
      </PopoverContent>
    </Popover>
  );
}
