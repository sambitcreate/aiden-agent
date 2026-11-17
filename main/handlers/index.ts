import { registerAppControlHandlers } from "./app-controls.js";
/**
 * Handler Registration
 *
 * Register all your IPC handlers here
 */

import { appHandlers } from "./app.js";
import { registerProviderHandlers } from "./providers.js";
import { registerAcpHarnessHandlers } from "./acp-harnesses.js";
import { registerChatHistoryHandlers } from "./chats.js";
import { registerDesignWindowHandlers } from "./design-window.js";
import { registerChatGenerationHandlers } from "./chat.js";
import { registerWorkspaceHandlers } from "./workspaces.js";
import { registerPullRequestHandlers } from "./pull-requests.js";
import { registerWorkspaceArtifactHandlers } from "./workspace-artifacts.js";
import { configStore } from "../services/config-store.js";
import {
  notifyWorkspaceArtifactsChanged,
  workspaceArtifactFiles,
  workspaceArtifactRunner,
  workspaceArtifactStore,
} from "../services/workspace-artifacts/main.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { workspaceEnvironmentApplicationService } from "../services/workspace-environment-application-service-main.js";
import type { IpcMainInvokeEvent } from "electron";
import { registerAttachmentHandlers } from "./attachments.js";
import { registerChatImageActionHandlers } from "./chat-image-actions.js";
import { registerTranscriptImageHandlers } from "./transcript-images.js";
import { fetchTranscriptImage } from "../services/transcript-image-fetch.js";
import { registerPhase2Handlers } from "./phase2.js";
import { registerLocalVoiceHandlers } from "./local-voice.js";
import { registerTerminalHandlers } from "./terminal.js";
import { registerTitleProviderHandlers } from "./title-providers.js";
import { registerUsageHandlers } from "./usage.js";
import { registerProfileHandlers } from "./profile.js";
import { registerComputerUseHandlers } from "./computer-use.js";
import { registerFormFillHandlers } from "./form-fill.js";
import { registerModelInsightsHandlers } from "./model-insights.js";
import { registerImageGenerationHandlers } from "./image-generation.js";
import { registerModelPaceHandlers } from "./model-pace.js";
import { registerUsageLimitHandlers } from "./usage-limits.js";
import { registerSpendingHandlers } from "./spending.js";
import { registerHookHandlers } from "./hooks.js";
import { registerApprovalRuleHandlers } from "./approval-rules.js";
import { approvalRulesPage } from "../services/approval-rules/rules-page-main.js";
import { approvalRules } from "../services/approval-rules/store-main.js";
import { toolApprovalRules } from "../services/tool-approval-rules-main.js";
import { getHookService } from "../services/hooks/hook-service-main.js";
import { workspaceApplicationService } from "../services/workspace-application-service-main.js";
import { HOOKS_CHANGED_CHANNEL } from "../../renderer/shared/hooks-settings.js";
import { registerAnalyticsHandlers } from "./analytics.js";
import { analyticsService } from "../services/analytics/analytics-main.js";
import { registerDictationHandlers } from "./dictation.js";
import { registerScheduledTaskHandlers } from "./scheduled-tasks.js";
import { registerAssistantHandlers } from "./assistant.js";
import { registerShortcutHandlers } from "./shortcuts.js";
import { registerTelegramHandlers } from "./telegram.js";
import { registerSubagentHandlers } from "./subagents.js";
import { registerAssistantLiveHandlers } from "./assistant-live.js";
import { registerAidenRemoteHandlers } from "./aiden-remote.js";
import { registerPeerHostHandlers } from "./peer-hosts.js";
import { registerLocalRunIpc } from "./local-runs-main.js";
import { registerChatPendingAttentionIpc } from "./chat-pending-attention-main.js";
import { registerBotHandlers } from "./bots.js";
import { registerBotRoutineHandlers } from "./bot-routines.js";
import { registerBotComputerHandlers } from "./bot-computers.js";
import { botComputerHandlerDependencies } from "../services/bot-computers/bot-computers-main.js";
import { registerDiagnosticHandlers } from "./diagnostics.js";
import { registerStorageHandlers } from "./storage.js";
import { hostPlatformCapabilities } from "../services/host-platform-capabilities.js";
import { registerBtwHandlers } from "./btw.js";
import { registerFollowThroughHandlers } from "./follow-through.js";
import { registerTtsHandlers } from "./tts.js";
import { registerDeviceHandlers } from "./devices.js";
import { registerCreateImagesIpc } from "./create-images/index.js";
import { registerDesignCanvasIpc } from "./design-canvas-main.js";
import { initializeAdvisorRuntime } from "../services/advisor-runtime-main.js";
import { initializeForkSummaries } from "../services/fork-summary-service-main.js";
import { modelPaceRecorder } from "../services/model-pace-runtime.js";
import { usageLimits } from "../services/usage-limit-main.js";
import { spending } from "../services/spending-main.js";

import { ipcMain, logger } from "../platform.js";

