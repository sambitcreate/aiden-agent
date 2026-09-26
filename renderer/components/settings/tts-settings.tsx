// Settings → Text to Speech: connection, model, voice, delivery, reading
// preferences, and privacy. Credential values never round-trip: the dedicated
// key field is cleared after submission and only readiness crosses IPC.

import * as React from "react";
import {
  Button,
  Callout,
  Field,
  FieldSet,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  toast,
} from "../ui";
import { ttsApi } from "../../lib/ipc";
import { useReadAloud } from "../../lib/tts-client";
import {
  TTS_MODEL_IDS,
  TTS_LIMITS,
  type TtsDeliveryPreset,
  type TtsModelId,
  type TtsSettingsV1,
} from "../../shared/tts";

interface TtsSettingsSnapshot {
  settings: TtsSettingsV1;
  settingsRevision: string;
  credentialReady: boolean;
  credentialSourceLabel: string;
}

const MODEL_LABELS: Record<TtsModelId, string> = {
  "gemini-3.8-flash-tts": "Gemini 3.8 Flash TTS",
  "gemini-3.8-flash-lite-tts": "Gemini 3.8 Flash-Lite TTS",
};

const DEFAULT_VOICE = "__default__";

const PRESET_LABELS: Record<TtsDeliveryPreset, string> = {
  neutral: "Neutral",
  conversational: "Conversational",
  calm: "Calm",
};

