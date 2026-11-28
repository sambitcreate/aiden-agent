// The desktop's view of the chats a lead chat started (Phase 5, D7): the
// "3 chats working" chip lists them and can stop one or all.

import { ipcMain } from "../platform.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import {
  childChats,
  childChatsChanged,
  leadChatStopped,
} from "../services/chat-orchestration/child-chats-main.js";
import { hostPlatformCapabilities } from "../services/host-platform-capabilities.js";

function chatId(value: unknown, label = "chat"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(value))
    throw new Error(`Invalid ${label}.`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid request.");
  return value as Record<string, unknown>;
}

export function registerChildChatsHandlers(): void {
  ipcMain.handle("chats:childChats", async (_event, leadChatId: unknown) => {
    const lead = chatId(leadChatId);
    if (!hostPlatformCapabilities().childChats) return [];
    return childChats.list(lead);
  });

  ipcMain.handle("chats:childChatsStop", async (event, input: unknown) => {
    rendererDocumentOwner(
      event,
      () => new Error("Stopping a started chat requires the active application document."),
    );
    const value = record(input);
    const lead = chatId(value.leadChatId);
    const outcome = await childChats.stop(lead, chatId(value.chatId));
    childChatsChanged(lead);
    return outcome;
  });

  ipcMain.handle("chats:childChatsStopAll", async (event, input: unknown) => {
    rendererDocumentOwner(
      event,
      () => new Error("Stopping started chats requires the active application document."),
    );
    const lead = chatId(record(input).leadChatId);
    // Like the person's Stop in the lead: endings stop waking it until they send there.
    await leadChatStopped(lead);
    childChatsChanged(lead);
  });
}
