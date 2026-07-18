// Shortcut settings — configurable global hotkey (default ⌘⌥Space) that brings
// the app forward and focuses the composer.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Field, FieldSet, Input, Switch, Text, toast } from "@glaze/core/components";
import { settingsApi, shortcutApi } from "../../lib/ipc";
import { queryKeys, useSettings } from "../../lib/queries";

const DEFAULT_ACCELERATOR = "Command+Alt+Space";

const ARROWS: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "Return",
  Escape: "Escape",
};

function normalizeKey(e: React.KeyboardEvent): string | null {
  const code = e.code;
  if (e.key === " " || code === "Space") return "Space";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  if (ARROWS[e.key]) return ARROWS[e.key];
  return null;
}

function toAccelerator(e: React.KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.metaKey) parts.push("Command");
  if (e.ctrlKey) parts.push("Control");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const key = normalizeKey(e);
  if (!key || parts.length === 0) return null;
  parts.push(key);
  return parts.join("+");
}

function pretty(accelerator: string): string {
  return accelerator
    .replace("Command", "⌘")
    .replace("Control", "⌃")
    .replace("Alt", "⌥")
    .replace("Shift", "⇧")
    .replace(/\+/g, " ");
}

export function ShortcutSettings() {
  const qc = useQueryClient();
  const settings = useSettings();
  const [recording, setRecording] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const startRecording = () => {
    setRecording(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const enabled = settings.data?.shortcutEnabled ?? true;
  const accelerator = settings.data?.shortcutAccelerator || DEFAULT_ACCELERATOR;

  const apply = async (patch: { shortcutEnabled?: boolean; shortcutAccelerator?: string }) => {
    await settingsApi.set(patch);
    await shortcutApi.apply();
    await qc.invalidateQueries({ queryKey: queryKeys.settings });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    const accel = toAccelerator(e);
    if (accel) {
      setRecording(false);
      void apply({ shortcutAccelerator: accel }).then(() => toast.success(`Shortcut set to ${pretty(accel)}`));
    }
  };

  return (
    <FieldSet title="Global Shortcut">
      <Field label="Enable shortcut" description="Press the hotkey from anywhere to jump to Aiden Agent and start typing.">
        <Switch checked={enabled} onCheckedChange={(v) => void apply({ shortcutEnabled: v })} />
      </Field>
      <Field label="Shortcut" description={recording ? "Press your key combination…" : "Click Record, then press a modifier + key."}>
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            readOnly
            value={recording ? "Recording…" : pretty(accelerator)}
            onKeyDown={onKeyDown}
            onBlur={() => setRecording(false)}
            className="w-40 text-center"
            aria-label="Current shortcut"
          />
          <Button
            size="medium"
            variant={recording ? "accent" : "filled"}
            onClick={() => (recording ? setRecording(false) : startRecording())}
          >
            {recording ? "Cancel" : "Record"}
          </Button>
        </div>
      </Field>
      {accelerator !== DEFAULT_ACCELERATOR ? (
        <Field label="">
          <Button size="small" variant="transparent" onClick={() => void apply({ shortcutAccelerator: DEFAULT_ACCELERATOR })}>
            Reset to default (⌘⌥Space)
          </Button>
        </Field>
      ) : (
        <Text variant="small" color="tertiary">
          Default is ⌘⌥Space.
        </Text>
      )}
    </FieldSet>
  );
}
