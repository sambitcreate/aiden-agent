// On-device model lifecycle broadcast on `localVoice:state`, shared by the
// speech host (main) and the pill and composer.

export interface LocalSpeechState {
  modelId: string;
  state: "loading" | "ready" | "failed" | "unloaded";
  error?: string;
}
