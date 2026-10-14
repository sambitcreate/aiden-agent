import * as React from "react";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button, Callout, Dialog, FieldLabel, Input, Text, Textarea } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { queryKeys, useBotCapabilityCatalog } from "../../lib/queries";
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
import { firstAvailableModel } from "./bot-access-draft";
import {
  botFullAccess,
  botModelUsable,
  chooseBotModel,
  chooseBotVisionModel,
  findBotModel,
  recommendedBotModelChoice,
  type BotModelChoice,
} from "./bot-model-choice";
import { BotModelPicker } from "./bot-model-picker";
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
  return botFullAccess(catalog, recommendedBotModelChoice(catalog));
}

export const BOT_MODEL_GONE_MESSAGE = "That model isn’t available any more. Choose another one.";

/** Step 1's AI model: the recommended model by default, changeable before Create. */
function CreateModelField({
  catalog,
  choice,
  disabled,
  onChange,
  onSetUp,
}: {
  catalog: UseQueryResult<BotCapabilityCatalog>;
  choice: BotModelChoice;
  disabled: boolean;
  onChange(next: BotModelChoice): void;
  onSetUp(): void;
}) {
  const title = (
    <Text as="span" variant="small-strong">
      AI model
    </Text>
  );
  if (catalog.isLoading) {
    return (
      <div className="flex flex-col gap-1.5">
        {title}
        <span role="status" aria-label="Loading models" className="block h-8 rounded-control bg-control motion-safe:animate-pulse" />
      </div>
    );
  }
  if (catalog.isError || !catalog.data) {
    return (
      <div className="flex flex-col gap-1.5">
        {title}
        <div className="flex items-center gap-2">
          <Text as="p" variant="small" color="secondary" className="flex-1">
            Aiden couldn’t load your models.
          </Text>
          <Button size="small" variant="filled" onClick={() => void catalog.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  const data = catalog.data;
  const recommended = firstAvailableModel(data);
  if (!recommended) {
    return (
      <div className="flex flex-col gap-1.5">
        {title}
        <div className="flex items-center gap-2">
          <Text as="p" variant="small" color="secondary" className="flex-1">
            No AI model set up yet. You can still create it; it asks for one when you open it.
          </Text>
          <Button size="small" variant="filled" onClick={onSetUp}>
            Set up…
          </Button>
        </div>
      </div>
    );
  }
  const primary = findBotModel(data, choice.providerId, choice.modelId);
  const needsPhotoModel = primary !== undefined && primary.model.supportsImages !== true;
  return (
    <div className="flex flex-col gap-1.5">
      {title}
      <BotModelPicker
        catalog={data}
        label="AI model"
        providerId={choice.providerId}
        modelId={choice.modelId}
        recommended={recommended}
        disabled={disabled}
        onSelect={(providerId, modelId) => onChange(chooseBotModel(data, choice, providerId, modelId))}
      />
      {needsPhotoModel ? (
        choice.visionProviderId && choice.visionModelId ? (
          <>
            <Text as="span" variant="small-strong" className="mt-2">
              For photos
            </Text>
            <BotModelPicker
              catalog={data}
              label="Model for photos"
              imagesOnly
              providerId={choice.visionProviderId}
              modelId={choice.visionModelId}
              disabled={disabled}
              onSelect={(providerId, modelId) => onChange(chooseBotVisionModel(data, choice, providerId, modelId))}
            />
            <Text as="p" variant="small" color="secondary">
              {primary.model.label} reads text only, so photos and screenshots go here.
            </Text>
          </>
        ) : (
          <Text as="p" variant="small" color="secondary">
            {primary.model.label} reads text only, and no model that reads images is set up.
          </Text>
        )
      ) : null}
    </div>
  );
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
  const navigate = useNavigate();
  const catalogQuery = useBotCapabilityCatalog(open);
  // null = the recommended model, worked out from the latest catalog.
  const [choice, setChoice] = React.useState<BotModelChoice | null>(null);
  const shownChoice: BotModelChoice =
    choice ?? (catalogQuery.data ? recommendedBotModelChoice(catalogQuery.data) : {});
  const openProviders = () => {
    onOpenChange(false);
    void navigate({ to: "/settings", search: { section: "providers" } });
  };
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
    setChoice(null);
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
      let picked: BotModelChoice;
      if (choice) {
        const found = findBotModel(catalog, choice.providerId, choice.modelId);
        if (!found || !botModelUsable(found)) {
          setError(BOT_MODEL_GONE_MESSAGE);
          setStep(1);
          void qc.invalidateQueries({ queryKey: queryKeys.botCapabilityCatalog });
          return;
        }
        // Re-checks the photo model against the fresh catalog too.
        picked = chooseBotModel(catalog, choice, found.provider.id, found.model.id);
      } else {
        picked = recommendedBotModelChoice(catalog);
      }
      const { access, hasModel } = botFullAccess(catalog, picked);
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
            <CreateModelField
              catalog={catalogQuery}
              choice={shownChoice}
              disabled={busy}
              onChange={setChoice}
              onSetUp={openProviders}
            />
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
