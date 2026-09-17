import { session } from "electron";
import { ipcMain } from "../platform.js";
import { geminiLiveService } from "../services/gemini-live/service-main.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import {
  bindGeminiLiveDisplayMediaDocument,
  installGeminiLiveDisplayMediaGuards,
} from "../services/gemini-live/display-media-contract.js";
import {
  parseAssistantLiveStartIntent,
  parseAssistantLiveAudioIntent,
  parseAssistantLiveEmptyIntent,
  parseAssistantLiveFrameIntent,
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
  ipcMain.handle("assistant-live:display-bind", (event, input: unknown) => {
    parseAssistantLiveEmptyIntent(input, "display-bind");
    const binding = bindGeminiLiveDisplayMediaDocument(event);
    if (!geminiLiveService.bindDisplayMedia(owner(event), binding)) return false;
    // The guards consult the live binding set, so install them only after this
    // document's binding is registered and only once per Electron session.
    installGeminiLiveDisplayMediaGuards(session.defaultSession, () =>
      geminiLiveService.displayMediaBindings(),
    );
    return true;
  });
  ipcMain.handle("assistant-live:display-release", (event, input: unknown) => {
    parseAssistantLiveEmptyIntent(input, "display-release");
    geminiLiveService.releaseDisplayMedia(owner(event));
    return true;
  });
  ipcMain.handle("assistant-live:frame", (event, input: unknown) => {
    const intent = parseAssistantLiveFrameIntent(input);
    return geminiLiveService.sendFrame(owner(event), intent.sessionId, intent.frame);
  });
}
