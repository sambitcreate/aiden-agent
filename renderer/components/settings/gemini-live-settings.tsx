import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  AudioWaveform,
  CheckCircle2,
  Clock3,
  Mic,
  MousePointer2,
  Server,
  TriangleAlert,
} from "lucide-react";
import { assistantLiveApi } from "../../lib/ipc";
import { useAppCapabilities } from "../../lib/app-capabilities";
import { useComputerUseStatus, useSettings, useShortcuts } from "../../lib/queries";
import type { AssistantLiveSnapshot } from "../../shared/assistant-live";
import { AidenLiveOrb } from "../assistant/aiden-live-orb";
import { Badge, Button, Callout, Field, FieldSet, Text } from "../ui";

function StateBadge({ ready, checking = false }: { ready: boolean; checking?: boolean }) {
  return (
    <Badge color={checking ? undefined : ready ? "green" : "red"}>
      {checking ? "Checking…" : ready ? "Ready" : "Needs attention"}
    </Badge>
  );
}

export function AidenLiveSettings(): React.ReactElement {
  const navigate = useNavigate();
  const capabilities = useAppCapabilities();
  const computerUse = useComputerUseStatus();
  const settings = useSettings();
  const shortcuts = useShortcuts();
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
            <AidenLiveOrb state={liveReady ? "ready" : "unavailable"} />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Text variant="strong">Aiden Live is Aiden’s voice and action layer</Text>
              <Badge color="blue">Beta</Badge>
            </div>
            <Text as="p" variant="small" color="secondary" className="mt-0.5">
              Speak naturally, let Aiden read the current screen, and approve each click or typed
              action one at a time. Availability and supported actions may change during beta.
            </Text>
          </div>
        </div>
      </Callout>

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

      <FieldSet title="Actions">
        <Field
          label="Operate Aiden"
          description="Aiden Live can use the screen and accessibility tree to focus the composer, choose the current model or actions, send prompts, and navigate Aiden."
        >
          <Badge color="blue">
            <AudioWaveform />
            Allow once per action
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
  );
}
