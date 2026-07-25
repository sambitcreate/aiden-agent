// IPC channel allowlists shared between the preload bridge and contract tests.
//
// Kept dependency-free (no Electron import) so it can be imported from both the
// preload entry point and node:test contract guards. The preload bridge enforces
// these at runtime; main/handlers/ipc-contract.test.ts enforces them statically.

export const INVOKE_PREFIXES = [
  "app:",
  "artificialAnalysis:",
  "attachments:",
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
  "schedule:",
  "settings:",
  "shortcut:",
  "skills:",
  "terminal:",
  "titleProviders:",
  "usage:",
  "voice:",
  "workspaces:",
] as const;

export const NATIVE_INVOKE_CHANNELS = {
  accessibilityRequest: "aiden:accessibility:request",
  accessibilityStatus: "aiden:accessibility:status",
  dialogOpen: "aiden:dialog:open",
  themeGet: "aiden:theme:get",
  themeSet: "aiden:theme:set",
  mediaStatus: "aiden:media:status",
  mediaRequest: "aiden:media:request",
} as const;

export const NOTIFICATION_CHANNEL_VALUES = [
  "app:focus-composer",
  "app:navigate",
  "app:open-workspace-preferred-editor",
  "chat:approval",
  "chat:delta",
  "chat:done",
  "chat:error",
  "chat:reasoning-delta",
  "chat:status",
  "chat:timeline",
  "chat:tool",
  "chats:metadata-updated",
  "dictation:state",
  "localModels:progress",
  "providers:auth:done",
  "providers:auth:error",
  "providers:auth:event",
  "providers:auth:prompt",
  "providers:auth:status-changed",
  "schedule:updated",
  "terminal:data",
  "terminal:exit",
  "aiden:theme:changed",
] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNEL_VALUES)[number];

export const NOTIFICATION_CHANNELS: ReadonlySet<string> = new Set(NOTIFICATION_CHANNEL_VALUES);
