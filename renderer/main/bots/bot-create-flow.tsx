import * as React from "react";
import { LiveGuard } from "../../components/live-guard";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BotAvatar } from "../../components/bot-avatar";
import { Callout, Dialog, Input, Text } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { queryKeys, useBotCapabilityCatalog } from "../../lib/queries";
import { BOT_LIMITS, type BotAvatarAppearance, type BotDefinition } from "../../shared/bots";
import { BOT_FULL_ACCESS_NOTICE_VERSION } from "../../shared/bot-capabilities";
import { BOT_STARTER_INSTRUCTIONS, randomBotAvatar } from "../../shared/bot-presets";
import { firstAvailableModel } from "./bot-access-draft";
import { BotLookPicker } from "./bot-character-card";
import { addBotToCache } from "./bot-identity";
import { botFullAccess, recommendedBotModelChoice } from "./bot-model-choice";

function truncate(value: string, maximum: number): string {
  const characters = Array.from(value.trim());
  return characters.length > maximum ? characters.slice(0, maximum).join("") : characters.join("");
}

export const BOT_NO_MODEL_MESSAGE = "No AI model set up yet. Set one up first so your Bot can answer.";

/**
 * New bot (plan §4.2): one field. A large preview of the Bot's look, "Name your
 * Bot", and a colour and shape that start at random. Return creates; Cancel
 * makes nothing. The Bot opens with no job yet and asks what it is for, then
 * writes its own description and first instructions. A new Bot gets Full
 * access and the recommended model. With no AI model set up, the dialog asks
 * for one first.
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
  const nameId = React.useId();
  const [name, setName] = React.useState("");
  const [avatar, setAvatar] = React.useState<BotAvatarAppearance>(() => randomBotAvatar());
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Each opening starts empty, with a fresh random look.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName("");
      setAvatar(randomBotAvatar());
      setError(null);
    }
  }
  const noModel = catalogQuery.data !== undefined && firstAvailableModel(catalogQuery.data) === undefined;
  const setUpModel = () => {
    onOpenChange(false);
    void navigate({ to: "/settings", search: { section: "providers" } });
  };

  const create = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      let catalog = await botsApi.getCapabilityCatalog();
      if (!firstAvailableModel(catalog)) {
        // A model went away while the dialog was open: ask for one first.
        void qc.invalidateQueries({ queryKey: queryKeys.botCapabilityCatalog });
        setError(BOT_NO_MODEL_MESSAGE);
        return;
      }
      // Full access is the default for a new Bot; creating it accepts the notice.
      if (catalog.notice.requiresAcknowledgement || catalog.notice.acceptedDecision !== "continue_full") {
        await botsApi.acknowledgeAccessNotice({
          version: BOT_FULL_ACCESS_NOTICE_VERSION,
          decision: "continue_full",
          confirmedForeground: true,
        });
        catalog = await botsApi.getCapabilityCatalog();
      }
      const { access, hasModel } = botFullAccess(catalog, recommendedBotModelChoice(catalog));
      const bot = await botsApi.create({
        bot: {
          name: truncate(name, BOT_LIMITS.nameChars),
          instructions: BOT_STARTER_INSTRUCTIONS,
          avatar,
        },
        access,
      });
      // Listed and opened now; the rereads and the Bot's first message (it asks
      // what it is for) follow in the background.
      addBotToCache(qc, bot);
      void qc.invalidateQueries({ queryKey: queryKeys.bots });
      void qc.invalidateQueries({ queryKey: queryKeys.botCapabilityCatalog });
      if (hasModel) void botsApi.introduce(bot.id).catch(() => false);
      onOpenChange(false);
      await onCreated(bot, { needsModel: !hasModel });
    } catch (caught) {
      setError(userFacingErrorMessage(caught, "Aiden couldn’t create this Bot."));
    } finally {
      setBusy(false);
    }
  };

  const shownName = name.trim() || "New Bot";
  return (
    // Making a Bot sets what it may reach: the user's to do, never Aiden Live's.
    <LiveGuard guard="you" wrap={false}>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="New bot"
        confirmLabel={noModel ? "Set up…" : busy ? "Creating…" : "Create"}
        confirmDisabled={noModel ? false : !name.trim()}
        busy={busy}
        allowCancelWhileBusy={false}
        onConfirm={noModel ? setUpModel : create}
        submitOnEnter
      >
        <div className="flex flex-col items-center gap-4">
          <BotAvatar avatar={avatar} name={shownName} size="preview" />
          {error ? (
            <Callout color="red" role="alert" className="w-full">
              <Text variant="small-strong" color="red">
                {error}
              </Text>
            </Callout>
          ) : null}
          {noModel ? (
            <Callout color="gray" role="status" className="w-full" data-no-model>
              <Text as="p" variant="small">
                {BOT_NO_MODEL_MESSAGE}
              </Text>
            </Callout>
          ) : null}
          <Input
            id={nameId}
            autoFocus
            aria-label="Name your Bot"
            placeholder="Name your Bot"
            className="w-full text-center"
            value={name}
            maxLength={BOT_LIMITS.nameChars}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          <BotLookPicker avatar={avatar} onChange={setAvatar} disabled={busy} />
          <Text as="p" variant="small" color="secondary" className="text-center">
            It asks what you’d like help with, then sets itself up.
          </Text>
        </div>
      </Dialog>
    </LiveGuard>
  );
}
