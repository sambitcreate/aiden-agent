import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import type { AppSettings, Chat, Workspace } from "./types.js";

export interface MemoryPolicyReader {
  getSettings(): Promise<AppSettings>;
  getWorkspace(id: string): Promise<Workspace | undefined>;
}

export function memoryGloballyEnabled(settings: Pick<AppSettings, "memoryEnabled">): boolean {
  return settings.memoryEnabled !== false;
}

export function memoryWorkspaceEnabled(
  workspace: Pick<Workspace, "memoryEnabled"> | undefined,
): boolean {
  return workspace?.memoryEnabled !== false;
}

/** Bots have their own scope, so only the global gate applies to Bot memory. */
export async function memoryEnabledForChat(
  reader: MemoryPolicyReader,
  chat: Pick<Chat, "botId" | "workspaceId">,
): Promise<boolean> {
  const settings = await reader.getSettings();
  if (!memoryGloballyEnabled(settings)) return false;
  if (chat.botId) return true;
  const workspace = await reader.getWorkspace(persistedChatWorkspaceId(chat.workspaceId));
  return memoryWorkspaceEnabled(workspace);
}
