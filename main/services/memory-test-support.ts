import type { Chat } from "./types.js";

export function memoryChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-a",
    title: "Chat",
    workspaceId: "workspace-a",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
