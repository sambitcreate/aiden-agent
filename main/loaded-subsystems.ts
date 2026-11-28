/**
 * Process-wide registry of loaded main-process subsystems.
 *
 * Subsystem modules call `registerLoadedSubsystem(...)` when evaluated (whether
 * loaded on demand via IPC, via an agent tool, or via deferred startup), so
 * `cleanupApplication()` and `runShutdownAndQuit()` in `main/index.ts` can tear
 * down every loaded subsystem while skipping subsystems that were never loaded
 * instead of importing them during quit.
 */

import type { llmClient } from "./services/llm-client.js";
import type { browserService } from "./services/browser/service.js";
import type { shutdownAntigravity } from "./services/antigravity/index.js";
import type { subagentRuntimeRegistry } from "./services/subagents/child-agent-runtime.js";
import type { subagentHealthMetrics } from "./services/subagents/subagent-health-metrics.js";
import type { flushPendingSubagentTranscripts } from "./services/subagents/subagent-supervisor-core.js";
import type { subagentRunStore } from "./services/subagents/subagent-run-store.js";
import type {
  aidenRemoteServiceKeepsApplicationAlive,
  stopAidenRemoteServiceAndSettle,
} from "./services/aiden-remote-service-main.js";
import type { geminiLiveService } from "./services/gemini-live/service-main.js";
import type { geminiLiveTranscription } from "./services/gemini-live-transcription.js";
import type { telegramService } from "./services/telegram/telegram-service.js";
import type {
  closeDeviceSessionsForChat,
  shutdownDevices,
  terminateDeviceHelperCommands,
} from "./handlers/devices.js";
import type { disposeWorkspaceGitWatchers } from "./handlers/workspaces.js";
import type { createImagesRuntime } from "./services/create-images/main.js";
import type {
  designCanvasStore,
  designFileWatcher,
  designModeConsent,
  recentWrittenPages,
} from "./services/design-canvas/main.js";
import type { forgetChatContextProfile } from "./services/context-pressure.js";
import type { mcpManager } from "./services/mcp.js";
import type { shutdownProviderAuthFlow } from "./services/provider-auth-flow.js";
import type { storageUsageService } from "./services/storage-usage-main.js";
import type { terminalService } from "./services/terminal.js";
import type { computerUseSettings } from "./services/computer-use/settings.js";
import type { computerUseStatus } from "./services/computer-use/status.js";
import type { formFillRuntime } from "./services/form-fill/artifacts.js";
import type {
  disposeFoundationModelsConnection,
  foundationModelsConnection,
  settleFoundationModelsHelperStops,
} from "./services/foundation-models-connection.js";
import type { skillRegistry } from "./services/skill-registry-main.js";
import type { spending } from "./services/spending-main.js";
import type { usageLimits } from "./services/usage-limit-main.js";
import type { disposeDictation } from "./services/dictation.js";
import type { disposeLocalSpeech } from "./services/local-speech.js";
import type { destroyPill } from "./windows/pill-window.js";
import type {
  assertQuickChatConversationAccess,
  authorizeQuickChatConversation,
  destroyQuickChat,
  isCurrentQuickChatEvent,
  revokeQuickChatConversation,
} from "./windows/quick-chat-window.js";
import type {
  destroyBotBubbleOverlays,
  releaseBotBubbleOverlays,
} from "./windows/bot-bubbles-window.js";
import type { scheduleService } from "./services/schedule-service.js";
import type { stopScheduledTaskTriggers } from "./services/scheduled-task-triggers-main.js";
import type { shutdownFollowThrough } from "./services/follow-through/follow-through-main.js";
import type {
  goalLoop,
  goalNeedsYou,
  onGoalLookingChanged,
  shutdownGoalLoop,
} from "./services/goal/goal-main.js";
import type { stopKeepAwake } from "./services/keep-awake/keep-awake-main.js";
import type { botSkillContentWatcher } from "./services/bot-capability-services-main.js";
import type { shutdownBotSessionRuntime } from "./services/bot-runtime/bot-session-main.js";
import type { shutdownBotComputers } from "./services/bot-computers/bot-computers-main.js";

