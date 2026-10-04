// Settings, voice and dictation IPC wrappers shared by the main window and the
// dictation pill. Type-only imports keep this module parser-free so the pill
// chunk does not pull in the rest of `ipc.ts`.

import type { AppSettings } from "./types";
import type { AnthropicThinkingLevel } from "../shared/anthropic-thinking";
import type { GoogleThinkingLevel } from "../shared/google-thinking";
import type { CodexThinkingLevel } from "../shared/codex-thinking";
import type { AppearanceConfig, AppearancePreviewSnapshot } from "../shared/appearance";
import { invoke, onNotification } from "./ipc-bridge";

export const settingsApi = {
  get: () => invoke<AppSettings>("settings:get"),
  getAppearance: () => invoke<AppearanceConfig>("settings:getAppearance"),
  getAppearanceState: () => invoke<AppearancePreviewSnapshot>("settings:getAppearanceState"),
  previewAppearance: (appearance: AppearanceConfig) =>
    invoke<AppearanceConfig>("settings:previewAppearance", appearance),
  set: (patch: Partial<AppSettings>) => invoke<AppSettings>("settings:set", patch),
  setGeminiVoiceSetup: (scope: NonNullable<AppSettings["geminiUsageScope"]>, model: string) =>
    invoke<AppSettings>("settings:setGeminiVoiceSetup", scope, model),
  setGeminiUsageScope: (scope: NonNullable<AppSettings["geminiUsageScope"]>) =>
    invoke<AppSettings>("settings:setGeminiUsageScope", scope),
  setGoogleThinking: (modelId: string, level: GoogleThinkingLevel) =>
    invoke<AppSettings>("settings:setGoogleThinking", modelId, level),
  setCodexThinking: (modelId: string, level: CodexThinkingLevel) =>
    invoke<AppSettings>("settings:setCodexThinking", modelId, level),
  setAnthropicThinking: (modelId: string, level: AnthropicThinkingLevel) =>
    invoke<AppSettings>("settings:setAnthropicThinking", modelId, level),
  setProviderThinking: (
    providerId: string,
    modelId: string,
    level: import("../shared/generation-thinking").GenerationThinkingLevel,
  ) => invoke<AppSettings>("settings:setProviderThinking", providerId, modelId, level),
  setModelVisibility: (providerId: string, modelId: string, hidden: boolean) =>
    invoke<AppSettings>("settings:setModelVisibility", providerId, modelId, hidden),
  showAllProviderModels: (providerId: string) =>
    invoke<AppSettings>("settings:showAllProviderModels", providerId),
  hideAllProviderModels: (providerId: string) =>
    invoke<AppSettings>("settings:hideAllProviderModels", providerId),
};

export const voiceApi = {
  transcribe: (audioBase64: string, mimeType: string, model?: string, operationId?: string) =>
    invoke<string>("voice:transcribe", audioBase64, mimeType, model, operationId),
  cancelTranscription: (operationId: string) => invoke<void>("voice:transcribeCancel", operationId),
  /** On-device transcription: base64 raw 16 kHz mono Float32 PCM + downloaded model id. */
  transcribeLocal: (pcmBase64: string, modelId: string, operationId: string) =>
    invoke<string>("voice:transcribeLocal", pcmBase64, modelId, operationId),
  cancelLocalTranscription: (operationId: string) =>
    invoke<void>("voice:transcribeLocalCancel", operationId),
  streamStart: () => invoke<{ sessionId: string }>("voice:streamStart"),
  streamPush: (sessionId: string, pcmBase64: string) =>
    invoke<void>("voice:streamPush", sessionId, pcmBase64),
  streamFinish: (sessionId: string) => invoke<string>("voice:streamFinish", sessionId),
  streamCancel: (sessionId: string) => invoke<void>("voice:streamCancel", sessionId),
  onStreamText: (
    handler: (payload: { sessionId: string; committed: string; tentative: string }) => void,
  ) => onNotification("voice:stream-text", handler),
};

// ── Global dictation (pill + auto-paste) ──────────────────────────────
export const dictationApi = {
  /** Pill reports the finished transcript to the main-process coordinator. */
  reportResult: (operationId: string, text: string) =>
    invoke<void>("dictation:result", operationId, text),
  /** Pill reports a capture/transcription failure. */
  reportError: (operationId: string, message: string) =>
    invoke<void>("dictation:error", operationId, message),
  /** Pill reports finalization/consent/fallback progress for accurate UI and diagnostics. */
  reportProgress: (operationId: string, progress: "finalizing" | "fallback-consent" | "fallback") =>
    invoke<void>("dictation:progress", operationId, progress),
  /** Pill cancel button: discard the in-flight recording/transcription. */
  cancel: () => invoke<void>("dictation:cancel"),
  /** Pill renderer is mounted and subscribed to dictation state broadcasts. */
  ready: () => invoke<void>("dictation:ready"),
  /** Silence detector or UI asked to end capture without cancelling. */
  stopRecording: () => invoke<void>("dictation:stop"),
};
