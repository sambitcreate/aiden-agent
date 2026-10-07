import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Callout, Dialog, Input, Text, Textarea } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { queryKeys } from "../../lib/queries";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  BOT_LIMITS,
  DEFAULT_BOT_AVATAR,
  type BotAvatarAppearance,
  type BotDefinition,
} from "../../shared/bots";
import {
  BOT_FULL_ACCESS_NOTICE_VERSION,
  type BotAccessUpdate,
  type BotCapabilityCatalog,
} from "../../shared/bot-capabilities";
import { firstAvailableModel, firstAvailableVisionModel } from "./bot-access-draft";
import { ConnectionChips, toggleConnection } from "../../components/bots/connection-chips";
import { rankConnections } from "../../shared/bot-connections";
import { useConnectionSetup } from "./use-connection-setup";

/** A stable, varied starting character so new Bots don't all look alike. */
export function botCharacterForName(name: string): BotAvatarAppearance {
  let hash = 0;
  for (const character of name.trim().toLocaleLowerCase()) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  return {
    ...DEFAULT_BOT_AVATAR,
    color: BOT_AVATAR_COLORS[hash % BOT_AVATAR_COLORS.length]!,
    shape: BOT_AVATAR_SHAPES[Math.floor(hash / BOT_AVATAR_COLORS.length) % BOT_AVATAR_SHAPES.length]!,
  };
}

export const BOT_DEFAULT_INSTRUCTIONS = "Be a friendly, helpful assistant.";

/** Instructions seeded from the "What should it help with?" answer. */
export function botInstructionsFromHelp(help: string): string {
  const trimmed = help.trim();
  return trimmed ? `Help me with: ${trimmed}` : BOT_DEFAULT_INSTRUCTIONS;
}

function truncate(value: string, maximum: number): string {
  const characters = Array.from(value.trim());
  return characters.length > maximum ? characters.slice(0, maximum).join("") : characters.join("");
}

/**
 * Full access with the recommended model: the first available model, plus an
 * image model when that one reads text only. With no model at all the Bot is
 * still created and asks for one when opened.
 */
export function recommendedFullAccess(catalog: BotCapabilityCatalog): {
  access: BotAccessUpdate;
  hasModel: boolean;
} {
  const model = firstAvailableModel(catalog);
  const supportsImages = model
    ? catalog.providers
        .find((provider) => provider.id === model.providerId)
        ?.models.find((candidate) => candidate.id === model.modelId)?.supportsImages === true
    : false;
  const vision = model && !supportsImages
    ? firstAvailableVisionModel(catalog, model.providerId)
    : undefined;
  return {
    hasModel: Boolean(model),
    access: {
      accessMode: "full",
      catalogRevision: catalog.revision,
      confirmedForeground: true,
      ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
      ...(vision ? { visionModel: vision } : {}),
    },
  };
}

/**
 * Two short steps: name and "What should it help with?", then optional
 * connection chips. Everything else has a default; Skip is one tap.
 */
