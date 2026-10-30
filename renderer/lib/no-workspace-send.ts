import type { Chat, Workspace } from "./types";

export interface NoWorkspaceSendApi {
  listChats(workspaceId: string): Promise<readonly Pick<Chat, "id">[]>;
  createNoWorkspace(): Promise<Pick<Workspace, "id">>;
}

/**
 * Each No workspace chat keeps its own hidden folder. A draft sent from one
 * that already holds a chat (the Chats group's home, a fork's source, a second
 * draft) is saved in a fresh one instead. Returns that workspace's id, or
 * undefined when the draft's own folder is still unused.
 */
export async function noWorkspaceFolderForFirstSend(
  api: NoWorkspaceSendApi,
  draftWorkspaceId: string,
): Promise<string | undefined> {
  const chats = await api.listChats(draftWorkspaceId);
  if (chats.length === 0) return undefined;
  return (await api.createNoWorkspace()).id;
}
