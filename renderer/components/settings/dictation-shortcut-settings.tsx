// Global dictation shortcut, Accessibility paste permission, and capture
// options. Shown for every voice provider — paste needs Accessibility even
// when transcription is hosted.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Badge,
  Button,
  Callout,
  Field,
  FieldSet,
  Label,
  RadioGroup,
  RadioGroupItem,
  Switch,
  Text,
  toast,
} from "../ui";
import { settingsApi } from "../../lib/ipc";
import { queryKeys, useSettings, useShortcuts } from "../../lib/queries";
import { prettyAccelerator } from "../../shared/keybindings";
import { installAccessibilityRefresh } from "../../lib/accessibility-refresh";
import {
  checkAccessibilityPermission,
  requestAccessibilityPermission,
  type AccessibilityPermissionState,
} from "../../lib/accessibility-permission-core";
import { useAppCapabilities } from "../../lib/app-capabilities";

async function openAccessibilitySettings(): Promise<void> {
  try {
    await window.aidenAPI.accessibility.openSettings();
  } catch {
    toast.error(
      "Aiden couldn’t open Accessibility Settings. Open Privacy & Security → Accessibility manually.",
    );
  }
}

function AccessibilityAccess() {
  const [permission, setPermission] = React.useState<AccessibilityPermissionState>({
    status: "checking",
  });
  const [requesting, setRequesting] = React.useState(false);
  const permissionRevision = React.useRef(0);
  const requestingRef = React.useRef(false);

  const refresh = React.useCallback(async (showChecking = false) => {
    if (requestingRef.current) return;
    const revision = ++permissionRevision.current;
    if (showChecking) setPermission({ status: "checking" });
    const next = await checkAccessibilityPermission(window.aidenAPI.accessibility.isTrusted);
    if (revision === permissionRevision.current) setPermission(next);
  }, []);

  React.useEffect(() => {
    void refresh(true);
    return installAccessibilityRefresh(() => void refresh());
  }, [refresh]);

  const grant = async () => {
    requestingRef.current = true;
    const revision = ++permissionRevision.current;
    setRequesting(true);
    const next = await requestAccessibilityPermission(window.aidenAPI.accessibility.request);
    if (revision === permissionRevision.current) setPermission(next);
    requestingRef.current = false;
    setRequesting(false);
    if (next.status === "needed") {
      toast.info(
        "Enable Aiden Agent in System Settings → Privacy & Security → Accessibility, then come back.",
      );
    }
  };

  if (permission.status === "checking") {
    return (
      <Field
        label="Accessibility access"
        description="Checking whether Aiden can paste dictated text into other apps."
      >
        <Badge>Checking…</Badge>
      </Field>
    );
  }

  if (permission.status === "granted") {
    return (
      <Field
        label="Accessibility access"
        description="Lets Aiden paste dictated text into the focused text field. This access is local and is not shared with the transcription provider."
      >
        <div className="flex items-center gap-2">
          <Badge color="green">Granted</Badge>
          <Button size="small" variant="transparent" onClick={() => void refresh(true)}>
            Check again
          </Button>
        </div>
      </Field>
    );
  }

  return (
    <Field
      label="Accessibility access"
      description="Optional and used only for local paste. Dictation still works without it and keeps the transcript on your clipboard."
      orientation="vertical"
    >
      <Callout
        color={permission.status === "error" ? "red" : "blue"}
        role={permission.status === "error" ? "alert" : undefined}
        aria-live="polite"
        aria-busy={requesting}
      >
        <Text variant="small-strong">
          {permission.status === "error" ? "Accessibility check failed" : "Paste access needed"}
        </Text>
        <Text as="p" variant="small" color="secondary">
          {permission.status === "error"
            ? permission.message
            : "Allow the current Aiden app to paste automatically. Until then, completed transcripts are copied."}
        </Text>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="small" variant="filled" onClick={() => void grant()} disabled={requesting}>
            {requesting ? "Checking…" : "Grant access"}
          </Button>
          <Button
            size="small"
            onClick={() => void openAccessibilitySettings()}
            disabled={requesting}
          >
            Open System Settings
          </Button>
          <Button
            size="small"
            variant="transparent"
            onClick={() => void refresh(true)}
            disabled={requesting}
          >
            Check again
          </Button>
        </div>
      </Callout>
    </Field>
  );
}

function DictationHotkey() {
  const navigate = useNavigate();
  const shortcuts = useShortcuts();

  if (shortcuts.isError) {
    return (
      <Field label="Dictation hotkey" description="The saved shortcut could not be read.">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Badge color="red">Unavailable</Badge>
          <Button size="small" onClick={() => void shortcuts.refetch()}>
            Retry
          </Button>
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

  if (shortcuts.isLoading || !shortcuts.data) {
    return (
      <Field label="Dictation hotkey" description="Checking the saved global shortcut.">
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
        <Badge
          color={
            runtime?.state === "active"
              ? "green"
              : runtime?.state === "unavailable"
                ? "red"
                : undefined
          }
        >
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
  const capabilities = useAppCapabilities();
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
      {capabilities.accessibilityPaste ? (
        <AccessibilityAccess />
      ) : (
        <Callout color="blue">
          <Text variant="small">
            Completed transcripts are copied to the clipboard so you can paste them into any app.
          </Text>
        </Callout>
      )}
      <Field
        label="Shortcut behavior"
        description="Choose how the global dictation shortcut starts and stops each recording."
        orientation="vertical"
      >
        <RadioGroup
          value={holdToTalk ? "hold" : "toggle"}
          onValueChange={(value) => void patch({ dictationHoldToTalk: value === "hold" })}
          orientation="vertical"
          aria-label="Dictation shortcut behavior"
        >
          <Label className="cursor-pointer items-start rounded-control border border-field px-3 py-2.5 hover:border-primary/30 hover:bg-list-hover">
            <RadioGroupItem value="hold" className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              <span className="block text-regular text-primary">Hold to dictate</span>
              <span className="mt-0.5 block text-small text-secondary">
                Hold the shortcut while speaking; release it to transcribe.
              </span>
            </span>
          </Label>
          <Label className="cursor-pointer items-start rounded-control border border-field px-3 py-2.5 hover:border-primary/30 hover:bg-list-hover">
            <RadioGroupItem value="toggle" className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              <span className="block text-regular text-primary">Press to toggle</span>
              <span className="mt-0.5 block text-small text-secondary">
                Press once to start; press again to stop and transcribe.
              </span>
            </span>
          </Label>
        </RadioGroup>
      </Field>
      <Field
        label="Stop after silence"
        description="Applies to both shortcut behaviors. Release or press the shortcut again to stop manually."
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
