export const PILL_INVOKE_CHANNELS = new Set([
  "dictation:cancel",
  "dictation:error",
  "dictation:ready",
  "dictation:result",
  "settings:get",
  "voice:transcribe",
  "voice:transcribeLocal",
]);

export const PILL_NOTIFICATION_CHANNELS = new Set(["dictation:state"]);
