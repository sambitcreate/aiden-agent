// Local-first voice provider resolution. Pure: main gathers the inputs (key
// presence, installed models, engine health) so no secret reaches a renderer.

export type VoiceProviderResolution =
  | { kind: "ready"; provider: "local"; modelId: string; automatic: boolean }
  | { kind: "ready"; provider: "openai" | "gemini"; automatic: boolean }
  | { kind: "needs-setup"; reason: "no-local-model" | "no-provider" | "local-engine-unavailable" };

export type VoiceSetupReason = Extract<VoiceProviderResolution, { kind: "needs-setup" }>["reason"];

export interface VoiceProviderInputs {
  explicit: "openai" | "gemini" | "local" | undefined;
  localModelId: string | undefined;
  /** Installed on-device models in catalog order (recommended first). */
  installedLocalModels: readonly string[];
  engineReady: boolean;
  hasOpenAIKey: boolean;
  hasGeminiVoice: boolean;
}

/**
 * The on-device model dictation uses: the chosen one when installed, else the
 * first installed model in catalog order (the recommended model first).
 */
export function effectiveLocalModelId(
  localModelId: string | undefined,
  installedLocalModels: readonly string[],
): string | undefined {
  if (localModelId && installedLocalModels.includes(localModelId)) return localModelId;
  return installedLocalModels[0];
}

function chosenLocalModel(input: VoiceProviderInputs): string | undefined {
  return effectiveLocalModelId(input.localModelId, input.installedLocalModels);
}

export function resolveVoiceProvider(input: VoiceProviderInputs): VoiceProviderResolution {
  const localModel = chosenLocalModel(input);
  if (input.explicit === "openai" || input.explicit === "gemini") {
    // A cloud choice resolves even without a key so its own key error surfaces.
    return { kind: "ready", provider: input.explicit, automatic: false };
  }
  if (input.explicit === "local") {
    if (!localModel) return { kind: "needs-setup", reason: "no-local-model" };
    if (!input.engineReady) return { kind: "needs-setup", reason: "local-engine-unavailable" };
    return { kind: "ready", provider: "local", modelId: localModel, automatic: false };
  }
  if (localModel && input.engineReady) return { kind: "ready", provider: "local", modelId: localModel, automatic: true };
  if (input.hasOpenAIKey) return { kind: "ready", provider: "openai", automatic: true };
  if (input.hasGeminiVoice) return { kind: "ready", provider: "gemini", automatic: true };
  return { kind: "needs-setup", reason: "no-provider" };
}

export function voiceSetupMessage(reason: VoiceSetupReason): string {
  switch (reason) {
    case "no-local-model":
      return "Download a voice model in Settings → Voice.";
    case "no-provider":
      return "Set up a voice provider in Settings → Voice.";
    case "local-engine-unavailable":
      return "On-device voice couldn't start. Restart Aiden, or choose a cloud provider in Settings → Voice.";
  }
}

/** Settings caption for the Automatic choice: what dictation will use right now. */
export function automaticVoiceCaption(
  resolution: VoiceProviderResolution,
  localModelName: (modelId: string) => string | undefined,
): string {
  if (resolution.kind === "needs-setup") return voiceSetupMessage(resolution.reason);
  const label =
    resolution.provider === "local"
      ? `On-device (${localModelName(resolution.modelId) ?? resolution.modelId})`
      : resolution.provider === "openai"
        ? "OpenAI"
        : "Gemini";
  return `Automatic — using ${label}`;
}