export interface LoadedSubsystemMap {
  llmClient: typeof llmClient;
  browserService: typeof browserService;
  antigravity: { shutdownAntigravity: typeof shutdownAntigravity };
  subagentRuntimeRegistry: typeof subagentRuntimeRegistry;
  subagentHealthMetrics: typeof subagentHealthMetrics;
  subagentSupervisor: {
    flushPendingSubagentTranscripts: typeof flushPendingSubagentTranscripts;
  };
  subagentRunStore: typeof subagentRunStore;
  aidenRemote: {
    aidenRemoteServiceKeepsApplicationAlive: typeof aidenRemoteServiceKeepsApplicationAlive;
    stopAidenRemoteServiceAndSettle: typeof stopAidenRemoteServiceAndSettle;
  };
  geminiLiveService: typeof geminiLiveService;
  geminiLiveTranscription: typeof geminiLiveTranscription;
  telegramService: typeof telegramService;
  devices: {
    closeDeviceSessionsForChat: typeof closeDeviceSessionsForChat;
    shutdownDevices: typeof shutdownDevices;
    terminateDeviceHelperCommands: typeof terminateDeviceHelperCommands;
  };
  workspaceGitWatchers: {
    disposeWorkspaceGitWatchers: typeof disposeWorkspaceGitWatchers;
  };
  createImagesRuntime: typeof createImagesRuntime;
  designCanvas: {
    designCanvasStore: typeof designCanvasStore;
    designFileWatcher: typeof designFileWatcher;
    designModeConsent: typeof designModeConsent;
    recentWrittenPages: typeof recentWrittenPages;
  };
  contextPressure: {
    forgetChatContextProfile: typeof forgetChatContextProfile;
  };
  mcpManager: typeof mcpManager;
  providerAuthFlow: {
    shutdownProviderAuthFlow: typeof shutdownProviderAuthFlow;
  };
  storageUsageService: typeof storageUsageService;
  terminalService: typeof terminalService;
  computerUseSettings: typeof computerUseSettings;
  computerUseStatus: typeof computerUseStatus;
  formFillRuntime: typeof formFillRuntime;
  foundationModels: {
    foundationModelsConnection: typeof foundationModelsConnection;
    disposeFoundationModelsConnection: typeof disposeFoundationModelsConnection;
    settleFoundationModelsHelperStops: typeof settleFoundationModelsHelperStops;
  };
  skillRegistry: typeof skillRegistry;
  spending: typeof spending;
  usageLimits: typeof usageLimits;
  dictation: { disposeDictation: typeof disposeDictation };
  localSpeech: { disposeLocalSpeech: typeof disposeLocalSpeech };
  pillWindow: { destroyPill: typeof destroyPill };
  quickChatWindow: {
    destroyQuickChat: typeof destroyQuickChat;
    assertQuickChatConversationAccess: typeof assertQuickChatConversationAccess;
    authorizeQuickChatConversation: typeof authorizeQuickChatConversation;
    isCurrentQuickChatEvent: typeof isCurrentQuickChatEvent;
    revokeQuickChatConversation: typeof revokeQuickChatConversation;
  };
  botBubblesWindow: {
    destroyBotBubbleOverlays: typeof destroyBotBubbleOverlays;
    releaseBotBubbleOverlays: typeof releaseBotBubbleOverlays;
  };
  scheduleService: typeof scheduleService;
  scheduledTaskTriggers: {
    stopScheduledTaskTriggers: typeof stopScheduledTaskTriggers;
  };
  followThrough: { shutdownFollowThrough: typeof shutdownFollowThrough };
  goalLoop: {
    goalLoop: typeof goalLoop;
    goalNeedsYou: typeof goalNeedsYou;
    onGoalLookingChanged: typeof onGoalLookingChanged;
    shutdownGoalLoop: typeof shutdownGoalLoop;
  };
  keepAwake: {
    stopKeepAwake: typeof stopKeepAwake;
    notifyInputsChanged?: () => void;
  };
  botSkillContentWatcher: typeof botSkillContentWatcher;
  botSessionRuntime: {
    shutdownBotSessionRuntime: typeof shutdownBotSessionRuntime;
  };
  botComputers: { shutdownBotComputers: typeof shutdownBotComputers };
}

export interface LoadedSubsystemRegistry<
  TMap extends object = LoadedSubsystemMap,
> {
  register<K extends keyof TMap>(key: K, value: TMap[K]): TMap[K];
  peek<K extends keyof TMap>(key: K): TMap[K] | undefined;
  isLoaded(key: keyof TMap): boolean;
}

export function createLoadedSubsystemRegistry<
  TMap extends object = LoadedSubsystemMap,
>(): LoadedSubsystemRegistry<TMap> {
  const loaded = new Map<keyof TMap, unknown>();
  return {
    register<K extends keyof TMap>(key: K, value: TMap[K]): TMap[K] {
      loaded.set(key, value);
      return value;
    },
    peek<K extends keyof TMap>(key: K): TMap[K] | undefined {
      return loaded.get(key) as TMap[K] | undefined;
    },
    isLoaded(key: keyof TMap): boolean {
      return loaded.has(key);
    },
  };
}

const processSubsystems = createLoadedSubsystemRegistry<LoadedSubsystemMap>();

export function registerLoadedSubsystem<K extends keyof LoadedSubsystemMap>(
  key: K,
  value: LoadedSubsystemMap[K],
): LoadedSubsystemMap[K] {
  return processSubsystems.register(key, value);
}

export function peekLoadedSubsystem<K extends keyof LoadedSubsystemMap>(
  key: K,
): LoadedSubsystemMap[K] | undefined {
  return processSubsystems.peek(key);
}

export function isSubsystemLoaded(key: keyof LoadedSubsystemMap): boolean {
  return processSubsystems.isLoaded(key);
}
