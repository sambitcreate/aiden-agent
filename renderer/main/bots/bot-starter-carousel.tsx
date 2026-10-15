import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { BotAvatar } from "../../components/bot-avatar";
import { Button, Text, toast } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { queryKeys } from "../../lib/queries";
import { BOT_PRESETS, type BotPreset } from "../../shared/bot-presets";
import { DEFAULT_BOT_AVATAR, type BotDefinition } from "../../shared/bots";

/**
 * "Meet your first Bot": the starter Bots as a swipeable carousel. Start chat is
 * idempotent per preset, so tapping it twice opens the same Bot. The cards'
 * buttons are quiet; Create my own is the one accent action when offered.
 */
export function BotStarterCarousel({
  onCreateOwn,
  onOpenChat,
  presets = BOT_PRESETS,
}: {
  /** Omitted where the create flow is not offered (onboarding). */
  onCreateOwn?(): void;
  onOpenChat(bot: BotDefinition): void;
  presets?: readonly BotPreset[];
}) {
  const qc = useQueryClient();
  const headingId = React.useId();
  const [pending, setPending] = React.useState<string | null>(null);

  const start = async (preset: BotPreset) => {
    if (pending) return;
    setPending(preset.id);
    try {
      const { bot } = await botsApi.createFromPreset({ presetId: preset.id });
      qc.setQueryData(queryKeys.bot(bot.id), bot);
      await qc.invalidateQueries({ queryKey: queryKeys.bots });
      onOpenChat(bot);
    } catch (error) {
      toast.error(userFacingErrorMessage(error, `Aiden couldn’t start ${preset.name}.`));
    } finally {
      setPending(null);
    }
  };

  return (
    <section aria-labelledby={headingId} className="space-y-5">
      <div className="space-y-1">
        <Text as="h2" variant="heading1" id={headingId}>
          Meet your first Bot
        </Text>
        <Text as="p" color="secondary">
          Start with a helper that’s ready to go, or make your own.
        </Text>
      </div>
      <ul aria-label="Starter Bots" className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-3 pt-1">
        {presets.map((preset) => (
          <li
            key={preset.id}
            className="flex w-56 shrink-0 snap-start flex-col gap-3 rounded-card bg-well p-4 shadow-control"
          >
            <BotAvatar
              avatar={{ ...DEFAULT_BOT_AVATAR, shape: preset.avatar.shape, color: preset.avatar.color }}
              name={preset.name}
              size="medium"
            />
            <div className="min-w-0 flex-1">
              <Text as="h3" variant="strong" className="truncate">
                {preset.name}
              </Text>
              <Text as="p" variant="small" color="secondary" className="mt-0.5">
                {preset.subtitle}
              </Text>
            </div>
            <Button
              variant="filled"
              size="medium"
              disabled={pending !== null}
              aria-busy={pending === preset.id || undefined}
              onClick={() => void start(preset)}
            >
              {pending === preset.id ? "Starting…" : "Start chat"}
            </Button>
          </li>
        ))}
      </ul>
      {onCreateOwn ? (
        <div>
          <Button variant="accent" onClick={onCreateOwn}>
            <Plus /> Create my own
          </Button>
        </div>
      ) : null}
    </section>
  );
}
