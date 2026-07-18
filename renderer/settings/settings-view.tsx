import { useState, useEffect } from "react";
import {
  Label,
  RadioGroup,
  RadioGroupItem,
  ScrollArea,
  Toolbar,
  ToolbarContent,
  ToolbarTitle,
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
  FieldSet,
  toast,
} from "@glaze/core/components";
import type { NativeThemeInfo } from "@glaze/core/ipc";

export function SettingsView() {
  const [themeInfo, setThemeInfo] = useState<NativeThemeInfo | null>(null);
  const [_isLoading, setIsLoading] = useState(true);

  // Close settings window on Escape, unless an interactive element is focused or a popover is open
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;

      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }

      if (document.querySelector("[data-radix-popper-content-wrapper]")) {
        return;
      }

      event.preventDefault();
      window.glazeAPI.glaze.ipc.invoke("window:closeSettings");
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const refreshThemeInfo = async () => {
    try {
      const info = await window.glazeAPI.nativeTheme.getInfo();
      setThemeInfo(info);
    } catch (error) {
      toast.error(`Failed to get theme info: ${error}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    refreshThemeInfo();
  }, []);

  const handleThemeChange = async (value: string) => {
    const source = value as "system" | "light" | "dark";
    try {
      await window.glazeAPI.nativeTheme.setThemeSource(source);
      await refreshThemeInfo();
    } catch (error) {
      toast.error(`Failed to set theme: ${error}`);
    }
  };

  return (
    <ScrollArea
      toolbar={
        <Toolbar>
          <ToolbarContent>
            <ToolbarTitle>Settings</ToolbarTitle>
          </ToolbarContent>
        </Toolbar>
      }
    >
      <div className="px-4 flex flex-col gap-8 mb-8">
        <FieldSet>
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="theme">Theme</FieldLabel>
              </FieldContent>
              <RadioGroup
                value={themeInfo?.themeSource ?? "system"}
                onValueChange={handleThemeChange}
                orientation="horizontal"
              >
                <Label>
                  <RadioGroupItem value="system" />
                  Auto
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
          </FieldGroup>
        </FieldSet>
      </div>
    </ScrollArea>
  );
}
