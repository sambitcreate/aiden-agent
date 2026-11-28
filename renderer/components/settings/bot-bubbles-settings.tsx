// Settings → Bots → Bubbles (docs/bot-bubbles.md). Follows
// docs/settings-design-system.md: one FieldSet, Field rows, trailing Switches.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Field, FieldSet, Switch, toast } from "../ui";
import { settingsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { queryKeys, useSettings } from "../../lib/queries";
import { useBotBubbles } from "../../lib/bot-bubbles-api";

type BotBubblesPatch = { botBubblesEnabled?: boolean; botBubblesFloatOverApps?: boolean };

export function BotBubblesSettings() {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const bubbles = useBotBubbles();
  const [saving, setSaving] = React.useState(false);
  const saved = settings.data as BotBubblesPatch | undefined;
  // Both are on unless the person turned them off.
  const enabled = saved?.botBubblesEnabled !== false;
  const floatOverApps = saved?.botBubblesFloatOverApps !== false;
  const disabled = settings.isLoading || saving;

  const save = async (patch: BotBubblesPatch) => {
    setSaving(true);
    try {
      const next = await settingsApi.set(patch);
      queryClient.setQueryData(queryKeys.settings, next);
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t save the bubble setting."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FieldSet title="Bubbles">
      <Field
        label="Allow bubbles"
        description="Bot chats can shrink into floating heads you can open from anywhere. Off hides every head and the bubble button."
      >
        <Switch
          checked={enabled}
          disabled={disabled}
          onCheckedChange={(checked) => void save({ botBubblesEnabled: checked })}
          aria-label="Allow bubbles"
        />
      </Field>
      {bubbles.floatOverAppsAvailable ? (
        <Field
          label="Float over other apps"
          description="Heads stay on top of other apps. Off keeps them inside the Aiden window."
        >
          <Switch
            checked={floatOverApps}
            disabled={disabled || !enabled}
            onCheckedChange={(checked) => void save({ botBubblesFloatOverApps: checked })}
            aria-label="Float over other apps"
          />
        </Field>
      ) : (
        <Field
          orientation="vertical"
          description="On this desktop, heads stay inside the Aiden window."
        />
      )}
    </FieldSet>
  );
}
