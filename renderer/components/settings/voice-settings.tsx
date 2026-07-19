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
import { LocalVoiceSettings } from "./local-voice-settings";

const CLOUD_MODELS: Record<"openai" | "gemini", string[]> = {
  openai: ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
  gemini: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash"],
};

export function VoiceSettings() {
  const qc = useQueryClient();
  const settings = useSettings();
  const provider: VoiceProvider = settings.data?.voiceProvider ?? "openai";
  const isCloud = provider === "openai" || provider === "gemini";
  const model = settings.data?.voiceModel ?? (isCloud ? CLOUD_MODELS[provider][0] : "");

  const patch = async (next: { voiceProvider?: VoiceProvider; voiceModel?: string }) => {
    await settingsApi.set(next);
    await qc.invalidateQueries({ queryKey: queryKeys.settings });
  };

  const changeProvider = (value: string) => {
    const p = value as VoiceProvider;
    if (p === "local") void patch({ voiceProvider: p });
    else void patch({ voiceProvider: p, voiceModel: CLOUD_MODELS[p][0] });
  };

  return (
    <div className="flex flex-col gap-6">
      <FieldSet title="Voice Input">
        <Field
          label="Provider"
          description={provider === "local" ? "Transcribes on this Mac after an on-device model is downloaded." : `Sends recordings to ${provider === "openai" ? "OpenAI" : "Google"} for transcription.`}
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
                {CLOUD_MODELS[provider].map((m) => (
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
    </div>
  );
}
