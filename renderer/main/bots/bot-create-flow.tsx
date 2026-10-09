import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Callout, Dialog, FieldLabel, Input, Text, Textarea } from "../../components/ui";
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
import { ConnectionChips } from "../../components/bots/connection-chips";
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
 * Two short steps: name and "What should it help with?", then optional app
 * connections. A new Bot gets Full access, which covers every app connected on
 * this Mac, so the chips only start a connection's setup; nothing is selected
 * per Bot. Back returns to the first step with the draft kept.
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
  const nameId = React.useId();
  const helpId = React.useId();
  const [step, setStep] = React.useState<1 | 2>(1);
  const [name, setName] = React.useState("");
  const [help, setHelp] = React.useState("");
  // Apps set up from this dialog. Apps reached through Composio aren't visible
  // to Aiden afterwards, so the chip remembers the finished setup.
  const [justConnected, setJustConnected] = React.useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const suggestions = React.useMemo(() => rankConnections(help), [help]);
  const pendingPlugin = React.useRef<string | null>(null);
  const connectionSetup = useConnectionSetup(() => {
    const pluginId = pendingPlugin.current;
    pendingPlugin.current = null;
    if (pluginId) setJustConnected((current) => new Set(current).add(pluginId));
  });
  const { open: openSetup, isConnected } = connectionSetup;
  const connected = React.useMemo(
    () =>
      new Set(
        suggestions
          .map((suggestion) => suggestion.pluginId)
          .filter((pluginId) => justConnected.has(pluginId) || isConnected(pluginId)),
      ),
    [isConnected, justConnected, suggestions],
  );
  React.useEffect(() => {
    if (!open) return;
    setStep(1);
    setName("");
    setHelp("");
    setJustConnected(new Set());
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

  const connect = (pluginId: string) => {
    pendingPlugin.current = pluginId;
    if (!openSetup(pluginId)) pendingPlugin.current = null;
  };

  const displayName = name.trim() || "This Bot";
  const errorCallout = error ? (
    <Callout color="red" role="alert">
      <Text variant="small-strong" color="red">
        {error}
      </Text>
    </Callout>
  ) : null;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={step === 1 ? "New Bot" : "Connections"}
        description={
          step === 2
            ? `Optional. ${displayName} can use any app you connect on this Mac.`
            : undefined
        }
        confirmLabel={step === 1 ? "Next" : "Create"}
        confirmDisabled={step === 1 ? !name.trim() : busy}
        busy={busy}
        {...(step === 2
          ? { cancelLabel: "Back", cancelKeepsOpen: true, onCancel: () => setStep(1) }
          : {})}
        allowCancelWhileBusy={false}
        onConfirm={step === 1 ? () => setStep(2) : create}
        submitOnEnter
      >
        {step === 1 ? (
          <div className="space-y-4">
            {errorCallout}
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor={nameId} className="text-small-strong">
                Name
              </FieldLabel>
              <Input
                id={nameId}
                autoFocus
                value={name}
                maxLength={BOT_LIMITS.nameChars}
                placeholder="Meal Planner"
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor={helpId} className="text-small-strong">
                What should it help with?
              </FieldLabel>
              <Textarea
                id={helpId}
                className="min-h-20"
                value={help}
                maxLength={BOT_LIMITS.descriptionChars}
                placeholder="Plan my meals and grocery list every week"
                disabled={busy}
                onChange={(event) => setHelp(event.target.value)}
              />
            </div>
            <Text as="p" variant="small" color="secondary">
              It can use everything Aiden can on this Mac. You can change this later in Advanced.
            </Text>
          </div>
        ) : (
          <div className="space-y-4">
            {errorCallout}
            <ConnectionChips
              suggestions={suggestions}
              connected={connected}
              onConnect={connect}
              disabled={busy}
            />
            <Text as="p" variant="small" color="secondary">
              Skip this if you like. You can connect more apps any time in Settings.
            </Text>
          </div>
        )}
      </Dialog>
      {connectionSetup.dialog}
    </>
  );
}