export function BotCreateFlow({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated(bot: BotDefinition, options: { needsModel: boolean }): void | Promise<void>;
}) {
  const qc = useQueryClient();
  const [step, setStep] = React.useState<1 | 2>(1);
  const [name, setName] = React.useState("");
  const [help, setHelp] = React.useState("");
  const [connected, setConnected] = React.useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const suggestions = React.useMemo(() => rankConnections(help), [help]);
  const pendingPlugin = React.useRef<string | null>(null);
  const connectionSetup = useConnectionSetup(() => {
    const pluginId = pendingPlugin.current;
    pendingPlugin.current = null;
    if (pluginId) setConnected((current) => toggleConnection(current, pluginId));
  });
  const openSetup = connectionSetup.open;
  React.useEffect(() => {
    if (!open) return;
    setStep(1);
    setName("");
    setHelp("");
    setConnected(new Set());
    setError(null);
  }, [open]);

  const create = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      let catalog = await botsApi.getCapabilityCatalog();
      // Full access is stated in this dialog; creating the Bot accepts it.
      if (catalog.notice.requiresAcknowledgement || catalog.notice.acceptedDecision !== "continue_full") {
        await botsApi.acknowledgeAccessNotice({
          version: BOT_FULL_ACCESS_NOTICE_VERSION,
          decision: "continue_full",
          confirmedForeground: true,
        });
        catalog = await botsApi.getCapabilityCatalog();
      }
      const { access, hasModel } = recommendedFullAccess(catalog);
      const subtitle = truncate(help, BOT_LIMITS.descriptionChars);
      const bot = await botsApi.create({
        bot: {
          name: truncate(name, BOT_LIMITS.nameChars),
          ...(subtitle ? { description: subtitle } : {}),
          instructions: truncate(botInstructionsFromHelp(help), BOT_LIMITS.instructionsChars),
          avatar: botCharacterForName(name),
        },
        access,
      });
      qc.setQueryData(queryKeys.bot(bot.id), bot);
      await qc.invalidateQueries({ queryKey: queryKeys.bots });
      await qc.invalidateQueries({ queryKey: queryKeys.botCapabilityCatalog });
      // The one-time self-intro: only for a Bot made here, and only when it has a model.
      if (hasModel) await botsApi.introduce(bot.id).catch(() => false);
      onOpenChange(false);
      await onCreated(bot, { needsModel: !hasModel });
    } catch (caught) {
      setError(userFacingErrorMessage(caught, "Aiden couldn’t create this Bot."));
    } finally {
      setBusy(false);
    }
  };

  const toggleChip = (pluginId: string) => {
    if (connected.has(pluginId)) {
      setConnected((current) => toggleConnection(current, pluginId));
      return;
    }
    pendingPlugin.current = pluginId;
    if (!openSetup(pluginId)) pendingPlugin.current = null;
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={step === 1 ? "New Bot" : "Connections"}
        description={step === 2 ? `Optional. Connect what ${name.trim() || "this Bot"} can use.` : undefined}
        confirmLabel={step === 1 ? "Next" : "Create"}
        confirmDisabled={step === 1 ? !name.trim() : busy}
        busy={busy}
        cancelLabel={step === 2 ? "Back" : undefined}
        onCancel={step === 2 ? () => setStep(1) : undefined}
        allowCancelWhileBusy={false}
        onConfirm={step === 1 ? () => setStep(2) : create}
        submitOnEnter
      >
        {step === 1 ? (
          <div className="space-y-4">
            {error ? (
              <Callout color="red" role="alert">
                {error}
              </Callout>
            ) : null}
            <label className="block">
              <Text variant="small-strong">Name</Text>
              <Input
                autoFocus
                className="mt-1.5"
                value={name}
                maxLength={BOT_LIMITS.nameChars}
                placeholder="Meal Planner"
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="block">
              <Text variant="small-strong">What should it help with?</Text>
              <Textarea
                className="mt-1.5 min-h-20 resize-none"
                value={help}
                maxLength={BOT_LIMITS.descriptionChars}
                placeholder="Plan my meals and grocery list every week"
                disabled={busy}
                onChange={(event) => setHelp(event.target.value)}
              />
            </label>
            <Text as="p" variant="small" color="tertiary">
              It can use everything Aiden can on this Mac. You can change this later in Advanced.
            </Text>
          </div>
        ) : (
          <div className="space-y-4">
            {error ? (
              <Callout color="red" role="alert">
                {error}
              </Callout>
            ) : null}
            <ConnectionChips
              suggestions={suggestions}
              selected={connected}
              onToggle={toggleChip}
              onSkip={() => void create()}
            />
            <Text as="p" variant="small" color="tertiary">
              Each connection is optional. You can add more later in Advanced.
            </Text>
          </div>
        )}
      </Dialog>
      {connectionSetup.dialog}
    </>
  );
}
