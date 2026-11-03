import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";
import { Field, FieldSet, Switch, Text, toast } from "../ui";
import { useAppCapabilities } from "../../lib/app-capabilities";
import { settingsApi } from "../../lib/ipc";
import { queryKeys, useSettings } from "../../lib/queries";
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
  const { computerUse } = useAppCapabilities();
  const [pending, setPending] = React.useState<boolean | null>(null);
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
