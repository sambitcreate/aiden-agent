// IPC channel allowlists shared between the preload bridge and contract tests.
//
// Kept dependency-free (no Electron import) so it can be imported from both the
// preload entry point and node:test contract guards. The preload bridge enforces
// these at runtime; main/handlers/ipc-contract.test.ts enforces them statically.

export const INVOKE_PREFIXES = [
  "analytics:",
  "app:",
  "assistant-live:",
  "attachments:",
  "bots:",
  "botComputers:",
  "browser:",
  "chat:",
  "devices:",
  "chats:",
  "computerUse:",
  "designCanvas:",
  "dictation:",
  "diagnostics:",
  "formFill:",
  "git:",
  "hooks:",
  "imageGeneration:",
  "imageWorkflows:",
  "localModels:",
  "localVoice:",
  "mcp:",
  "models:",
  "providers:",
  "profile:",
  "pullRequests:",
  "quickChat:",
  "remote:",
  "runs:",
  "schedule:",
  "settings:",
  "shortcut:",
  "skills:",
  "storage:",
  "telegram:",
  "subagents:",
  "terminal:",
  "titleProviders:",
  "tts:",
  "usage:",
  "usageLimits:",
  "spending:",
  "voice:",
  "webSearch:",
  "workspaces:",
] as const;

export const NATIVE_INVOKE_CHANNELS = {
  accessibilityOpenSettings: "aiden:accessibility:open-settings",
  accessibilityRequest: "aiden:accessibility:request",
  accessibilityStatus: "aiden:accessibility:status",
  attachmentDroppedRead: "aiden:attachments:dropped-read",
  attachmentClipboardRead: "aiden:attachments:clipboard-read",
  themeGet: "aiden:theme:get",
  themeSet: "aiden:theme:set",
  mediaStatus: "aiden:media:status",
  mediaRequest: "aiden:media:request",
} as const;

