// IPC channel allowlists shared between the preload bridge and contract tests.
//
// Kept dependency-free (no Electron import) so it can be imported from both the
// preload entry point and node:test contract guards. The preload bridge enforces
// these at runtime; main/handlers/ipc-contract.test.ts enforces them statically.

export const INVOKE_PREFIXES = [
  "app:",
  "artificialAnalysis:",
  "assistant:",
  "attachments:",
  "bots:",
  "chat:",
  "chats:",
  "computerUse:",
  "devlog:",
  "dictation:",
  "exa:",
  "git:",
  "localModels:",
  "localVoice:",
  "mcp:",
  "models:",
  "providers:",
  "profile:",
  "remote:",
  "schedule:",
  "settings:",
  "shortcut:",
  "skills:",
  "telegram:",
  "subagents:",
  "terminal:",
  "titleProviders:",
  "usage:",
  "voice:",
  "workspaces:",
] as const;

export const NATIVE_INVOKE_CHANNELS = {
  accessibilityRequest: "aiden:accessibility:request",
  accessibilityStatus: "aiden:accessibility:status",
  attachmentDroppedRead: "aiden:attachments:dropped-read",
  attachmentClipboardRead: "aiden:attachments:clipboard-read",
  dialogOpen: "aiden:dialog:open",
  themeGet: "aiden:theme:get",
  themeSet: "aiden:theme:set",
  mediaStatus: "aiden:media:status",
  mediaRequest: "aiden:media:request",
} as const;

export const NOTIFICATION_CHANNEL_VALUES = [
  "app:config-externally-changed",
  "app:command",
  "app:navigate",
  "app:update-state",
  "chat:approval",
  "chat:delta",
  "chat:done",
  "chat:error",
  "chat:reasoning-delta",
  "chat:status",
  "chat:subagents",
  "chat:timeline",
  "chat:tool",
  "chats:activity-changed",
  "chats:changed",
  "chats:metadata-updated",
  "chats:settled",
  "dictation:state",
  "localModels:progress",
  "providers:auth:done",
  "providers:auth:error",
  "providers:auth:event",
  "providers:auth:prompt",
  "providers:auth:status-changed",
  "remote:changed",
  "remote:approval-changed",
  "schedule:updated",
  "settings:appearance-changed",
  "shortcut:changed",
  "terminal:data",
  "terminal:exit",
  "telegram:model-selection-changed",
  "workspaces:changed",
  "aiden:theme:changed",
] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNEL_VALUES)[number];

export const NOTIFICATION_CHANNELS: ReadonlySet<string> = new Set(NOTIFICATION_CHANNEL_VALUES);
