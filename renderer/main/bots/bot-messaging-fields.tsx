import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Field, FieldSet, Switch, toast } from "../../components/ui";
import { useSettings } from "../../lib/queries";
import { botMessagingEnabled } from "../../shared/bot-messages";
import type { BotDefinition } from "../../shared/bots";
import { updateBotIdentity } from "./bot-identity";
export function BotMessagingFields({ bot }: { bot: BotDefinition }) {
  const qc = useQueryClient();
  const settings = useSettings();
  const [saving, setSaving] = React.useState<string | null>(null);
  const enabled = botMessagingEnabled(settings.data);
  const change = async (key: "acceptsBotMessages" | "messagesOtherBots", next: boolean) => {
    setSaving(key);
    try {
      await updateBotIdentity(qc, bot.id, { [key]: next });
    } catch {
      toast.error("Could not save Bot messaging.");
    } finally {
      setSaving(null);
    }
  };
  return (
    <FieldSet title="Other Bots">
      {(["acceptsBotMessages", "messagesOtherBots"] as const).map((key) => {
        const label =
          key === "acceptsBotMessages" ? `Other Bots can message ${bot.name}` : `${bot.name} can message other Bots`;
        return (
          <Field key={key} label={label} description={!enabled ? "Turned off in Settings → Bots & Approvals" : undefined}>
            <Switch
              aria-label={label}
              checked={bot[key] !== false}
              disabled={!enabled || settings.isLoading || saving !== null}
              onCheckedChange={(next) => void change(key, next)}
            />
          </Field>
        );
      })}
    </FieldSet>
  );
}
