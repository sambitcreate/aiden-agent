/**
 * Handler Registration
 *
 * Register all your IPC handlers here
 */

import * as path from "path";
import { fileURLToPath } from "url";

import { appHandlers } from "./app.js";
import { getSettingsWindow, openSettingsWindow } from "../windows/settings-window.js";
import { registerProviderHandlers } from "./providers.js";
import { registerChatHistoryHandlers } from "./chats.js";
import { registerChatGenerationHandlers } from "./chat.js";
import { registerWorkspaceHandlers } from "./workspaces.js";
import { registerAttachmentHandlers } from "./attachments.js";
import { registerPhase2Handlers } from "./phase2.js";
import { registerLocalVoiceHandlers } from "./local-voice.js";

import { ipcMain, logger } from "@glaze/core/backend";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function registerHandlers(): void {
  logger.info("handlers", "Registering IPC handlers...");

  // Register app handlers using ipcMain API
  ipcMain.handle("app:getInfo", async (_event) => {
    return await appHandlers.getInfo();
  });

  // Return the .glaze project path (used for deep links back to the host)
  // __dirname = build/main, so two levels up is the app root
  ipcMain.handle("app:getProjectPath", async () => {
    return path.join(__dirname, "..", "..");
  });

  // Settings window handlers
  ipcMain.handle("window:openSettings", async (_event) => {
    await openSettingsWindow();
  });

  ipcMain.handle("window:closeSettings", async (_event) => {
    getSettingsWindow()?.close();
  });

  // AI chat client handlers
  registerProviderHandlers();
  registerChatHistoryHandlers();
  registerChatGenerationHandlers();
  registerWorkspaceHandlers();
  registerAttachmentHandlers();
  registerPhase2Handlers();
  registerLocalVoiceHandlers();

  logger.info("handlers", "✓ IPC handlers registered");

  // TODO: Add more handlers here using ipcMain.handle()
  // Example:
  // ipcMain.handle('file:read', async (event, path) => {
  //   const fs = await import('fs/promises');
  //   return await fs.readFile(path, 'utf-8');
  // });
}