export const NOTIFICATION_CHANNEL_VALUES = [
  "settings:controls-changed",
  "chat:approvalRules:changed",
  "app:config-externally-changed",
  "app:command",
  "app:navigate",
  "app:update-state",
  /** The main window's maximize or full-screen state changed: `WindowControlsState`. Linux Aiden title bar only. */
  "app:window-state",
  "assistant-live:event",
  "chat:approval",
  "chat:artifact",
  "chat:context-pressure",
  "chat:delta",
  "chat:done",
  "chat:error",
  "chat:guidance-returned",
  "chat:questionnaire",
  "chat:reasoning-delta",
  "chat:status",
  "chat:subagent-context",
  /** One helper's conversation changed: `{streamId, update}` (see `subagent-transcript.ts`). */
  "chat:subagent-transcript",
  "chat:subagents",
  "chat:timeline",
  "chat:todo",
  "chat:tool",
  /** Crash reporting started or stopped: `{sending}`. Raw error fields go to main only while it is on. */
  "analytics:sending-changed",
  "bots:changed",
  "bots:memory:changed",
  /** A Bot's event routines changed, or a watch saved a check: `{botId}`. Its profile re-reads the list. */
  "bots:eventRoutines:changed",
  "bots:connectorWatches:changed",
  "bots:openWork:changed",
  /** Pair decisions or exchange state changed: `{botId}`. Read current owner metadata. */
  "bots:peers:changed",
  /** A paired phone asked to finish connecting an app for a Bot: `{botId, pluginId}`. */
  "bots:live:event",
  "bots:connections:setup",
  "bots:approval",
  "bots:approval-settled",
  /** A Bot's question, approval, hand-off or issue appeared or settled: `{botId}`. The Bots sidebar re-reads its row. */
  "bots:attention",
  /** Bot bubbles changed: the full `BotBubbleState`. */
  "bots:bubbles:changed",
  /** Open in Aiden from a bubble: `{botId}`, show that Bot's chat. */
  "bots:bubbles:showChat",
  /** A shrink or grow animation for a bubble overlay (`BotBubbleTransition`); the overlay's own preload receives it. */
  "bots:bubbles:transition",
  /** A bubble overlay's display changed size or zoom (`BotBubbleOverlayInfo`); the overlay's own preload receives it. */
  "bots:bubbles:overlayInfoChanged",
  "botComputers:changed",
  "browser:event",
  "devices:state",
  "devices:reveal",
  "devices:trackpad-scroll-end",
  "devices:recordings",
  "chats:activity-changed",
  "chats:read-markers-changed",
  /** Inbox Pin, Done or Snooze changed: the full triage snapshot. */
  "chats:triage-changed",
  "chats:changed",
  "chats:metadata-updated",
  /** A chat's design mode changed: `{chatId, designMode}`. */
  "chats:design-mode-changed",
  /** A chat's design canvas was saved or edited by Aiden: `{chatId, revision}`. */
  "designCanvas:updated",
  /** Workspace files a chat's design canvas shows changed: `{chatId, paths}`. */
  "designCanvas:filesChanged",
  /** Aiden asks to enter design mode; the turn's window shows a card: `{requestId, chatId, reason}`. */
  "designCanvas:consent",
  /** That card stopped waiting (answered, stopped or timed out): `{requestId}`. */
  "designCanvas:consentClosed",
  /** Aiden asks the canvas to fit frames (all when empty): `{chatId, frameIds}`. */
  "designCanvas:focus",
  /** Aiden asks for a picture of the canvas: `{requestId, chatId}`; answered with `designCanvas:snapshotAnswer`. */
  "designCanvas:snapshot",
  "chats:fork-summary-changed",
  "chats:btw-event",
  "chats:pull-requests-changed",
  /**
   * A chat's background jobs, followed pull requests or done-when check changed: `{chatId}`.
   * `transcript: true` means a follow-up notice was also saved into its messages.
   */
  "chats:follow-through-changed",
  /** A chat's keep-going goal changed: `{chatId, goal}` (the goal's view, or null once cleared). */
  "chats:goal-changed",
  "chats:goal-window-round",
  "chats:goal-proposal-changed",
  /** A lead chat's started chats changed (Phase 5): `{leadChatId}`. */
  "chats:child-chats-changed",
  "chats:settled",
  "git:changed",
  "imageWorkflows:run-changed",
  "dictation:state",
  "formFill:progress",
  "localModels:progress",
  "localVoice:state",
  /** Live per-server MCP connection status for Settings (`McpLiveStatus`). */
  "mcp:statusChanged",
  "providers:auth:done",
  "providers:auth:error",
  "providers:auth:event",
  "providers:auth:prompt",
  "providers:auth:status-changed",
  "providers:harness:changed",
  "quickChat:opened",
  "quickChat:hidden",
  "quickChat:handoff-complete",
  "remote:changed",
  "remote:peers-changed",
  "remote:approval-changed",
  "remote:host-feed",
  "remote:peer-run-frame",
  "remote:peer-bot-session",
  "runs:local-frame",
  "remote:peer-host-state",
  "remote:pairing-requests-changed",
  "remote:peer-discovery",
  "remote:peer-pairing-progress",
  "schedule:updated",
  /** What keeps the computer awake changed: `KeepAwakeStatus`. */
  "schedule:keep-awake-changed",
  "settings:appearance-changed",
  "settings:new-chat-model-changed",
  "shortcut:changed",
  "terminal:activity",
  "terminal:data",
  "terminal:exit",
  "telegram:model-selection-changed",
  "tts:event",
  /** Settings → Storage's background scan started or finished: `{ kind }`. */
  "storage:changed",
  /** The replies waiting for a usage limit changed: `UsageLimitsChangedEvent`. */
  "usageLimits:changed",
  "spending:changed",
  /** Hooks, hook proposals, a hook run or an auto-disable changed: `HooksChangedEvent`. */
  "hooks:changed",
  "voice:stream-text",
  "workspaces:changed",
  /** An agent tool may have changed files in this workspace's folder: `{ workspaceId }`. */
  "workspace:files-touched",
  /** A workspace artifact was created, changed, refreshed or deleted: `WorkspaceArtifactsChangedEvent`. */
  "workspaces:artifacts-changed",
  /** Progress for a clone, sent only to the document that started it: `WorkspaceCloneProgress`. */
  "workspaces:clone-progress",
  /** New-worktree progress for a first send, sent only to the sending document: `FirstMessageWorktreeProgress`. */
  "chats:first-message-worktree-progress",
  "aiden:theme:changed",
] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNEL_VALUES)[number];

export const NOTIFICATION_CHANNELS: ReadonlySet<string> = new Set(NOTIFICATION_CHANNEL_VALUES);
