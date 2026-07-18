// Chat history CRUD IPC handlers.

import { ipcMain } from "@glaze/core/backend";
import { chatStore } from "../services/chat-store.js";
import type { Attachment, ChatRole } from "../services/types.js";

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${name}".`);
  }
  return value;
}

const ROLES: ChatRole[] = ["user", "assistant", "system"];

export function registerChatHistoryHandlers(): void {
  ipcMain.handle("chats:list", async (_event, workspaceId?: unknown) =>
    chatStore.list(typeof workspaceId === "string" && workspaceId ? workspaceId : undefined),
  );

  ipcMain.handle("chats:get", async (_event, id: unknown) => chatStore.get(asString(id, "id")));

  ipcMain.handle("chats:create", async (_event, input: unknown) => {
    const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    return chatStore.create({
      title: typeof i.title === "string" ? i.title : undefined,
      workspaceId: typeof i.workspaceId === "string" ? i.workspaceId : undefined,
      providerId: typeof i.providerId === "string" ? i.providerId : undefined,
      model: typeof i.model === "string" ? i.model : undefined,
    });
  });

  ipcMain.handle("chats:rename", async (_event, id: unknown, title: unknown) => {
    await chatStore.rename(asString(id, "id"), asString(title, "title"));
  });

  ipcMain.handle("chats:remove", async (_event, id: unknown) => {
    await chatStore.remove(asString(id, "id"));
  });

  ipcMain.handle("chats:appendMessage", async (_event, id: unknown, message: unknown, meta?: unknown) => {
    const m = (typeof message === "object" && message !== null ? message : {}) as Record<string, unknown>;
    const role = ROLES.includes(m.role as ChatRole) ? (m.role as ChatRole) : "user";
    const metaObj = (typeof meta === "object" && meta !== null ? meta : {}) as Record<string, unknown>;
    return chatStore.appendMessage(
      asString(id, "id"),
      {
        role,
        content: typeof m.content === "string" ? m.content : "",
        model: typeof m.model === "string" ? m.model : undefined,
        attachments: Array.isArray(m.attachments) ? (m.attachments as Attachment[]) : undefined,
      },
      {
        providerId: typeof metaObj.providerId === "string" ? metaObj.providerId : undefined,
        model: typeof metaObj.model === "string" ? metaObj.model : undefined,
        autoTitle: metaObj.autoTitle === true,
      },
    );
  });
}
