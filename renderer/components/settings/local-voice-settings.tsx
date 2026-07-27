// On-device voice settings: engine status, the active Parakeet model (with a
// button into the full model-management subview), and the dictation hotkey.
// Everything runs locally — recordings are transcribed on the user's Mac.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Badge, Button, Callout, Field, FieldSet, Text, toast } from "../ui";
import { Settings2 } from "lucide-react";
import { settingsApi } from "../../lib/ipc";
import { queryKeys, useEngineStatus, useLocalModels, useSettings, useShortcuts } from "../../lib/queries";
import { prettyAccelerator } from "../../shared/keybindings";
import { ModelManagerView } from "./model-manager-view";
import { installAccessibilityRefresh } from "../../lib/accessibility-refresh";

function EngineStatus() {
  const status = useEngineStatus();
  if (status.isLoading) {
    return (
      <Field label="Engine" description="Checking the bundled on-device transcription engine.">
        <Badge>Checking…</Badge>
      </Field>
    );
  }
  if (status.isError || (status.data && !status.data.ready)) {
    return (
      <Callout color="red">
        <Text variant="small-strong" color="red">
          On-device engine unavailable
        </Text>
        <Text variant="small" color="secondary">
          {status.data?.error ?? (status.error instanceof Error ? status.error.message : "The speech engine failed to load.")}
        </Text>
      </Callout>
    );
  }
  return (
    <Field label="Engine" description="Transcription runs locally after you download a Parakeet model.">
      <Badge color="green">Ready</Badge>
    </Field>
  );
}

function ActiveModel({ onManage }: { onManage: () => void }) {
  const qc = useQueryClient();
  const models = useLocalModels();
  const settings = useSettings();
  const activeId = settings.data?.localVoiceModel ?? "";
  const active = (models.data ?? []).find((m) => m.id === activeId && m.installed);
  const installedCount = (models.data ?? []).filter((m) => m.installed).length;

  // If the active model was deleted, clear it so the mic prompts to pick another.
  React.useEffect(() => {
    if (activeId && models.data && !models.data.some((m) => m.id === activeId && m.installed)) {
      void settingsApi.set({ localVoiceModel: "" }).then(() => qc.invalidateQueries({ queryKey: queryKeys.settings }));
    }
  }, [activeId, models.data, qc]);

  return (
    <>
      {installedCount === 0 ? (
        <Callout color="blue">
          <Text variant="small">No on-device models yet. Download one to start transcribing locally.</Text>
        </Callout>
      ) : (
        <Field label="Active model" description="Used when you dictate with the on-device provider.">
          <Text variant="small-strong">{active ? active.name : "None selected"}</Text>
        </Field>
      )}
      <Field label="Models" description="Download, remove, and choose your on-device transcription model.">
        <Button variant="filled" onClick={onManage}>
          <Settings2 />
          Manage Models
        </Button>
      </Field>
    </>
  );
}

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

export function LocalVoiceSettings() {
  const [managing, setManaging] = React.useState(false);

  if (managing) return <ModelManagerView onBack={() => setManaging(false)} />;

  return (
    <div className="flex flex-col gap-6">
      <FieldSet title="On-Device Engine">
        <EngineStatus />
        <ActiveModel onManage={() => setManaging(true)} />
      </FieldSet>

      <FieldSet title="Dictation Shortcut">
        <DictationHotkey />
        <AccessibilityAccess />
      </FieldSet>
    </div>
  );
}