export function registerHandlers(isMainWindow: (event: IpcMainInvokeEvent) => boolean): void {
  logger.info("handlers", "Registering IPC handlers...");

  // Register app handlers using ipcMain API
  ipcMain.handle("app:getInfo", async (_event) => {
    return await appHandlers.getInfo();
  });

  registerDiagnosticHandlers();
  initializeAdvisorRuntime();
  initializeForkSummaries();

  // AI chat client handlers
  registerProviderHandlers();
  registerAppControlHandlers();
  registerAcpHarnessHandlers();
  registerChatHistoryHandlers();
  registerDesignWindowHandlers();
  registerChatPendingAttentionIpc();
  registerChatGenerationHandlers();
  registerWorkspaceHandlers();
  registerPullRequestHandlers();
  registerWorkspaceArtifactHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    store: workspaceArtifactStore,
    workspaceExists: async (id) => Boolean(await configStore.getWorkspace(id)),
    notify: notifyWorkspaceArtifactsChanged,
    files: workspaceArtifactFiles,
    owner: (event) => {
      const owner = rendererDocumentOwner(event as IpcMainInvokeEvent, () => new Error("Artifacts need the active window."));
      return `${owner.id}:${owner.documentId}`;
    },
    runner: workspaceArtifactRunner,
    runInWorkspace: (event, workspaceId, operation) =>
      workspaceEnvironmentApplicationService.run(
        rendererDocumentOwner(event as IpcMainInvokeEvent, () => new Error("Artifacts need the active window.")),
        workspaceId,
        ({ folderPath, workspace }, signal) => operation({ folderPath, permission: workspace.permission }, signal),
      ),
  });
  registerAttachmentHandlers();
  registerChatImageActionHandlers();
  registerTranscriptImageHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    owner: (event) => rendererDocumentOwner(event as IpcMainInvokeEvent, () => new Error("Image loading requires the active application window.")),
    fetch: fetchTranscriptImage,
  });
  registerPhase2Handlers();
  registerLocalVoiceHandlers();
  registerTerminalHandlers();
  registerTitleProviderHandlers();
  registerUsageHandlers();
  registerProfileHandlers();
  registerComputerUseHandlers();
  registerFormFillHandlers();
  registerModelInsightsHandlers();
  registerImageGenerationHandlers();
  registerModelPaceHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    recorder: modelPaceRecorder,
  });
  registerUsageLimitHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    limits: usageLimits,
  });
  registerSpendingHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    spending,
  });
  registerHookHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    service: getHookService,
    workspaces: async () =>
      (await workspaceApplicationService.list()).flatMap((workspace) =>
        workspace.folderPath && !workspace.noWorkspace ? [{ workspaceRoot: workspace.folderPath, name: workspace.name }] : [],
      ),
    broadcast: (change) => ipcMain.broadcast(HOOKS_CHANGED_CHANNEL, change),
    requireSender: (event) => {
      const inactive = () => new Error("Hooks settings need the active window.");
      if (!isMainWindow(event as IpcMainInvokeEvent)) throw inactive();
      rendererDocumentOwner(event as IpcMainInvokeEvent, inactive);
    },
  });
  registerApprovalRuleHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    page: approvalRulesPage(),
    onChange: (listener) => {
      const stops = [approvalRules.onChange(listener), toolApprovalRules.onChange(listener), toolApprovalRules.onBotChange(() => listener())];
      return () => { for (const stop of stops) stop(); };
    },
    broadcast: (channel, payload) => ipcMain.broadcast(channel, payload),
  });
  registerAnalyticsHandlers<IpcMainInvokeEvent>({
    owner: (event) => {
      const inactive = () => new Error("Usage data changes require the active application document.");
      if (!isMainWindow(event)) throw inactive();
      return rendererDocumentOwner(event, inactive);
    },
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    analytics: analyticsService(),
  });
  registerDictationHandlers();
  registerScheduledTaskHandlers();
  // Bot routines are scheduled tasks owned by a Bot; they exist only where Bots do.
  if (hostPlatformCapabilities().bots) registerBotRoutineHandlers();
  // Bot computers are macOS VMs; only Apple silicon offers them, so Linux registers nothing.
  if (hostPlatformCapabilities().botComputers) registerBotComputerHandlers(botComputerHandlerDependencies());
  registerAssistantHandlers();
  registerShortcutHandlers();
  registerTelegramHandlers();
  registerSubagentHandlers();
  registerAssistantLiveHandlers();
  registerAidenRemoteHandlers();
  registerPeerHostHandlers();
  registerLocalRunIpc();
  if (hostPlatformCapabilities().bots) registerBotHandlers();
  registerBtwHandlers();
  registerFollowThroughHandlers();
  registerTtsHandlers();
  registerStorageHandlers();
  registerDeviceHandlers();
  registerCreateImagesIpc();
  registerDesignCanvasIpc();

  logger.info("handlers", "✓ IPC handlers registered");
}
