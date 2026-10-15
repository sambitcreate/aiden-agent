export const PILL_INVOKE_CHANNELS = new Set([
  "dictation:cancel",
  "dictation:error",
  "dictation:progress",
  "dictation:ready",
  "dictation:result",
  "dictation:stop",
  "settings:get",
  "settings:getAppearance",
  "voice:resolveProvider",
  "voice:transcribe",
  "voice:transcribeCancel",
  "voice:transcribeLocal",
  "voice:transcribeLocalCancel",
  "voice:streamStart",
  "voice:streamPush",
  "voice:streamFinish",
  "voice:streamCancel",
]);

export const PILL_NOTIFICATION_CHANNELS = new Set([
  "dictation:state",
  "localVoice:state",
  "settings:appearance-changed",
  "voice:stream-text",
]);
