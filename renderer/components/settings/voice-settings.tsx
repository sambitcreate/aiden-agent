// Voice settings — transcription provider for the composer's mic button and the
// dictation hotkey. Cloud providers (OpenAI / Gemini) reuse the keys configured
// under Providers; "On-device" runs a downloaded model locally (managed below).
// "Automatic" (no explicit choice) prefers an installed on-device model, then a
// configured cloud provider. Language and translation apply to whichever
// provider dictation resolves to.

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
  Switch,
  Text,
  toast,
} from "../ui";
import { useAppCapabilities } from "../../lib/app-capabilities";
import { settingsApi } from "../../lib/ipc";
import {
  queryKeys,
  useLocalModels,
  useProviders,
  useSettings,
  useVoiceResolution,
} from "../../lib/queries";
import type { GeminiUsageScope, LocalVoiceModel, VoiceProvider } from "../../lib/types";
import { GOOGLE_PROVIDER_ID } from "../../shared/google-provider";
import { defaultGeminiUsageScope } from "../../shared/gemini-usage-scope";
import {
  CLOUD_VOICE_MODELS,
  resolveCloudVoiceModel,
  type CloudVoiceProvider,
} from "../../shared/voice-models";
import { DictationShortcutSettings } from "./dictation-shortcut-settings";
import { DictationDictionarySettings } from "./dictation-dictionary-settings";
import { BuiltinProviderEditor } from "./builtin-provider-editor";
import { GeminiVoiceSetupDialog } from "./gemini-voice-setup-dialog";
import { LocalVoiceSettings } from "./local-voice-settings";
import { automaticVoiceCaption, effectiveLocalModelId } from "../../shared/voice-provider";
import { effectiveLanguage, normalizeLanguageIntent } from "../../shared/voice-language";

const AUTOMATIC = "automatic";
const AUTO_LANGUAGE = "auto";
/** Languages offered for cloud transcription; both providers detect others. */
const CLOUD_LANGUAGES = [
  "en", "es", "fr", "de", "it", "pt", "nl", "ja", "ko", "zh", "hi", "ar", "ru", "pl", "tr", "uk", "sv",
] as const;

let languageNames: Intl.DisplayNames | null | undefined;

