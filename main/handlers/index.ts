/**
 * Handler Registration
 *
 * Register all your IPC handlers here
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
import { registerArtificialAnalysisHandlers } from "./artificial-analysis.js";
import { registerDictationHandlers } from "./dictation.js";
import { registerScheduledTaskHandlers } from "./scheduled-tasks.js";

import { ipcMain, logger } from "../platform.js";
import { writeDevLog } from "../services/dev-log.js";
import { isPackagedRuntime } from "../runtime-mode.js";

export function registerHandlers(): void {
  logger.info("handlers", "Registering IPC handlers...");

  // Register app handlers using ipcMain API
  ipcMain.handle("app:getInfo", async (_event) => {
    return await appHandlers.getInfo();
  });

  // Renderer error forwarding for the dev log file (see services/dev-log.ts).
  ipcMain.handle("devlog:write", async (_event, level: unknown, message: unknown) => {
    if (isPackagedRuntime()) return;
    const safeLevel = level === "warn" || level === "error" ? level : "info";
    const text = (typeof message === "string" ? message : String(message)).slice(0, 16_384);
    writeDevLog(safeLevel, "renderer", [text]);
  });

  // AI chat client handlers
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
  registerArtificialAnalysisHandlers();
  registerDictationHandlers();
  registerScheduledTaskHandlers();

  logger.info("handlers", "✓ IPC handlers registered");

  // TODO: Add more handlers here using ipcMain.handle()
  // Example:
  // ipcMain.handle('file:read', async (event, path) => {
  //   const fs = await import('fs/promises');
  //   return await fs.readFile(path, 'utf-8');
  // });
}
