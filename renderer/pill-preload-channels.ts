export const PILL_INVOKE_CHANNELS = new Set([
  "dictation:cancel",
  "dictation:error",
  "dictation:ready",
  "dictation:result",
  "dictation:stop",
  "settings:get",
  "settings:getAppearance",
  "voice:transcribe",
  "voice:transcribeLocal",
  "voice:streamStart",
  "voice:streamPush",
  "voice:streamFinish",
  "voice:streamCancel",
]);

export const PILL_NOTIFICATION_CHANNELS = new Set([
  "dictation:state",
  "settings:appearance-changed",
  "voice:stream-text",
]);
