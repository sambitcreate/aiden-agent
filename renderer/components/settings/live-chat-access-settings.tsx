import * as React from "react";
import { useSettings } from "../../lib/queries";
import { useSettingsSave } from "../../lib/use-settings-save";
import { aidenLivePreferences } from "../../shared/aiden-live-settings";
import { Field, FieldSet, Switch } from "../ui";

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
  const { saving, save } = useSettingsSave({ guard: "state" });
  const preferences = aidenLivePreferences(settings.data);
  return (
    <LiveChatAccessSwitch
      checked={preferences.chatAccess}
      disabled={settings.isLoading || saving}
      onChange={(checked) =>
        void save({ aidenLiveChatAccess: checked }, "Couldn’t update Aiden Live settings.")
      }
    />
  );
}