function languageName(code: string): string {
  if (languageNames === undefined) {
    try {
      languageNames = new Intl.DisplayNames(["en"], { type: "language" });
    } catch {
      languageNames = null;
    }
  }
  try {
    return languageNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Caption shown when the chosen language isn't one the active model can hear. */
function languageFallbackCaption(model: LocalVoiceModel, intent: string): string | null {
  const { fallback } = effectiveLanguage(model, intent);
  if (fallback === null) return null;
  const using = fallback === AUTO_LANGUAGE ? "automatic detection" : languageName(fallback);
  return `${model.name} doesn't support ${languageName(intent)}. Using ${using}.`;
}

export function VoiceSettings() {
  return (
    <div className="flex flex-col gap-6">
      <VoiceInputSettings />
      <DictationShortcutSettings />
      <DictationDictionarySettings />
    </div>
  );
}

/** Provider, language and translation rows, plus the on-device engine when it applies. */
export function VoiceInputSettings() {
  const { platform } = useAppCapabilities();
  const qc = useQueryClient();
  const settings = useSettings();
  const providers = useProviders();
  const googleProvider = providers.data?.find((candidate) => candidate.id === GOOGLE_PROVIDER_ID);
  const localModels = useLocalModels();
  const explicit = settings.data?.voiceProvider;
  const installedModels = (localModels.data ?? []).filter((candidate) => candidate.installed);
  const resolution = useVoiceResolution([
    explicit ?? AUTOMATIC,
    settings.data?.localVoiceModel ?? "",
    settings.data?.geminiUsageScope ?? "",
    installedModels.map((candidate) => candidate.id).join(","),
    providers.data?.find((candidate) => candidate.id === "openai")?.hasKey === true,
    googleProvider?.hasKey === true,
  ]);
  const resolved = resolution.data?.kind === "ready" ? resolution.data.provider : undefined;
  // What dictation uses now: the explicit choice, else the automatic answer.
  const provider: VoiceProvider | undefined = explicit ?? resolved;
  const isCloud = provider === "openai" || provider === "gemini";
  const automaticCaption =
    explicit === undefined && resolution.data
      ? automaticVoiceCaption(
          resolution.data,
          (id) => localModels.data?.find((candidate) => candidate.id === id)?.name,
        )
      : null;
  const model = isCloud ? resolveCloudVoiceModel(provider, settings.data?.voiceModel) : "";
  // The on-device model dictation uses now: the resolved one, else the chosen or first installed.
  const activeLocalId =
    provider !== "local"
      ? undefined
      : resolution.data?.kind === "ready" && resolution.data.provider === "local"
        ? resolution.data.modelId
        : effectiveLocalModelId(
            settings.data?.localVoiceModel,
            installedModels.map((candidate) => candidate.id),
          );
  const activeLocal = installedModels.find((candidate) => candidate.id === activeLocalId);
  const language = normalizeLanguageIntent(settings.data?.voiceLanguage) ?? AUTO_LANGUAGE;
  const offeredLanguages: readonly string[] = activeLocal ? activeLocal.languages : CLOUD_LANGUAGES;
  const languageChoices =
    language === AUTO_LANGUAGE || offeredLanguages.includes(language)
      ? offeredLanguages
      : [...offeredLanguages, language];
  const languageCaption =
    activeLocal && language !== AUTO_LANGUAGE ? languageFallbackCaption(activeLocal, language) : null;
  const canTranslate = activeLocal?.capabilities.translateToEnglish === true;
  const [geminiDialogOpen, setGeminiDialogOpen] = React.useState(false);
  const [geminiAuthOpen, setGeminiAuthOpen] = React.useState(false);
  const [geminiScope, setGeminiScope] = React.useState<GeminiUsageScope>("transcription_only");
  const [geminiBusy, setGeminiBusy] = React.useState(false);
  const [geminiError, setGeminiError] = React.useState<string | null>(null);

  const patch = async (next: {
    voiceProvider?: VoiceProvider | null;
    voiceModel?: string;
    voiceLanguage?: string;
    voiceTranslateToEnglish?: boolean;
  }) => {
    await settingsApi.set(next);
    await qc.invalidateQueries({ queryKey: queryKeys.settings });
    await qc.invalidateQueries({ queryKey: queryKeys.voiceResolution });
  };

  /** Saves one voice preference, telling the user when it didn't stick. */
  const savePreference = async (next: Parameters<typeof patch>[0], failure: string) => {
    try {
      await patch(next);
    } catch {
      toast.error(failure);
    }
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
    await qc.invalidateQueries({ queryKey: queryKeys.voiceResolution });
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
    const failure = "Aiden couldn’t change where your voice is processed.";
    if (value === AUTOMATIC) {
      void savePreference({ voiceProvider: null }, failure);
      return;
    }
    const p = value as VoiceProvider;
    if (p === "gemini") {
      openGeminiSetup();
      return;
    }
    if (p === "local") void savePreference({ voiceProvider: p }, failure);
    else {
      const cloudProvider = p as CloudVoiceProvider;
      void savePreference(
        { voiceProvider: cloudProvider, voiceModel: resolveCloudVoiceModel(cloudProvider, undefined) },
        failure,
      );
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <FieldSet title="Use your voice">
        <Field
          label="Where should your voice be processed?"
          description={
            explicit === undefined
              ? "Uses a downloaded on-device model when there is one, otherwise a cloud provider you have set up."
              : explicit === "local"
                ? "Transcribes on this device after an on-device model is downloaded."
                : `Sends recordings to ${explicit === "openai" ? "OpenAI" : "Google"} for transcription.`
          }
        >
          <div className="flex w-full flex-col">
            <Select value={explicit ?? AUTOMATIC} onValueChange={changeProvider}>
              <SelectTrigger size="small" aria-label="Voice provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTOMATIC}>Automatic</SelectItem>
                <SelectItem value="local">{platform === "darwin" ? "On this Mac · Private" : "On this device · Private"}</SelectItem>
                <SelectItem value="openai">Online · OpenAI</SelectItem>
                <SelectItem value="gemini">Online · Google Gemini</SelectItem>
              </SelectContent>
            </Select>
            {automaticCaption ? (
              <Text as="p" variant="small" color="tertiary" className="mt-2">
                {automaticCaption}
              </Text>
            ) : null}
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
          </div>
        </Field>
        <Field
          label="Language"
          description={
            activeLocal
              ? `The language you speak. Automatic lets ${activeLocal.name} decide.`
              : "The language you speak. Automatic lets the provider detect it."
          }
        >
          <div className="flex w-full flex-col">
            <Select
              value={language}
              onValueChange={(value) =>
                void savePreference({ voiceLanguage: value }, "Aiden couldn’t change the voice language.")
              }
            >
              <SelectTrigger size="small" aria-label="Language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO_LANGUAGE}>Automatic</SelectItem>
                {languageChoices.map((code) => (
                  <SelectItem key={code} value={code}>
                    {languageName(code)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {languageCaption ? (
              <Text as="p" variant="small" color="tertiary" className="mt-2">
                {languageCaption}
              </Text>
            ) : null}
          </div>
        </Field>
        {canTranslate ? (
          <Field
            label="Translate to English"
            description="Writes what you say in other languages as English text."
          >
            <Switch
              aria-label="Translate to English"
              checked={settings.data?.voiceTranslateToEnglish === true}
              onCheckedChange={(value) =>
                void savePreference(
                  { voiceTranslateToEnglish: value },
                  "Aiden couldn’t change translation to English.",
                )
              }
            />
          </Field>
        ) : null}
        {isCloud ? (
          <Field label="Model" description="Used for microphone input and the dictation shortcut.">
            <Select
              value={model}
              onValueChange={(v) =>
                void savePreference({ voiceModel: v }, "Aiden couldn’t change the transcription model.")
              }
            >
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

      {explicit === "local" || explicit === undefined ? <LocalVoiceSettings /> : null}

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
