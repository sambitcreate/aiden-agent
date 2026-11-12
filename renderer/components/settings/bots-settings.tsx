import { botMessagingEnabled } from "../../shared/bot-messages";
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { Button, Field, FieldSet, Switch, toast } from "../ui";
import { settingsApi } from "../../lib/ipc";
import { queryKeys, useSettings } from "../../lib/queries";
import { settingsLocation } from "../../lib/settings-section";
import type { AppSettings } from "../../lib/types";

/**
 * Settings → Bots & Approvals → Bots: Bot messaging. What a Bot may do
 * without asking lives with every other rule in Approvals.
 */
export function BotsSettings() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const settings = useSettings();
  const [messagingPending, setMessagingPending] = React.useState<boolean | null>(null);
  const changeMessaging = async (next: boolean) => {
    setMessagingPending(next);
    try { queryClient.setQueryData<AppSettings>(queryKeys.settings, await settingsApi.set({botMessaging: next})); }
    catch { toast.error("Could not change Bot messaging."); }
    finally { setMessagingPending(null); }
  };
  return (
    <>
      <FieldSet title="Other Bots">
        <Field label="Bots can message each other" description="Bots can send each other messages and bring the answer back to their chat.">
          <Switch aria-label="Bots can message each other" checked={messagingPending ?? botMessagingEnabled(settings.data)} disabled={messagingPending !== null || settings.isLoading} onCheckedChange={next => void changeMessaging(next)} />
        </Field>
      </FieldSet>
      <FieldSet title="What Bots may do">
        <Field label="Rules for every Bot" description="Always allow, Always ask and Blocked, for every Bot and workspace on this Mac.">
          <div className="flex justify-end">
            <Button size="small" variant="transparent" onClick={() => void navigate({ ...settingsLocation("approvals"), replace: true })}>
              Open Approvals
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          </div>
        </Field>
      </FieldSet>
    </>
  );
}
