// Templates (docs/plans/bot-ux-simplification.md §4.3): the four ready-made
// Bots in a grid, each card with a faded sample of what it writes. A card
// opens its detail: Create bot (or Open, when this template's Bot exists),
// the sample, what it Adds (instructions, and a routine that stays paused
// until the person turns it on) and the apps it Works with. Nothing connects
// by itself. A detail opened from an older version of a template refuses to
// create, and asks to open it again.

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react";
import { BotAvatar } from "../../components/bot-avatar";
import { ConnectionIconTile } from "../../components/bots/connect-card";
import { LiveGuard } from "../../components/live-guard";
import { Callout, Dialog, Text } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { queryKeys } from "../../lib/queries";
import { cn } from "../../lib/ui-utils";
import { connectionSuggestionFor } from "../../shared/bot-connections";
import { BOT_PRESETS, botPresetRoutineSchedule, type BotPreset } from "../../shared/bot-presets";
import { formatBotRoutineLabel } from "../../shared/bot-routine-label";
import type { BotDefinition } from "../../shared/bots";
import { addBotToCache } from "./bot-identity";
import { useConnectionSetup } from "./use-connection-setup";

/** Outside the `bots` key: that prefix holds Bot lists, which list-wide cache updates rewrite. */
export const BOT_PRESET_BOTS_QUERY_KEY = ["bot-preset-bots"] as const;

function presetAvatar(preset: BotPreset) {
  return { version: 1 as const, shape: preset.avatar.shape, color: preset.avatar.color };
}

/** "Weekdays at 8:00 AM, paused until you turn it on". */
export function templateRoutineLine(preset: BotPreset, currentYear = new Date().getFullYear()): string | null {
  const routine = preset.suggestedRoutine;
  if (!routine) return null;
  return `${formatBotRoutineLabel(botPresetRoutineSchedule(routine.schedule), { currentYear })}, paused until you turn it on`;
}

/** The sample, fading out toward its end. */
function Sample({ preset, className }: { preset: BotPreset; className?: string }) {
  return (
    <div
      aria-label={`What ${preset.name} writes`}
      role="group"
      className={cn("rounded-card bg-well p-3 [mask-image:linear-gradient(to_bottom,black_45%,transparent)]", className)}
    >
      {preset.sample.map((line) => (
        <Text key={line} as="p" variant="small" color="secondary" className="[overflow-wrap:anywhere]">
          {line}
        </Text>
      ))}
    </div>
  );
}

