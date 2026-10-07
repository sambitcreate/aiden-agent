// One classifier decides what kind of chat a record is. Listing, Remote and
// copy surfaces admit chats by an explicit allow-list of surfaces, so a future
// owner kind stays hidden everywhere until a surface opts it in.
import { ASSISTANT_WORKSPACE_ID } from "./assistant.js";
import { persistedChatWorkspaceId } from "./chat-workspace.js";

/** Main-owned marker for a chat that belongs to another Aiden feature. Never renderer-authored. */
export interface ChatOwnerV1 {
  kind: "design-project";
  projectId: string;
}

export type ChatSurface = "regular" | "assistant" | "bot" | "feature";

export interface ChatSurfaceInput {
  workspaceId?: string;
  botId?: string;
  owner?: ChatOwnerV1;
}

const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Strict exact-shape parser; anything else is rejected, never repaired. */
export function parseChatOwnerV1(value: unknown): ChatOwnerV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("projectId")) {
    return undefined;
  }
  if (record.kind !== "design-project") return undefined;
  if (typeof record.projectId !== "string" || !OWNER_ID.test(record.projectId)) return undefined;
  return { kind: "design-project", projectId: record.projectId };
}

export function chatSurface(chat: ChatSurfaceInput): ChatSurface {
  // Any present owner hides the chat, even a malformed one: fail closed.
  if (chat.owner !== undefined) return "feature";
  if (chat.botId !== undefined) return "bot";
  if (persistedChatWorkspaceId(chat.workspaceId) === ASSISTANT_WORKSPACE_ID) return "assistant";
  return "regular";
}

/** An ordinary workspace chat: listed in the sidebar, search, Remote summaries and peers. */
export function isUserVisibleChat(chat: ChatSurfaceInput): boolean {
  return chatSurface(chat) === "regular";
}