export function TtsSettings() {
  const [snapshot, setSnapshot] = React.useState<TtsSettingsSnapshot | null>(null);
  const [voices, setVoices] = React.useState<Array<{ providerVoiceId: string; name: string }>>([]);
  const [dedicatedKey, setDedicatedKey] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [loadError, setLoadError] = React.useState(false);
  const [deliveryNote, setDeliveryNote] = React.useState("");
  const { state: previewState, controller: previewController } = useReadAloud(undefined);
  const previewActive = previewState.busy || previewState.playing || previewState.paused;

  const refresh = React.useCallback(async () => {
    try {
      const status = await ttsApi.status();
      setLoadError(false);
      setSnapshot({
        settings: status.settings,
        settingsRevision: status.settingsRevision,
        credentialReady: status.credentialReady,
        credentialSourceLabel: status.credentialSourceLabel,
      });
    } catch {
      setLoadError(true);
    }
  }, []);

  React.useEffect(() => {
    setDeliveryNote(snapshot?.settings.delivery.note ?? "");
  }, [snapshot?.settings.delivery.note]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    void ttsApi
      .starterVoices()
      .then((list) => setVoices(list))
      .catch(() => setVoices([]));
  }, []);

  const patch = React.useCallback(
    async (update: Partial<TtsSettingsV1> & object) => {
      const current = snapshot;
      if (!current) return;
      setSaving(true);
      try {
        const next = await ttsApi.updateSettings(current.settingsRevision, update);
        setSnapshot((existing) =>
          existing
            ? {
                settings: next.settings,
                settingsRevision: next.settingsRevision,
                credentialReady: existing.credentialReady,
                credentialSourceLabel: existing.credentialSourceLabel,
              }
            : existing,
        );
        await refresh();
      } catch (error) {
        toast.info(
          error instanceof Error ? error.message : "Could not save Text to Speech settings.",
        );
        void refresh();
      } finally {
        setSaving(false);
      }
    },
    [refresh, snapshot],
  );

  const saveDedicatedKey = async () => {
    const key = dedicatedKey.trim();
    if (!key) return;
    setSaving(true);
    try {
      await ttsApi.setDedicatedCredential(key);
      setDedicatedKey("");
      await refresh();
      toast.info("Dedicated Text to Speech key saved.");
    } catch (error) {
      toast.info(error instanceof Error ? error.message : "Could not save that API key.");
    } finally {
      setSaving(false);
    }
  };

  if (!snapshot) {
    return (
      <div>
        <Text color="secondary" role="status">
          {loadError
            ? "Text to Speech settings could not be loaded."
            : "Loading Text to Speech settings…"}
        </Text>
        {loadError ? (
          <Button variant="muted" onClick={() => void refresh()}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  }

  const settings = snapshot.settings;

  return (
    <div>
      <FieldSet title="Read aloud">
        <Field
          label="Read aloud"
          description="Only the selected response is sent to Google when you press the speaker."
        >
          <Switch
            checked={settings.enabled}
            disabled={saving}
            onCheckedChange={(checked) => void patch({ enabled: checked })}
          />
        </Field>
      </FieldSet>

      <FieldSet title="Connection">
        <Field
          label="Google API key"
          description="Reuse your saved Google provider key, or save a dedicated key used only for speech."
        >
          <Select
            value={settings.credentialSource}
            disabled={saving}
            onValueChange={(value) =>
              void patch({ credentialSource: value as "saved-google" | "dedicated" })
            }
          >
            <SelectTrigger
              size="small"
              className="w-56 max-w-full"
              aria-label="Google API key source"
            >
              <SelectValue>
                {settings.credentialSource === "saved-google"
                  ? "Use saved Google key"
                  : "Dedicated key"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="saved-google">Use saved Google key</SelectItem>
              <SelectItem value="dedicated">Dedicated key</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {settings.credentialSource === "dedicated" ? (
          <Field
            label="Dedicated key"
            description="Stored encrypted on this Mac. The value is never read back into settings."
          >
            <div className="flex items-center gap-2">
              <Input
                type="password"
                value={dedicatedKey}
                placeholder="Paste a Google API key"
                onChange={(event) => setDedicatedKey(event.target.value)}
                autoComplete="off"
                aria-label="Dedicated Google API key"
              />
              <Button
                variant="muted"
                disabled={saving || dedicatedKey.trim().length === 0}
                onClick={() => void saveDedicatedKey()}
              >
                Save key
              </Button>
              <Button
                variant="transparent"
                disabled={saving}
                onClick={async () => {
                  setSaving(true);
                  try {
                    await ttsApi.clearDedicatedCredential();
                    await refresh();
                  } catch {
                    toast.info("Could not remove the dedicated key.");
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                Remove
              </Button>
            </div>
          </Field>
        ) : null}
        <Field label="Status" description="Credentials stay encrypted; only readiness is shown.">
          <Text color={snapshot.credentialReady ? "secondary" : "tertiary"}>
            {snapshot.credentialReady
              ? `Connected · ${snapshot.credentialSourceLabel}`
              : "Needs setup"}
          </Text>
        </Field>
      </FieldSet>

      <FieldSet title="Speech model">
        <Field
          label="Model"
          description="Flash is quality-oriented; Flash-Lite is the lower-cost alternative."
        >
          <Select
            value={settings.model}
            disabled={saving}
            onValueChange={(value) => void patch({ model: value as TtsModelId })}
          >
            <SelectTrigger size="small" className="w-56 max-w-full" aria-label="Speech model">
              <SelectValue>{MODEL_LABELS[settings.model]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {TTS_MODEL_IDS.map((id) => (
                <SelectItem key={id} value={id}>
                  {MODEL_LABELS[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </FieldSet>

      <FieldSet title="Voice">
        <Field
          label="Voice"
          description="Prebuilt Gemini voices. Selecting a voice does not speak."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={settings.selectedVoice?.localVoiceId ?? DEFAULT_VOICE}
              disabled={saving}
              onValueChange={(providerVoiceId) => {
                void patch({
                  selectedVoice:
                    providerVoiceId !== DEFAULT_VOICE
                      ? { kind: "prebuilt", localVoiceId: providerVoiceId }
                      : null,
                });
              }}
            >
              <SelectTrigger size="small" className="w-44 max-w-full" aria-label="Read aloud voice">
                <SelectValue>
                  {settings.selectedVoice
                    ? (voices.find(
                        (v) => v.providerVoiceId === settings.selectedVoice?.localVoiceId,
                      )?.name ?? settings.selectedVoice.localVoiceId)
                    : "Default (Kore)"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_VOICE}>Default (Kore)</SelectItem>
                {voices.map((voice) => (
                  <SelectItem key={voice.providerVoiceId} value={voice.providerVoiceId}>
                    {voice.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="muted"
              disabled={
                !previewActive && (saving || !settings.enabled || !snapshot.credentialReady)
              }
              onClick={() => {
                if (previewActive) previewController.stop();
                else void previewController.preview();
              }}
            >
              {previewActive ? "Stop preview" : "Preview sample"}
            </Button>
          </div>
        </Field>
      </FieldSet>

      {previewState.error ? (
        <Text color="secondary" role="alert">
          {previewState.error.message}
        </Text>
      ) : null}

      <FieldSet title="Delivery">
        <Field label="Style" description="A short preset applied as the speech style instruction.">
          <Select
            value={settings.delivery.preset}
            disabled={saving}
            onValueChange={(value) =>
              void patch({
                delivery: {
                  preset: value as TtsDeliveryPreset,
                  note: settings.delivery.note,
                },
              })
            }
          >
            <SelectTrigger size="small" className="w-44 max-w-full" aria-label="Delivery style">
              <SelectValue>{PRESET_LABELS[settings.delivery.preset]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PRESET_LABELS) as TtsDeliveryPreset[]).map((preset) => (
                <SelectItem key={preset} value={preset}>
                  {PRESET_LABELS[preset]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Optional delivery note"
          description="Up to 240 characters, applied only as a delivery instruction."
        >
          <Input
            value={deliveryNote}
            disabled={saving}
            aria-label="Optional delivery note"
            maxLength={TTS_LIMITS.deliveryNoteMaxChars}
            placeholder="e.g. slightly slower pace"
            onChange={(event) => setDeliveryNote(event.target.value)}
            onBlur={() => {
              if (deliveryNote !== settings.delivery.note) {
                void patch({ delivery: { preset: settings.delivery.preset, note: deliveryNote } });
              }
            }}
          />
        </Field>
      </FieldSet>

      <FieldSet title="Reading preferences">
        <Field
          label="Read inline code"
          description="Speak short inline names, commands, and flags literally."
        >
          <Switch
            checked={settings.reading.inlineCode}
            disabled={saving}
            onCheckedChange={(checked) =>
              void patch({ reading: { ...settings.reading, inlineCode: checked } })
            }
          />
        </Field>
        <Field
          label="Read fenced code blocks"
          description="Off by default; skipped blocks are announced next to the speaker action."
        >
          <Switch
            checked={settings.reading.fencedCode}
            disabled={saving}
            onCheckedChange={(checked) =>
              void patch({ reading: { ...settings.reading, fencedCode: checked } })
            }
          />
        </Field>
      </FieldSet>

      <FieldSet title="Privacy and storage">
        <Field
          label="Cloud processing"
          description="Applies to responses from every provider, including local models."
        >
          <Callout color="neutral">
            <Text variant="small" color="secondary">
              Read aloud sends the selected response text to Google. This also applies to responses
              generated by local models. Usage may be billed to your Google account.
            </Text>
          </Callout>
        </Field>
        <Field
          label="Audio retention"
          description="Generated speech is kept in a bounded session cache and never enters chats or exports."
        >
          <Button
            variant="muted"
            disabled={saving}
            onClick={async () => {
              try {
                previewController.stop();
                await ttsApi.clearCache();
                toast.info("Generated audio cleared.");
              } catch {
                toast.info("Could not clear generated audio.");
              }
            }}
          >
            Clear generated audio
          </Button>
        </Field>
      </FieldSet>
    </div>
  );
}
