import { noWorkspaceHome } from "./no-workspace";
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

/** Hidden No workspace ids that were listed before and are gone now (their last chat was deleted). */
export function releasedNoWorkspaceIds(
  previousHiddenIds: ReadonlySet<string>,
  workspaces: readonly Pick<Workspace, "id">[],
): Set<string> {
  const released = new Set(previousHiddenIds);
  for (const workspace of workspaces) released.delete(workspace.id);
  return released;
}

export interface StrandedDraftApi {
  createNoWorkspace(): Promise<Pick<Workspace, "id">>;
  moveDraft(draftId: string, workspaceId: string): void;
}

/**
 * Deleting a No workspace chat releases its hidden folder, but a draft can
 * still aim at it (a fork of that chat, a new agent opened in it). Those drafts
 * move to the Chats group's home, made when none is left, so their first send
 * reaches a real folder. Returns that home, or undefined when no draft moved.
 */
export async function rehomeStrandedNoWorkspaceDrafts(
  api: StrandedDraftApi,
  drafts: readonly { readonly chat: Pick<Chat, "id" | "workspaceId">; readonly sending: boolean }[],
  released: ReadonlySet<string>,
  workspaces: readonly Workspace[],
): Promise<string | undefined> {
  const stranded = drafts.filter(
    (draft) => !draft.sending && draft.chat.workspaceId !== undefined && released.has(draft.chat.workspaceId),
  );
  if (stranded.length === 0) return undefined;
  const home = noWorkspaceHome(workspaces)?.id ?? (await api.createNoWorkspace()).id;
  for (const draft of stranded) api.moveDraft(draft.chat.id, home);
  return home;
}
