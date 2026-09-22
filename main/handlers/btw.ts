import { ipcMain } from "../platform.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { btwService, configureBtwChatBusyCheck } from "../services/rpiv-btw/service.js";
import { llmClient } from "../services/llm-client.js";

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${label}.`);
  return value;
}

export function registerBtwHandlers(): void {
  configureBtwChatBusyCheck((chatId) => llmClient.isChatBusy(chatId));

  ipcMain.handle("chats:btwStart", (event, input: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Side questions require the active application document."),
    );
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Invalid side question request.");
    }
    const record = input as Record<string, unknown>;
    return btwService.start(record.chatId, record.question, owner);
  });

  ipcMain.handle("chats:btwCancel", (event, input: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Side questions require the active application document."),
    );
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const record = input as Record<string, unknown>;
    return btwService.cancel(
      string(record.chatId, "chat"),
      string(record.requestId, "side question"),
      owner.documentId,
    );
  });

  ipcMain.handle("chats:btwClear", (event, input: unknown) => {
    rendererDocumentOwner(
      event,
      () => new Error("Side questions require the active application document."),
    );
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const record = input as Record<string, unknown>;
    btwService.clear(string(record.chatId, "chat"));
  });
}
