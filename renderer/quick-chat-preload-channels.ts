// Least-privilege IPC channel allowlists for the Floating Chat Starter
// (Quick Chat) window preload (`renderer/preload-quick-chat.ts`).
//
// Kept dependency-free (no Electron import) so it can be imported from both
// the preload bundle and main-process broadcast / contract tests.

export const QUICK_CHAT_INVOKE_CHANNELS = new Set([
  // Quick chat window lifecycle & handoff
  "quickChat:hide",
  "quickChat:setMode",
  "quickChat:suppressBlur",
  "quickChat:expandToMain",
  "quickChat:openSettings",

  // App metadata & read-only settings / shortcuts
  "app:getInfo",
  "settings:get",
  "settings:getAppearance",
  // The Agent Slider in the composer popover: the first-run seed and a
  // stop's reassignment (portable config.json only, never settings:set).
  "settings:setAgentSlider",
  "settings:seedAgentSlider",
  "shortcut:get",

  // Providers & models (read-only for ModelPicker + runtime)
  "providers:list",
  "models:info",
  "modelPace:summaries",
  "modelInsights:status",

  // Workspaces (list, isolated scratch folder, folder presence, attach / open folder)
  "workspaces:list",
  "workspaces:createNoWorkspace",
  "workspaces:createFromFolder",
  "workspaces:folderPresence",

  // Chat lifecycle, ephemeral promotion & attach-to-workspace
  "chats:get",
  "chats:createWithFirstMessage",
  "chats:appendMessage",
  "chats:remove",
  "chats:promoteEphemeral",
  "chats:inspectAttachFiles",
  "chats:attachToWorkspace",

  // Active generation stream, approvals, questions & mid-turn input
  "chat:start",
  "chat:cancel",
  "chat:approve",
  "chat:answerQuestionnaire",
  "chat:admitRunInput",

  // Attachments picker (+ button)
  "attachments:pickAndRead",

  // Voice recording (mic button inside floating composer)
  "voice:resolveProvider",
  "voice:transcribe",
  "voice:transcribeCancel",
  "voice:transcribeLocal",
  "voice:transcribeLocalCancel",
  "voice:localLiveStart",
  "voice:localLivePush",
  "voice:localLiveStop",
  "voice:streamStart",
  "voice:streamPush",
  "voice:streamFinish",
  "voice:streamCancel",
  "localVoice:status",
  "localVoice:warm",
]);

export const QUICK_CHAT_NOTIFICATION_CHANNELS = new Set([
  // Quick chat lifecycle
  "quickChat:opened",
  "quickChat:hidden",
  "quickChat:handoff-complete",

  // Appearance & settings sync
  "settings:appearance-changed",
  "settings:controls-changed",
  // ~/.aiden/config.json changed outside the app: the Agent Slider may have.
  "app:config-externally-changed",
  "aiden:theme:changed",

  // Active generation stream notifications
  "chat:delta",
  "chat:reasoning-delta",
  "chat:status",
  "chat:context-pressure",
  "chat:artifact",
  "chat:subagents",
  "chat:timeline",
  "chat:tool",
  "chat:approval",
  "chat:questionnaire",
  "chat:todo",
  "chat:done",
  "chat:error",
  "chat:guidance-returned",
  "chats:metadata-updated",

  // Voice notifications
  "voice:stream-text",
  "localVoice:state",
]);
