// IPC handlers bridging the dictation pill renderer to the main-process
// dictation coordinator.

import { ipcMain } from "../platform.js";
import { isCurrentPillEvent } from "../windows/pill-window.js";
import {
  cancelDictation,
  handleDictationError,
  handleDictationProgress,
  handleDictationResult,
  handlePillReady,
  stopDictationRecording,
} from "../services/dictation.js";

export function registerDictationHandlers(): void {
  ipcMain.handle("dictation:result", (event, operationId: unknown, text: unknown) => {
    if (!isCurrentPillEvent(event)) throw new Error("Untrusted dictation result sender.");
    return handleDictationResult(text, operationId);
  });
  ipcMain.handle("dictation:error", (event, operationId: unknown, message: unknown) => {
    if (!isCurrentPillEvent(event)) throw new Error("Untrusted dictation error sender.");
    return handleDictationError(message, operationId);
  });
  ipcMain.handle("dictation:progress", (event, operationId: unknown, progress: unknown) => {
    if (!isCurrentPillEvent(event)) throw new Error("Untrusted dictation progress sender.");
    return handleDictationProgress(progress, operationId);
  });
  ipcMain.handle("dictation:cancel", (event) => {
    if (!isCurrentPillEvent(event)) throw new Error("Untrusted dictation cancel sender.");
    return cancelDictation();
  });
  ipcMain.handle("dictation:ready", (event) => {
    if (!isCurrentPillEvent(event)) throw new Error("Untrusted dictation ready sender.");
    return handlePillReady();
  });
  ipcMain.handle("dictation:stop", (event) => {
    if (!isCurrentPillEvent(event)) throw new Error("Untrusted dictation stop sender.");
    return stopDictationRecording();
  });
}
