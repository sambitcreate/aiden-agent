import { ipcMain } from "../platform.js";
import {
  hideAssistantWindow,
  isCurrentAssistantEvent,
  toggleAssistantWindow,
} from "../windows/assistant-window.js";

export function registerAssistantHandlers(): void {
  ipcMain.handle("assistant:toggle-window", async () => {
    await toggleAssistantWindow();
  });

  // Only the assistant window itself may hide the assistant window.
  ipcMain.handle("assistant:hide-window", async (event) => {
    if (!isCurrentAssistantEvent(event)) return;
    hideAssistantWindow();
  });
}
