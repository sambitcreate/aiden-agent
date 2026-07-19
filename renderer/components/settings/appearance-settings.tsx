// Appearance settings — light / dark / auto via the native theme source.

import * as React from "react";
import { Field, FieldSet, Label, RadioGroup, RadioGroupItem, toast } from "../ui";
import type { NativeThemeInfo } from "../../preload";

export function AppearanceSettings() {
  const [themeInfo, setThemeInfo] = React.useState<NativeThemeInfo | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      setThemeInfo(await window.aidenAPI.nativeTheme.getInfo());
    } catch (error) {
      toast.error(`Failed to read theme: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleChange = async (value: string) => {
    try {
      await window.aidenAPI.nativeTheme.setThemeSource(value as "system" | "light" | "dark");
      await refresh();
    } catch (error) {
      toast.error(`Failed to set theme: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <FieldSet title="Appearance">
      <Field label="Theme" description="Match the system or force a light or dark interface.">
        <RadioGroup value={themeInfo?.themeSource ?? "system"} onValueChange={handleChange} orientation="horizontal">
          <Label>
            <RadioGroupItem value="system" />
            System
          </Label>
          <Label>
            <RadioGroupItem value="light" />
            Light
          </Label>
          <Label>
            <RadioGroupItem value="dark" />
            Dark
          </Label>
        </RadioGroup>
      </Field>
    </FieldSet>
  );
}
