// On-device voice settings: engine status, the active model, whether it loads
// ahead of the first dictation, when an idle model is unloaded to free memory,
// and silence trimming.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Callout,
  Field,
  FieldSet,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  toast,
} from "../ui";
import { Download, Settings2 } from "lucide-react";
import { localVoiceApi, onNotification, settingsApi } from "../../lib/ipc";
import type { ModelDownloadProgress } from "../../lib/ipc";
import type { LocalVoiceModel } from "../../lib/types";
import { queryKeys, useEngineStatus, useLocalModels, useSettings } from "../../lib/queries";
import { ModelManagerView } from "./model-manager-view";
import { effectiveLocalModelId } from "../../shared/voice-provider";
import {
  DEFAULT_LOCAL_VOICE_IDLE_UNLOAD_MINUTES,
  isLocalVoiceIdleUnloadMinutes,
  LOCAL_VOICE_IDLE_UNLOAD_CHOICES,
} from "../../shared/dictation-preferences";
import { localVoicePreloadEnabled, voiceTrimSilenceEnabled } from "../../shared/voice-preferences";

function idleUnloadLabel(minutes: number): string {
  if (minutes === 0) return "Never";
  if (minutes === 60) return "After 1 hour";
  return `After ${minutes} minutes`;
}

export function IdleUnload() {
  const qc = useQueryClient();
  const settings = useSettings();
  const stored = settings.data?.localVoiceIdleUnloadMinutes;
  const minutes = isLocalVoiceIdleUnloadMinutes(stored) ? stored : DEFAULT_LOCAL_VOICE_IDLE_UNLOAD_MINUTES;
  const choices = LOCAL_VOICE_IDLE_UNLOAD_CHOICES.includes(minutes)
    ? LOCAL_VOICE_IDLE_UNLOAD_CHOICES
    : [...LOCAL_VOICE_IDLE_UNLOAD_CHOICES, minutes].sort((a, b) => a - b);

  const change = async (value: string) => {
    try {
      await settingsApi.set({ localVoiceIdleUnloadMinutes: Number(value) });
      await qc.invalidateQueries({ queryKey: queryKeys.settings });
    } catch {
      toast.error("Aiden couldn’t change when the on-device model unloads.");
    }
  };

  return (
    <Field
      label="Free memory when idle"
      description={minutes === 0
        ? "The model stays loaded after first use for the fastest start. It is loaded again automatically when you dictate."
        : "Unloads the model after this long without dictation. It is loaded again automatically when you press the shortcut or start the mic."}
    >
      <Select value={String(minutes)} onValueChange={(value) => void change(value)}>
        <SelectTrigger size="small" aria-label="Unload the on-device model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice} value={String(choice)}>
              {idleUnloadLabel(choice)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function LoadInAdvance() {
  const qc = useQueryClient();
  const settings = useSettings();
  const enabled = localVoicePreloadEnabled(settings.data?.localVoicePreload);

  const change = async (value: boolean) => {
    try {
      await settingsApi.set({ localVoicePreload: value });
      await qc.invalidateQueries({ queryKey: queryKeys.settings });
    } catch {
      toast.error("Aiden couldn’t change when the on-device model loads.");
    }
  };

  return (
    <Field
      label="Load in advance"
      description="Loads the model when Aiden starts and when you choose one, so the first dictation starts instantly. Off loads it when you start dictating."
    >
      <Switch aria-label="Load in advance" checked={enabled} onCheckedChange={(value) => void change(value)} />
    </Field>
  );
}

function TrimSilence() {
  const qc = useQueryClient();
  const settings = useSettings();
  const enabled = voiceTrimSilenceEnabled(settings.data?.voiceTrimSilence);

  const change = async (value: boolean) => {
    try {
      await settingsApi.set({ voiceTrimSilence: value });
      await qc.invalidateQueries({ queryKey: queryKeys.settings });
    } catch {
      toast.error("Aiden couldn’t change silence trimming.");
    }
  };

  return (
    <Field
      label="Trim silence"
      description="Skips silence and splits long recordings so every model can transcribe them."
    >
      <Switch aria-label="Trim silence" checked={enabled} onCheckedChange={(value) => void change(value)} />
    </Field>
  );
}

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
    <Field label="Engine" description="Transcription runs locally after you download a speech model.">
      <Badge color="green">Ready</Badge>
    </Field>
  );
}

/** Faster builds of a model that only some hosts list, such as Parakeet on this Mac's GPU. */
const FASTER_MODEL: Readonly<Record<string, string>> = { "parakeet-v3": "parakeet-v3-metal" };

/**
 * Offers the faster build of the model dictation uses, when this host lists
 * it and it is not downloaded. A chosen model follows the upgrade; Automatic
 * stays Automatic and picks the faster build up on its own.
 */
function FasterModelOffer({ inUse, faster, chosen }: { inUse: LocalVoiceModel; faster: LocalVoiceModel; chosen: boolean }) {
  const qc = useQueryClient();
  const [percentage, setPercentage] = React.useState<number | null>(null);

  React.useEffect(
    () =>
      onNotification<ModelDownloadProgress>("localModels:progress", (progress) => {
        if (progress.id === faster.id) setPercentage(progress.percentage);
      }),
    [faster.id],
  );

  const upgrade = async () => {
    setPercentage(0);
    try {
      await localVoiceApi.downloadModel(faster.id);
      if (chosen) await settingsApi.set({ localVoiceModel: faster.id });
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.localModels }),
        qc.invalidateQueries({ queryKey: queryKeys.settings }),
        qc.invalidateQueries({ queryKey: queryKeys.voiceResolution }),
        qc.invalidateQueries({ queryKey: queryKeys.engineStatus }),
      ]);
      toast.success(`${faster.name} is ready. You can remove ${inUse.name} in Manage Models.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/cancel/i.test(message)) toast.error(message);
    } finally {
      setPercentage(null);
    }
  };

  return (
    <Field
      label="Faster on this Mac"
      description={`${faster.description} ${faster.sizeLabel} download.`}
    >
      {percentage === null ? (
        <Button variant="filled" onClick={() => void upgrade()}>
          <Download />
          Download and Use
        </Button>
      ) : (
        <div className="flex items-center gap-2">
          <Text variant="small" color="secondary" className="tabular-nums">
            Downloading… {percentage}%
          </Text>
          <Button variant="transparent" onClick={() => void localVoiceApi.cancelDownload(faster.id)}>
            Cancel
          </Button>
        </div>
      )}
    </Field>
  );
}

function ActiveModel({ onManage }: { onManage: () => void }) {
  const qc = useQueryClient();
  const models = useLocalModels();
  const settings = useSettings();
  const activeId = settings.data?.localVoiceModel ?? "";
  const installed = (models.data ?? []).filter((m) => m.installed);
  const installedCount = installed.length;
  const active = installed.find((m) => m.id === activeId);
  // With no usable choice, dictation falls back to the first installed model.
  const fallbackId = active
    ? undefined
    : effectiveLocalModelId(undefined, installed.map((m) => m.id));
  const fallback = installed.find((m) => m.id === fallbackId);
  const inUse = active ?? fallback;
  const fasterId = inUse ? FASTER_MODEL[inUse.id] : undefined;
  const faster = fasterId ? (models.data ?? []).find((m) => m.id === fasterId && !m.installed) : undefined;

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
          <Text variant="small-strong">
            {active ? active.name : fallback ? `${fallback.name} (automatic)` : "None selected"}
          </Text>
        </Field>
      )}
      {inUse && faster ? <FasterModelOffer inUse={inUse} faster={faster} chosen={active !== undefined} /> : null}
      <Field label="Models" description="Download, remove, and choose your on-device transcription model.">
        <Button variant="filled" onClick={onManage}>
          <Settings2 />
          Manage Models
        </Button>
      </Field>
    </>
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
        <LoadInAdvance />
        <IdleUnload />
        <TrimSilence />
      </FieldSet>
    </div>
  );
}
