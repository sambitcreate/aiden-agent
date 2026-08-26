// Voice settings — transcription provider for the composer's mic button and the
// dictation hotkey. Cloud providers (OpenAI / Gemini) reuse the keys configured
// under Providers; "On-device" runs Parakeet locally (managed below).

import { useQueryClient } from "@tanstack/react-query";
import {
  Field,
  FieldSet,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui";
import { settingsApi } from "../../lib/ipc";
import { queryKeys, useSettings } from "../../lib/queries";
import type { VoiceProvider } from "../../lib/types";
import {
  CLOUD_VOICE_MODELS,
  resolveCloudVoiceModel,
  type CloudVoiceProvider,
} from "../../shared/voice-models";
import { DictationShortcutSettings } from "./dictation-shortcut-settings";
import { LocalVoiceSettings } from "./local-voice-settings";

export function VoiceSettings() {
  const qc = useQueryClient();
  const settings = useSettings();
  const provider: VoiceProvider = settings.data?.voiceProvider ?? "openai";
  const isCloud = provider === "openai" || provider === "gemini";
  const model = isCloud ? resolveCloudVoiceModel(provider, settings.data?.voiceModel) : "";

  const patch = async (next: { voiceProvider?: VoiceProvider; voiceModel?: string }) => {
    await settingsApi.set(next);
    await qc.invalidateQueries({ queryKey: queryKeys.settings });
  };

  const changeProvider = (value: string) => {
    const p = value as VoiceProvider;
    if (p === "local") void patch({ voiceProvider: p });
    else {
      const cloudProvider = p as CloudVoiceProvider;
      void patch({
        voiceProvider: cloudProvider,
        voiceModel: resolveCloudVoiceModel(cloudProvider, undefined),
      });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <FieldSet title="Voice Input">
        <Field
          label="Provider"
          description={
            provider === "local"
              ? "Transcribes on this Mac after an on-device model is downloaded."
              : `Sends recordings to ${provider === "openai" ? "OpenAI" : "Google"} for transcription.`
          }
        >
          <Select value={provider} onValueChange={changeProvider}>
            <SelectTrigger size="small">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="gemini">Google Gemini</SelectItem>
              <SelectItem value="local">On-device (Parakeet)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {isCloud ? (
          <Field label="Model" description="Used for microphone input and the dictation shortcut.">
            <Select value={model} onValueChange={(v) => void patch({ voiceModel: v })}>
              <SelectTrigger size="small">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLOUD_VOICE_MODELS[provider].map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
      </FieldSet>

      {provider === "local" ? <LocalVoiceSettings /> : null}
      <DictationShortcutSettings />
    </div>
  );
}
