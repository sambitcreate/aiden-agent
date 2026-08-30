// Voice settings — transcription provider for the composer's mic button and the
// dictation hotkey. Cloud providers (OpenAI / Gemini) reuse the keys configured
// under Providers; "On-device" runs Parakeet locally (managed below).

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Field,
  FieldSet,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  toast,
} from "../ui";
import { settingsApi } from "../../lib/ipc";
import { queryKeys, useProviders, useSettings } from "../../lib/queries";
import type { GeminiUsageScope, VoiceProvider } from "../../lib/types";
import { GOOGLE_PROVIDER_ID } from "../../shared/google-provider";
import { defaultGeminiUsageScope } from "../../shared/gemini-usage-scope";
import {
  CLOUD_VOICE_MODELS,
  resolveCloudVoiceModel,
  type CloudVoiceProvider,
} from "../../shared/voice-models";
import { DictationShortcutSettings } from "./dictation-shortcut-settings";
import { BuiltinProviderEditor } from "./builtin-provider-editor";
import { GeminiVoiceSetupDialog } from "./gemini-voice-setup-dialog";
import { LocalVoiceSettings } from "./local-voice-settings";

export function VoiceSettings() {
  const qc = useQueryClient();
  const settings = useSettings();
  const providers = useProviders();
  const googleProvider = providers.data?.find((candidate) => candidate.id === GOOGLE_PROVIDER_ID);
  const provider: VoiceProvider = settings.data?.voiceProvider ?? "openai";
  const isCloud = provider === "openai" || provider === "gemini";
  const model = isCloud ? resolveCloudVoiceModel(provider, settings.data?.voiceModel) : "";
  const [geminiDialogOpen, setGeminiDialogOpen] = React.useState(false);
  const [geminiAuthOpen, setGeminiAuthOpen] = React.useState(false);
  const [geminiScope, setGeminiScope] = React.useState<GeminiUsageScope>("transcription_only");
  const [geminiBusy, setGeminiBusy] = React.useState(false);
  const [geminiError, setGeminiError] = React.useState<string | null>(null);

  const patch = async (next: { voiceProvider?: VoiceProvider; voiceModel?: string }) => {
    await settingsApi.set(next);
    await qc.invalidateQueries({ queryKey: queryKeys.settings });
  };

  const openGeminiSetup = () => {
    setGeminiScope(
      defaultGeminiUsageScope(settings.data?.geminiUsageScope, googleProvider?.hasKey === true),
    );
    setGeminiError(null);
    setGeminiDialogOpen(true);
  };

  const saveGeminiSetup = async () => {
    const saved = await settingsApi.setGeminiVoiceSetup(
      geminiScope,
      resolveCloudVoiceModel("gemini", undefined),
    );
    qc.setQueryData(queryKeys.settings, saved);
    await qc.invalidateQueries({ queryKey: queryKeys.providers });
  };

  const confirmGeminiSetup = async () => {
    if (!googleProvider) {
      setGeminiError("Google provider details are not available yet. Try again in a moment.");
      return;
    }
    if (!googleProvider.hasKey) {
      setGeminiDialogOpen(false);
      setGeminiAuthOpen(true);
      return;
    }
    setGeminiBusy(true);
    setGeminiError(null);
    try {
      await saveGeminiSetup();
      setGeminiDialogOpen(false);
      toast.success("Gemini voice is ready.");
    } catch (error) {
      setGeminiError(error instanceof Error ? error.message : "Couldn't save Gemini voice setup.");
    } finally {
      setGeminiBusy(false);
    }
  };

  const manageGeminiCredential = () => {
    if (!googleProvider) return;
    setGeminiDialogOpen(false);
    setGeminiAuthOpen(true);
  };

  const changeProvider = (value: string) => {
    const p = value as VoiceProvider;
    if (p === "gemini") {
      openGeminiSetup();
      return;
    }
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
              ? "Transcribes on this device after an on-device model is downloaded."
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
          {provider === "gemini" ? (
            <div className="mt-2 flex items-center gap-2">
              <Button variant="transparent" size="small" onClick={openGeminiSetup}>
                Privacy & access
              </Button>
              <Text variant="small" color="tertiary">
                {settings.data?.geminiUsageScope === "transcription_only"
                  ? "Transcription only"
                  : "Models + transcription"}
              </Text>
            </div>
          ) : null}
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

      <GeminiVoiceSetupDialog
        open={geminiDialogOpen}
        scope={geminiScope}
        hasKey={googleProvider?.hasKey === true}
        busy={geminiBusy}
        error={geminiError}
        onScopeChange={setGeminiScope}
        onOpenChange={(open) => {
          if (!geminiBusy) {
            setGeminiDialogOpen(open);
            if (!open) setGeminiError(null);
          }
        }}
        onConfirm={confirmGeminiSetup}
        onManageCredential={googleProvider?.hasKey ? manageGeminiCredential : undefined}
      />
      {googleProvider ? (
        <BuiltinProviderEditor
          provider={googleProvider}
          open={geminiAuthOpen}
          requireChatModel={false}
          onOpenChange={(open) => setGeminiAuthOpen(open)}
          onSaved={async () => {
            await saveGeminiSetup();
            await qc.invalidateQueries({ queryKey: queryKeys.providers });
            toast.success("Gemini voice is ready.");
          }}
        />
      ) : null}
    </div>
  );
}
