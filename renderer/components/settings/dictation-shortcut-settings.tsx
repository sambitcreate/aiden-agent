// Global dictation shortcut, Accessibility paste permission, and capture
// options. Shown for every voice provider — paste needs Accessibility even
// when transcription is hosted.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Badge, Button, Field, FieldSet, Switch, Text, toast } from "../ui";
import { settingsApi } from "../../lib/ipc";
import { queryKeys, useSettings, useShortcuts } from "../../lib/queries";
import { prettyAccelerator } from "../../shared/keybindings";
import { installAccessibilityRefresh } from "../../lib/accessibility-refresh";

function AccessibilityAccess() {
  const [trusted, setTrusted] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    const refresh = () => void window.aidenAPI.accessibility.isTrusted().then(setTrusted);
    refresh();
    return installAccessibilityRefresh(refresh);
  }, []);

  const grant = async () => {
    const granted = await window.aidenAPI.accessibility.request();
    setTrusted(granted);
    if (!granted) {
      toast.info("Enable Aiden Agent in System Settings → Privacy & Security → Accessibility, then come back.");
    }
  };

  if (trusted === null) return null;
  return (
    <Field
      label="Accessibility access"
      description="Lets Aiden paste dictated text into the focused text field. Without it, transcripts are copied to the clipboard instead."
    >
      {trusted ? (
        <Badge color="green">Granted</Badge>
      ) : (
        <Button variant="filled" onClick={() => void grant()}>
          Grant Access
        </Button>
      )}
    </Field>
  );
}

function DictationHotkey() {
  const navigate = useNavigate();
  const shortcuts = useShortcuts();

  if (shortcuts.isError) {
    return (
      <Field
        label="Dictation hotkey"
        description="The saved shortcut could not be read."
      >
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Badge color="red">Unavailable</Badge>
          <Button size="small" onClick={() => void shortcuts.refetch()}>
            Retry
          </Button>
          <Button
            size="small"
            variant="filled"
            onClick={() =>
              void navigate({ to: "/settings", search: { section: "shortcut" } })
            }
          >
            Manage shortcuts
          </Button>
        </div>
      </Field>
    );
  }

  if (shortcuts.isLoading || !shortcuts.data) {
    return (
      <Field
        label="Dictation hotkey"
        description="Checking the saved global shortcut."
      >
        <Badge>Checking…</Badge>
      </Field>
    );
  }

  const binding = shortcuts.data?.effective["dictation.toggle"] ?? null;
  const runtime = shortcuts.data?.global.find((item) => item.commandId === "dictation.toggle");

  return (
    <Field
      label="Dictation hotkey"
      description="Press it from anywhere to dictate into the focused text field. When nothing editable is focused, the transcript is copied to the clipboard."
    >
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Badge color={runtime?.state === "active" ? "green" : runtime?.state === "unavailable" ? "red" : undefined}>
          {runtime?.state === "active"
            ? "Active"
            : runtime?.state === "unavailable"
              ? "Unavailable"
              : "Off"}
        </Badge>
        <Text variant="small-strong">{prettyAccelerator(binding)}</Text>
        <Button
          size="small"
          variant="filled"
          onClick={() => void navigate({ to: "/settings", search: { section: "shortcut" } })}
        >
          Manage shortcuts
        </Button>
      </div>
    </Field>
  );
}

export function DictationShortcutSettings() {
  const qc = useQueryClient();
  const settings = useSettings();
  const holdToTalk = settings.data?.dictationHoldToTalk === true;
  const silenceStop = settings.data?.dictationSilenceStop === true;
  const cleanup = settings.data?.dictationCleanup === true;
  const sounds = settings.data?.dictationSounds === true;

  const patch = async (next: {
    dictationHoldToTalk?: boolean;
    dictationSilenceStop?: boolean;
    dictationCleanup?: boolean;
    dictationSounds?: boolean;
  }) => {
    await settingsApi.set(next);
    await qc.invalidateQueries({ queryKey: queryKeys.settings });
  };

  return (
    <FieldSet title="Dictation Shortcut">
      <DictationHotkey />
      <AccessibilityAccess />
      <Field
        label="Hold to talk"
        description="Hold the shortcut to record and release it to transcribe. Leave off to press once to start and again to stop."
      >
        <Switch
          checked={holdToTalk}
          onCheckedChange={(value) => void patch({ dictationHoldToTalk: value })}
        />
      </Field>
      <Field
        label="Stop after silence"
        description="Ends recording shortly after you stop speaking. You can still stop with the shortcut."
      >
        <Switch
          checked={silenceStop}
          onCheckedChange={(value) => void patch({ dictationSilenceStop: value })}
        />
      </Field>
      <Field
        label="Clean up transcript"
        description="Optionally polish punctuation and filler words with your current chat model before pasting. That sends the transcript to the model. The original words stay if cleanup fails."
      >
        <Switch
          checked={cleanup}
          onCheckedChange={(value) => void patch({ dictationCleanup: value })}
        />
      </Field>
      <Field
        label="Play sounds"
        description="Short start, stop, and done cues from the dictation pill. Off by default."
      >
        <Switch
          checked={sounds}
          onCheckedChange={(value) => void patch({ dictationSounds: value })}
        />
      </Field>
    </FieldSet>
  );
}
