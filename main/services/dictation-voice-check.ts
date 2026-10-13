// The dictation hotkey's provider check and warm-up share one resolution per
// press, so warm-up preloads exactly the on-device model that press resolved.

import { voiceSetupMessage, type VoiceProviderResolution } from "../../renderer/shared/voice-provider.js";
import type { VoiceResolutionCheck } from "./dictation-coordinator.js";

export interface PressVoiceCheckDeps {
  resolve(): Promise<VoiceProviderResolution>;
  warmLocal(modelId: string): Promise<void>;
}

export function createPressVoiceCheck(deps: PressVoiceCheckDeps): {
  resolveVoice(): Promise<VoiceResolutionCheck>;
  warmUp(): Promise<void>;
} {
  let pressResolution: VoiceProviderResolution | null = null;
  return {
    resolveVoice: async () => {
      // A failed resolution must never reuse the previous press's answer.
      pressResolution = null;
      const resolution = await deps.resolve();
      pressResolution = resolution;
      return resolution.kind === "ready"
        ? { ok: true }
        : { ok: false, message: voiceSetupMessage(resolution.reason) };
    },
    warmUp: async () => {
      const resolution = pressResolution;
      if (resolution?.kind !== "ready" || resolution.provider !== "local") return;
      await deps.warmLocal(resolution.modelId);
    },
  };
}
