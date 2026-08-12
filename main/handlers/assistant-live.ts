import { ipcMain } from "../platform.js";
import { geminiLiveService } from "../services/gemini-live/service-main.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import {
  parseAssistantLiveStartIntent,
  parseAssistantLiveAudioIntent,
  parseAssistantLiveStopIntent,
} from "./assistant-live-parse.js";
import { invokeAssistantLiveStart } from "./assistant-live-start.js";
import { invokeAssistantLiveStatus } from "./assistant-live-status.js";

function owner(event: Electron.IpcMainInvokeEvent) {
  return rendererDocumentOwner(
    event,
    () =>
      new Error(
        "Assistant Live must be controlled by the active application document.",
      ),
  );
}

export function registerAssistantLiveHandlers(): void {
  ipcMain.handle("assistant-live:status", (event) =>
    invokeAssistantLiveStatus(geminiLiveService, owner(event)),
  );
  ipcMain.handle("assistant-live:start", (event, input: unknown) => {
    const requestOwner = owner(event);
    const intent = parseAssistantLiveStartIntent(input);
    return invokeAssistantLiveStart(geminiLiveService, requestOwner, intent);
  });
  ipcMain.handle("assistant-live:stop", (event, input: unknown) => {
    parseAssistantLiveStopIntent(input);
    return geminiLiveService.stop(owner(event));
  });
  ipcMain.handle("assistant-live:audio", (event, input: unknown) => {
    const intent = parseAssistantLiveAudioIntent(input);
    return geminiLiveService.sendAudio(owner(event), intent.sessionId, intent.pcm);
  });
}
