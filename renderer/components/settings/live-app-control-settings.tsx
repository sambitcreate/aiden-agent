import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { settingsApi } from "../../lib/ipc";
import { queryKeys, useSettings } from "../../lib/queries";
import type { AppSettings } from "../../lib/types";
import { aidenLivePreferences } from "../../shared/aiden-live-settings";
import { Field, FieldSet, Switch, toast } from "../ui";

export const LIVE_APP_CONTROL_LABEL = "Let Live move through Aiden";

/** The "Let Live move through Aiden" row: Live may look at and use Aiden's own window. */
export function LiveAppControlSwitch({
  checked,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}): React.ReactElement {
  return (
    <FieldSet title="In Aiden">
      <Field
        label={LIVE_APP_CONTROL_LABEL}
        description="Live can open pages, press buttons and fill in fields in this window. It asks you before deleting or signing out, and never answers approvals or touches keys."
      >
        <Switch
          data-live-guard="you"
          aria-label={LIVE_APP_CONTROL_LABEL}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
        />
      </Field>
    </FieldSet>
  );
}

export function LiveAppControlSettings(): React.ReactElement {
  const settings = useSettings();
  const queryClient = useQueryClient();
  const [saving, setSaving] = React.useState(false);
  const save = async (checked: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await settingsApi.set({ aidenLiveAppControl: checked });
      queryClient.setQueryData<AppSettings>(queryKeys.settings, saved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t update Aiden Live settings.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <LiveAppControlSwitch
      checked={aidenLivePreferences(settings.data).appControl}
      disabled={settings.isLoading || saving}
      onChange={(checked) => void save(checked)}
    />
  );
}
