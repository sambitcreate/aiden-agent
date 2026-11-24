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
} from "./design-canvas/main.js";
import { designTurnPages } from "./design-canvas/views.js";
import { EARLIER_PAGES_LIMIT, pagesWrittenInChat, placeWrittenPagesOnCanvas } from "./design-canvas/written-pages.js";
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
  designPagesOnEntry: (chat, workspaceRoot) => designPendingEntries.track(chat.id, (async () => {
    const entered = await placeWrittenPagesOnCanvas({
      chatId: chat.id,
      workspaceRoot,
      // A reply still running has not saved its activity yet; its pages come from this run's record.
      paths: recentWrittenPages.merged(chat.id, pagesWrittenInChat(chat.messages)),
      limit: EARLIER_PAGES_LIMIT,
      shouldSave: async () => (await chatStore.getMeta(chat.id))?.designMode === true,
      store: designCanvasStore,
      pages: designTurnPages({ views: designCanvasViews, chatId: chat.id }),
      broadcast: (update) => ipcMain.broadcast(DESIGN_CANVAS_UPDATED_CHANNEL, update),
      newId: randomUUID,
      // The chat claims its own page of the shared canvas, and its earlier pages land there.
      entry: {
        pageName: chat.title,
        otherViews: (workspaceId) => designCanvasViews.pageIdsOf(workspaceId, chat.id),
        isLive: designLiveChats,
      },
    });
    // The canvas shows that page and fits them once it loads, so the person sees them whole.
    const { frameIds, pageId, focusId } = entered;
    if (pageId && (frameIds.length > 0 || focusId !== undefined)) {
      ipcMain.broadcast("designCanvas:focus", { chatId: chat.id, pageId, frameIds, ...(focusId !== undefined ? { focusId } : {}) });
    }
    // The title may have changed while entry ran; a page made for the chat follows it.
    await designTitleFollow.follow(chat.id);
  })()),
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
