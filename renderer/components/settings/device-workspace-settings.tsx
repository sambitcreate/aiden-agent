import { Field, FieldSet, Switch } from "../ui";
import { deviceWorkspace, useAutoFloatDevice } from "../../lib/device-workspace-store";
import { SimulatorSettings } from "./simulator-settings";

export const AUTO_FLOAT_DEVICE_LABEL = "Auto-show floating device";

export interface DeviceWorkspaceSettingsViewProps {
  autoFloat: boolean;
  onAutoFloatChange(enabled: boolean): void;
}

/** How devices appear around the chat. A window preference; nothing is sent anywhere. */
export function DeviceWorkspaceSettingsView({ autoFloat, onAutoFloatChange }: DeviceWorkspaceSettingsViewProps) {
  return (
    <FieldSet title="Workspace">
      <Field
        label={AUTO_FLOAT_DEVICE_LABEL}
        description="When Aiden opens a simulator in a chat, show it in a small player over the chat. Turn this off to open it in its Environment tab instead."
      >
        <div className="flex items-center justify-end">
          <Switch checked={autoFloat} aria-label={AUTO_FLOAT_DEVICE_LABEL} onCheckedChange={onAutoFloatChange} />
        </div>
      </Field>
    </FieldSet>
  );
}

export function DeviceWorkspaceSettings() {
  const autoFloat = useAutoFloatDevice();
  return <DeviceWorkspaceSettingsView autoFloat={autoFloat} onAutoFloatChange={deviceWorkspace.setAutoFloat} />;
}

/** Settings → Simulator: permissions and helper tools, then how devices appear in the workspace. */
export function SimulatorSettingsPage() {
  return (
    <>
      <SimulatorSettings />
      <DeviceWorkspaceSettings />
    </>
  );
}
