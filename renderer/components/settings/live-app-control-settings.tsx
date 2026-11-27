import * as React from "react";
import { useSettings } from "../../lib/queries";
import { useSettingsSave } from "../../lib/use-settings-save";
import { aidenLivePreferences } from "../../shared/aiden-live-settings";
import { Field, FieldSet, Switch } from "../ui";

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
  const { saving, save } = useSettingsSave({ guard: "state" });
  return (
    <LiveAppControlSwitch
      checked={aidenLivePreferences(settings.data).appControl}
      disabled={settings.isLoading || saving}
      onChange={(checked) =>
        void save({ aidenLiveAppControl: checked }, "Couldn’t update Aiden Live settings.")
      }
    />
  );
}
