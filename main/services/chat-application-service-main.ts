import { randomUUID } from "node:crypto";
import { ipcMain, logger } from "../platform.js";
import { chatStore } from "./chat-store.js";
import { configStore } from "./config-store.js";
import { displayImageArtifactStore } from "./display-image-artifact-store.js";
import { generativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import { llmClient } from "./llm-client.js";
import { piCompactionSessionStore } from "./pi-compaction-session-store.js";
import { piRuntimeEffectStore } from "./pi-runtime-effect-store.js";
import { subagentRunStore } from "./subagents/subagent-run-store.js";
import { workspaceMutationGate } from "./workspace-mutation-gate.js";
import { workspaceOperationRegistry } from "./workspace-operation-registry.js";
import { createChatApplicationService } from "./chat-application-service.js";
import { memoryStore } from "./memory-store-main.js";
import { forgetChatContextProfile } from "./context-pressure.js";
import { spending } from "./spending-main.js";
import { remoteAttachmentStore } from "./aiden-remote-attachments-main.js";
import { toolOutputStore } from "./tool-output-store.js";
import { scheduleStore } from "./schedule-store.js";
import { chatPullRequestStore } from "./chat-pull-request-service-main.js";
import {
  designCanvasCarry,
  designCanvasChatCleanup,
  designCanvasStore,
  designCanvasViews,
  designGrants,
  designLiveChats,
  designModeConsent,
  designPendingEntries,
  designTitleFollow,
  recentWrittenPages,
  designAppServers,
} from "./design-canvas/main.js";
import { readCanvasConfig } from "./design-canvas/canvas-config.js";
import { designLiveEnabled } from "./studio/feature-flags.js";
import { reportAnalyticsEvent } from "./analytics/analytics-report.js";
import { deviceBucket } from "../../renderer/shared/design-canvas/app-devices.js";
import { createDesignEntry } from "./design-canvas/entry.js";
import { DESIGN_CANVAS_UPDATED_CHANNEL } from "../handlers/design-canvas.js";
import { cancelVisualSnapshots } from "./visual-snapshot-service.js";
import { beginFollowThroughMove, deleteChatFollowThrough, restoreChatFollowThrough } from "./follow-through/follow-through-main.js";
import { interruptedWaits } from "./interrupted-waits-main.js";
import { deleteChatLinks } from "./chat-orchestration/child-chats-main.js";
import { detachedPromptLog } from "./chat-pending-attention-main.js";
import { workspaceApplicationService } from "./workspace-application-service-main.js";
import { chatReadMarkers } from "./chat-read-markers-main.js";
import { chatTriage } from "./chat-triage-main.js";

export const chatApplicationService = createChatApplicationService({
  chatStore,
  configStore,
  llmClient,
  displayImageArtifactStore,
  generativeUiArtifactStore,
  workspaceMutationGate,
  workspaceOperationRegistry,
  subagentRunStore,
  piRuntimeEffectStore,
  piCompactionSessionStore,
  chatPullRequestStore,
  designCanvasCleanup: designCanvasChatCleanup,
  designCanvasCarry,
  designGrants,
  designModeConsent,
  // Tracked whichever way design mode turned on, so the chat's canvas writes wait for its claim.
  designPagesOnEntry: createDesignEntry({
    store: designCanvasStore,
    views: designCanvasViews,
    recent: recentWrittenPages,
    pending: designPendingEntries,
    titleFollow: designTitleFollow,
    isLive: designLiveChats,
    designModeOn: async (chatId) => (await chatStore.getMeta(chatId))?.designMode === true,
    broadcast: (update) => ipcMain.broadcast(DESIGN_CANVAS_UPDATED_CHANNEL, update),
    focus: (request) => ipcMain.broadcast("designCanvas:focus", request),
    newId: randomUUID,
    // 3b (S83): the chat's route files, or a single app's `/`, land as live frames.
    ...(designLiveEnabled()
      ? {
          live: {
            snapshot: (workspaceId: string) => designAppServers.snapshot(workspaceId),
            readConfig: readCanvasConfig,
            onAppFrameAdded: (viewportWidth: number) =>
              reportAnalyticsEvent("design_app_frame_added", { source: "aiden", device_bucket: deviceBucket(viewportWidth) }),
          },
        }
      : {}),
  }),
  visualSnapshots: { cancelChat: cancelVisualSnapshots },
  followThrough: { beginMove: beginFollowThroughMove, deleteChat: deleteChatFollowThrough, restoreChat: restoreChatFollowThrough },
  memoryStore,
  releaseChatContext: (chatId) => {
    // After the delete's durable boundary, so a rolled-back delete keeps its started chats linked.
    void deleteChatLinks(chatId).catch((error: unknown) => logger.warn("chat-orchestration", "Could not forget a deleted chat's links.", error));
    forgetChatContextProfile(chatId);
    recentWrittenPages.forget(chatId);
    void spending.forgetChat(chatId).catch(() => undefined);
    void interruptedWaits.forgetChat(chatId).catch(() => undefined);
    detachedPromptLog.clearChat(chatId);
  },
  invalidateChatWorkspaceContext: (chatId) => {
    forgetChatContextProfile(chatId);
    recentWrittenPages.forget(chatId);
    detachedPromptLog.clearChat(chatId);
  },
  forgetDeletedChat: (chatId) => llmClient.forgetDeletedChat(chatId),
  resetChatWorkspaceSession: (chatId) => llmClient.resetChatWorkspaceSession(chatId),
  inboxState: { readMarkers: chatReadMarkers, triage: chatTriage },
  attachments: remoteAttachmentStore,
  afterChatRemoved: (workspaceId) => workspaceApplicationService.releaseNoWorkspaceAfterChat(workspaceId),
  scheduledTasks: {
    releaseOriginChat: async (chatId) => {
      const released = await scheduleStore.releaseOriginChat(chatId);
      for (const taskId of released) ipcMain.broadcast("schedule:updated", { taskId });
    },
  },
  toolOutputStore,
  logError: (area, message, error) => logger.error(area, message, error),
});
