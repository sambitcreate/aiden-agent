import * as React from "react";
import { LiveAudioSettings } from "./live-audio-settings";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  AudioWaveform,
  CheckCircle2,
  Clock3,
  Mic,
  MousePointer2,
  Server,
  TriangleAlert,
} from "lucide-react";
import { assistantLiveApi, settingsApi } from "../../lib/ipc";
import { useAppCapabilities } from "../../lib/app-capabilities";
import { queryKeys, useComputerUseStatus, useSettings, useShortcuts } from "../../lib/queries";
import type { AppSettings } from "../../lib/types";
import type { AssistantLiveSnapshot } from "../../shared/assistant-live";
import { AidenLiveMark } from "../assistant/aiden-live-mark";
import { Badge, Button, Callout, Field, FieldSet, Switch, Text, toast } from "../ui";

function StateBadge({ ready, checking = false }: { ready: boolean; checking?: boolean }) {
  return (
    <Badge color={checking ? undefined : ready ? "green" : "red"}>
      {checking ? "Checking…" : ready ? "Ready" : "Needs attention"}
    </Badge>
  );
}

type AidenLiveSwitchPatch = Pick<AppSettings, "aidenLiveEnabled" | "aidenLiveButtonVisible">;

/** The on/off switches. "Show Live button" exists only while Live is on. */
export function AidenLiveSwitches({
  enabled,
  buttonVisible,
  disabled = false,
  onChange,
}: {
  enabled: boolean;
  buttonVisible: boolean;
  disabled?: boolean;
  onChange(patch: AidenLiveSwitchPatch): void;
}): React.ReactElement {
  return (
    <FieldSet title="Availability">
      <Field label="Aiden Live" description="Turns voice and on-screen actions on or off.">
        <Switch
          aria-label="Aiden Live"
          checked={enabled}
          disabled={disabled}
          onCheckedChange={(checked) => onChange({ aidenLiveEnabled: checked })}
        />
      </Field>
      {enabled ? (
        <Field
          label="Show Live button"
          description="Show the Live button in the window corner. The shortcut still works when it’s hidden."
        >
          <Switch
            aria-label="Show Live button"
            checked={buttonVisible}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ aidenLiveButtonVisible: checked })}
          />
        </Field>
      ) : null}
    </FieldSet>
  );
}

export function AidenLiveSettings(): React.ReactElement {
  const navigate = useNavigate();
  const capabilities = useAppCapabilities();
  const computerUse = useComputerUseStatus();
  const settings = useSettings();
  const shortcuts = useShortcuts();
  const queryClient = useQueryClient();
  const [saving, setSaving] = React.useState(false);
  const liveEnabled = settings.data?.aidenLiveEnabled !== false;
  const saveSwitches = async (patch: AidenLiveSwitchPatch) => {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await settingsApi.set(patch);
      queryClient.setQueryData<AppSettings>(queryKeys.settings, saved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t update Aiden Live settings.");
    } finally {
      setSaving(false);
    }
  };
  const [live, setLive] = React.useState<AssistantLiveSnapshot | null>(null);
  const [microphone, setMicrophone] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void Promise.all([
      assistantLiveApi.status().catch(() => null),
      window.aidenAPI.systemPreferences
        .getMediaAccessStatus("microphone")
        .catch(() => "unavailable"),
    ]).then(([snapshot, mic]) => {
      if (!cancelled) {
        setLive(snapshot);
        setMicrophone(mic);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const go = (section: "providers" | "computerUse" | "scheduledTasks" | "shortcut") =>
    void navigate({ to: "/settings", search: { section } });
  const liveReady = capabilities.geminiLive && live?.available === true;
  const shortcut = shortcuts.data?.global.find((item) => item.commandId === "assistant.open");
  const requestMicrophone = async () => {
    const granted = await window.aidenAPI.systemPreferences.askForMediaAccess("microphone");
    setMicrophone(granted ? "granted" : "denied");
  };

  return (
    <>
      <Callout className="mb-4">
        <div className="flex items-center gap-3">
          <span className="block size-14 shrink-0">
            <AidenLiveMark state={liveReady ? "ready" : "unavailable"} />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Text variant="strong">Aiden Live is Aiden’s voice and action layer</Text>
              <Badge color="blue">Beta</Badge>
            </div>
            <Text as="p" variant="small" color="secondary" className="mt-0.5">
              Speak naturally and let Aiden act on your screen during Live. Stop Live to end
              session access. Availability and supported actions may change during beta.
            </Text>
          </div>
        </div>
      </Callout>

      <AidenLiveSwitches
        enabled={liveEnabled}
        buttonVisible={settings.data?.aidenLiveButtonVisible !== false}
        disabled={settings.isLoading || saving}
        onChange={(patch) => void saveSwitches(patch)}
      />

      {liveEnabled ? (
        <>
        <FieldSet title="Live readiness">
          <Field
            label="Google Live model"
            description={
              live?.reason === "available"
                ? `Using ${live.model ?? "Google Gemini"}.`
                : "Connect a Google API key and choose an approved Live model."
            }
          >
            <div className="flex items-center gap-2">
              <StateBadge ready={liveReady} checking={live === null} />
              <Button size="small" variant="filled" onClick={() => go("providers")}>
                <Server />
                Manage
              </Button>
            </div>
          </Field>
          <Field label="Microphone" description="Used only while a Live session is open.">
            <div className="flex items-center gap-2">
              <StateBadge ready={microphone === "granted"} checking={microphone === null} />
              <Button size="small" variant="filled" onClick={() => void requestMicrophone()}>
                <Mic />
                Allow
              </Button>
            </div>
          </Field>
          <Field
            label="Screen and Accessibility"
            description={computerUse.data?.detail ?? "Checking the signed Computer Use helper."}
          >
            <div className="flex items-center gap-2">
              <StateBadge ready={computerUse.data?.ready === true} checking={computerUse.isLoading} />
              <Button size="small" variant="filled" onClick={() => go("computerUse")}>
                <MousePointer2 />
                Manage
              </Button>
            </div>
          </Field>
        </FieldSet>

        <LiveAudioSettings />

        <FieldSet title="Actions">
          <Field
            label="Operate Aiden"
            description="Aiden Live can use the screen and accessibility tree to focus the composer, choose the current model or actions, send prompts, and navigate Aiden."
          >
            <Badge color="blue">
              <AudioWaveform />
              Direct actions during Live
            </Badge>
          </Field>
          <Field
            label="Scheduled tasks"
            description="Create or review one-time and recurring work through Aiden’s existing scheduled-task interface."
          >
            <div className="flex items-center gap-2">
              <Badge color={settings.data?.scheduledTasksEnabled ? "green" : undefined}>
                {settings.data?.scheduledTasksEnabled ? "Enabled" : "Available"}
              </Badge>
              <Button size="small" variant="filled" onClick={() => go("scheduledTasks")}>
                <Clock3 />
                Review
              </Button>
            </div>
          </Field>
          <Field
            label="Global shortcut"
            description="The Aiden shortcut now opens setup, starts Live, or reveals the active Live controls."
          >
            <div className="flex items-center gap-2">
              {shortcut?.state === "active" ? (
                <CheckCircle2 className="size-4 text-support-green" />
              ) : (
                <TriangleAlert className="size-4 text-support-warning" />
              )}
              <Badge>{shortcut?.state === "active" ? "Active" : "Not active"}</Badge>
              <Button size="small" variant="filled" onClick={() => go("shortcut")}>
                Manage
              </Button>
            </div>
          </Field>
        </FieldSet>
        </>
      ) : null}
    </>
  );
}
