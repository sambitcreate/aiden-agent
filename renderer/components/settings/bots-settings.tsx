import { botMessagingEnabled } from "../../shared/bot-messages";
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";
import { Button, Callout, Field, FieldSet, Switch, Text, toast } from "../ui";
import { BotAllowedList } from "../bots/bot-allowed-list";
import { useBotAllowed, useBotAllowedRemoval } from "../../main/bots/use-bot-allowed";
import { useAppCapabilities } from "../../lib/app-capabilities";
import { settingsApi } from "../../lib/ipc";
import { queryKeys, useBots, useSettings } from "../../lib/queries";
import type { AppSettings } from "../../lib/types";
import { botRoutinesGoAhead } from "../../shared/bot-rules";

function Always() {
  return (
    <span className="flex shrink-0 items-center gap-1.5 justify-self-end text-small text-secondary">
      <LockKeyhole aria-hidden="true" className="size-3.5" />
      Always
    </span>
  );
}

/** Settings → Bots: how every Bot handles a step that needs the person's OK. */
export function BotsSettings() {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const bots = useBots();
  const allowed = useBotAllowed();
  const removals = useBotAllowedRemoval();
  const grouped = new Map<string, NonNullable<typeof allowed.data>>();
  for (const entry of allowed.data ?? []) {
    const rows = grouped.get(entry.botId) ?? [];
    rows.push(entry);
    grouped.set(entry.botId, rows);
  }
  const { computerUse } = useAppCapabilities();
  const [pending, setPending] = React.useState<boolean | null>(null);
  const [messagingPending, setMessagingPending] = React.useState<boolean | null>(null);
  const changeMessaging = async (next: boolean) => {
    setMessagingPending(next);
    try { queryClient.setQueryData<AppSettings>(queryKeys.settings, await settingsApi.set({botMessaging: next})); }
    catch { toast.error("Could not change Bot messaging."); }
    finally { setMessagingPending(null); }
  };
  const goAhead = pending ?? botRoutinesGoAhead(settings.data);

  // Instant: the switch moves at once and rolls back if it can't be saved.
  const change = async (next: boolean) => {
    setPending(next);
    try {
      const saved = await settingsApi.set({ botRoutinesGoAhead: next });
      queryClient.setQueryData<AppSettings>(queryKeys.settings, saved);
    } catch {
      toast.error("Couldn’t change how routines handle these steps.");
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <FieldSet title="Other Bots">
        <Field label="Bots can message each other" description="Bots can send each other messages and bring the answer back to their chat.">
          <Switch aria-label="Bots can message each other" checked={messagingPending ?? botMessagingEnabled(settings.data)} disabled={messagingPending !== null || settings.isLoading} onCheckedChange={next => void changeMessaging(next)} />
        </Field>
      </FieldSet>
      <FieldSet title="Routines">
        <Field
          label="Go ahead without asking"
          description="When a Bot runs a routine on its own, steps set to Ask first and changes in connected apps go ahead without waiting for your OK. In chats, Bots still ask."
        >
          <Switch
            aria-label="Let routines go ahead without asking"
            checked={goAhead}
            disabled={pending !== null || settings.isLoading}
            onCheckedChange={(next) => void change(next)}
          />
        </Field>
      </FieldSet>
      <FieldSet title="Allowed without asking">
        {allowed.data === undefined && allowed.isPending ? <Field><Text role="status" variant="small" color="secondary">Loading allowed actions…</Text></Field> : null}
        {allowed.data?.length === 0 ? <Field description="No Bot does anything without asking yet." /> : null}
        {[...grouped].map(([botId, entries]) => (
          <Field key={botId} label={bots.data?.find((bot) => bot.id === botId)?.name ?? "Bot"} orientation="vertical">
            <BotAllowedList entries={entries} removing={removals.removing?.botId === botId ? removals.removing.entryId : undefined} onRemove={(entry) => void removals.remove(entry)} />
          </Field>
        ))}
        {allowed.isError ? <Field><Callout color="red" role="alert">Aiden couldn’t load these allowances.<Button size="small" variant="filled" onClick={() => void allowed.refetch()}>Try again</Button></Callout></Field> : null}
        {removals.error ? <Field><Callout color="red" role="alert">{removals.error}</Callout></Field> : null}
      </FieldSet>
      <FieldSet title="Always comes to you">
        <Field label="Passwords, 2FA codes and money" description="Bots hand these to you, in chats and routines.">
          <Always />
        </Field>
        <Field label="Steps a Bot’s rules hand off to you" description="Set a rule to Hand off to me on a Bot’s profile to keep that step yours.">
          <Always />
        </Field>
        {computerUse ? (
          <Field label="Using your Mac with Computer Use" description="A Bot asks before each action on your own screen.">
            <Always />
          </Field>
        ) : null}
      </FieldSet>
      <Text as="p" variant="small" color="secondary" className="text-pretty">
        With this off, a routine skips an Ask first step and the Bot tells you in its reply, and a change in a connected app waits under Needs you until you answer.
      </Text>
    </>
  );
}