/** One "Adds" row: a disclosure that shows what the template adds. */
function AddsRow({ title, children }: { title: string; children?: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const bodyId = React.useId();
  if (!children) {
    return (
      <li className="px-3 py-2.5">
        <Text as="span" variant="small">
          {title}
        </Text>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 rounded-control px-3 py-2.5 text-left outline-none hover:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        <Text as="span" variant="small">
          {title}
        </Text>
        <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0 text-tertiary transition-transform motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      {open ? (
        <div id={bodyId} className="px-3 pb-3">
          {children}
        </div>
      ) : null}
    </li>
  );
}

function TemplateDetail({
  preset,
  existing,
}: {
  preset: BotPreset;
  /** The Bot this template already made, when it still exists. */
  existing: boolean;
}) {
  const setup = useConnectionSetup(() => undefined);
  const routine = templateRoutineLine(preset);
  const apps = preset.suggestedConnections.flatMap((pluginId) => {
    const suggestion = connectionSuggestionFor(pluginId);
    return suggestion ? [suggestion] : [];
  });
  return (
    <div className="flex flex-col gap-4" data-template-detail={preset.id}>
      <div className="flex items-center gap-3">
        <BotAvatar avatar={presetAvatar(preset)} name={preset.name} size="large" />
        <div className="min-w-0">
          <Text as="h3" variant="strong">
            {preset.name}
          </Text>
          <Text as="p" variant="small" color="secondary">
            {existing ? "You already have this Bot." : preset.subtitle}
          </Text>
        </div>
      </div>
      <Sample preset={preset} />
      <section aria-label="Adds" className="flex flex-col gap-1">
        <Text as="h4" variant="small-strong" color="secondary">
          Adds
        </Text>
        <ul className="flex flex-col rounded-card bg-well">
          <AddsRow title="Instructions">
            <Text as="p" variant="small" color="secondary" className="whitespace-pre-wrap">
              {preset.instructions}
            </Text>
          </AddsRow>
          {routine && preset.suggestedRoutine ? (
            <AddsRow title={routine}>
              <Text as="p" variant="small" color="secondary">
                {`${preset.suggestedRoutine.name}: ${preset.suggestedRoutine.prompt}`}
              </Text>
            </AddsRow>
          ) : null}
        </ul>
      </section>
      {apps.length > 0 ? (
        <section aria-label="Works with" className="flex flex-col gap-1">
          <Text as="h4" variant="small-strong" color="secondary">
            Works with
          </Text>
          <ul className="flex flex-col gap-1">
            {apps.map((app) => {
              const connected = setup.isConnected(app.pluginId);
              return (
                <li key={app.pluginId} className="flex items-center gap-2 py-1" data-works-with={app.pluginId}>
                  <ConnectionIconTile suggestion={app} size="small" />
                  <Text as="span" variant="small" className="flex-1">
                    {app.name}
                  </Text>
                  {connected ? (
                    <Text as="span" variant="small" color="secondary" className="inline-flex items-center gap-1">
                      <Check aria-hidden="true" className="size-3.5 text-status-green" />
                      Connected
                    </Text>
                  ) : (
                    <Text as="span" variant="small" color="tertiary">
                      Not connected
                    </Text>
                  )}
                </li>
              );
            })}
          </ul>
          <Text as="p" variant="small" color="tertiary">
            Nothing connects on its own. Connect apps in Settings when you’re ready.
          </Text>
        </section>
      ) : null}
    </div>
  );
}

/**
 * The Templates dialog. `presets` is the list as shown (tests can pass an
 * older version of one to check that a stale preview refuses to create).
 */
export function BotTemplatesDialog({
  open,
  onOpenChange,
  onOpenChat,
  presets = BOT_PRESETS,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onOpenChat(bot: BotDefinition): void;
  presets?: readonly BotPreset[];
}) {
  const qc = useQueryClient();
  const [chosen, setChosen] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setChosen(null);
      setError(null);
    }
  }
  const made = useQuery({
    queryKey: BOT_PRESET_BOTS_QUERY_KEY,
    queryFn: () => botsApi.presetBots(),
    enabled: open,
  });
  const preset = presets.find((candidate) => candidate.id === chosen) ?? null;
  const existingId = preset ? made.data?.[preset.id] : undefined;

  const create = async () => {
    if (!preset || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { bot } = await botsApi.createFromPreset({ presetId: preset.id, version: preset.version });
      addBotToCache(qc, bot);
      void qc.invalidateQueries({ queryKey: queryKeys.bots });
      void qc.invalidateQueries({ queryKey: BOT_PRESET_BOTS_QUERY_KEY });
      onOpenChange(false);
      onOpenChat(bot);
    } catch (error) {
      setError(userFacingErrorMessage(error, `Aiden couldn’t create ${preset.name}.`));
    } finally {
      setBusy(false);
    }
  };
  const openExisting = async () => {
    if (!existingId) return;
    const bot = await botsApi.get(existingId).catch(() => null);
    if (!bot) {
      void made.refetch();
      return;
    }
    onOpenChange(false);
    onOpenChat(bot);
  };

  return (
    <LiveGuard guard="you" wrap={false}>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        size={preset ? undefined : "large"}
        title={preset ? preset.name : "Templates"}
        description={preset ? undefined : "Ready-made Bots. Each one starts with its own instructions, and any routine stays paused until you turn it on."}
        {...(preset
          ? {
              confirmLabel: existingId ? "Open" : busy ? "Creating…" : "Create bot",
              onConfirm: existingId ? openExisting : create,
              cancelLabel: "Back",
              cancelKeepsOpen: true,
              onCancel: () => {
                setChosen(null);
                setError(null);
              },
            }
          : { confirmHidden: true })}
        busy={busy}
        allowCancelWhileBusy={false}
      >
        {preset ? (
          <div className="flex flex-col gap-3">
            {error ? (
              <Callout color="red" role="alert">
                <Text variant="small-strong" color="red">
                  {error}
                </Text>
              </Callout>
            ) : null}
            <TemplateDetail preset={preset} existing={existingId !== undefined} />
          </div>
        ) : (
          <ul aria-label="Templates" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {presets.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  aria-label={`${candidate.name}: ${candidate.subtitle}`}
                  onClick={() => setChosen(candidate.id)}
                  className="flex h-full w-full flex-col gap-3 rounded-card bg-well p-4 text-left outline-none transition-colors hover:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none"
                >
                  <div className="flex items-center gap-3">
                    <BotAvatar avatar={presetAvatar(candidate)} name={candidate.name} size="medium" />
                    <div className="min-w-0">
                      <Text as="span" variant="strong" className="block truncate">
                        {candidate.name}
                      </Text>
                      <Text as="span" variant="small" color="secondary" className="block">
                        {candidate.subtitle}
                      </Text>
                    </div>
                  </div>
                  <Sample preset={candidate} className="bg-control" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </LiveGuard>
  );
}
