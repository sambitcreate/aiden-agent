/**
 * Register every desktop IPC handler used by the renderer.
 */
import { appHandlers } from "./app.js";
import { registerProviderHandlers } from "./providers.js";
import { registerChatHistoryHandlers } from "./chats.js";
import { registerChatGenerationHandlers } from "./chat.js";
import { registerWorkspaceHandlers } from "./workspaces.js";
import { registerAttachmentHandlers } from "./attachments.js";
import { registerPhase2Handlers } from "./phase2.js";
import { registerLocalVoiceHandlers } from "./local-voice.js";
import { registerTerminalHandlers } from "./terminal.js";
import { registerTitleProviderHandlers } from "./title-providers.js";
import { registerUsageHandlers } from "./usage.js";
import { registerProfileHandlers } from "./profile.js";
import { registerComputerUseHandlers } from "./computer-use.js";
import { registerModelInsightsHandlers } from "./model-insights.js";
import { registerDictationHandlers } from "./dictation.js";
import { registerScheduledTaskHandlers } from "./scheduled-tasks.js";
import { registerAssistantHandlers } from "./assistant.js";
import { registerShortcutHandlers } from "./shortcuts.js";
import { registerTelegramHandlers } from "./telegram.js";
import { registerSubagentHandlers } from "./subagents.js";
import { registerAidenRemoteHandlers } from "./aiden-remote.js";
import { registerBotHandlers } from "./bots.js";
import { registerDiagnosticHandlers } from "./diagnostics.js";
import { registerBtwHandlers } from "./btw.js";
import { initializeAdvisorRuntime } from "../services/advisor-runtime-main.js";

import { ipcMain, logger } from "../platform.js";

export function registerHandlers(): void {
  logger.info("handlers", "Registering IPC handlers...");

  ipcMain.handle("app:getInfo", async (_event) => {
    return await appHandlers.getInfo();
  });

  registerDiagnosticHandlers();
  initializeAdvisorRuntime();

  registerProviderHandlers();
  registerChatHistoryHandlers();
  registerChatGenerationHandlers();
  registerWorkspaceHandlers();
  registerAttachmentHandlers();
  registerPhase2Handlers();
  registerLocalVoiceHandlers();
  registerTerminalHandlers();
  registerTitleProviderHandlers();
  registerUsageHandlers();
  registerProfileHandlers();
  registerComputerUseHandlers();
  registerModelInsightsHandlers();
  registerDictationHandlers();
  registerScheduledTaskHandlers();
  registerAssistantHandlers();
  registerShortcutHandlers();
  registerTelegramHandlers();
  registerSubagentHandlers();
  registerAidenRemoteHandlers();
  registerBotHandlers();
  registerBtwHandlers();

  logger.info("handlers", "IPC handlers registered");
}
