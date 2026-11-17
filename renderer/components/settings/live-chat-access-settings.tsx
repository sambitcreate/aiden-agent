import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { settingsApi } from "../../lib/ipc";
import { queryKeys, useSettings } from "../../lib/queries";
import type { AppSettings } from "../../lib/types";
import { aidenLivePreferences } from "../../shared/aiden-live-settings";
import { Field, FieldSet, Switch, toast } from "../ui";

/** The "Chats" group: one switch for Live's chat tools. */
export function LiveChatAccessSwitch({
  checked,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}): React.ReactElement {
  return (
    <FieldSet title="Chats">
      <Field
        label="Let Live use the open chat"
        description="Live can read the chat on screen, send to it, stop it, open other chats and start new ones. Messages it sends show “By voice”."
      >
        <Switch
          aria-label="Let Live use the open chat"
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
        />
      </Field>
    </FieldSet>
  );
}

/** Settings → Aiden Live → Chats, saved straight to AppSettings. */
export function LiveChatAccessSettings(): React.ReactElement {
  const settings = useSettings();
  const queryClient = useQueryClient();
  const [saving, setSaving] = React.useState(false);
  const preferences = aidenLivePreferences(settings.data);
  const save = async (checked: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await settingsApi.set({ aidenLiveChatAccess: checked });
      queryClient.setQueryData<AppSettings>(queryKeys.settings, saved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t update Aiden Live settings.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <LiveChatAccessSwitch
      checked={preferences.chatAccess}
      disabled={settings.isLoading || saving}
      onChange={(checked) => void save(checked)}
    />
  );
}
