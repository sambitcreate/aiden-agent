// Which chats count as live on a workspace's canvas: the chat exists and is
// in that workspace. A chat that moved away is not live there. Claims and
// `namedFor` marks of chats that are not live are dropped by the writes that
// check (entry, `canvas_page use` and `delete`).

/** Which of `chatIds` are live in `workspaceId`, from one read of the chat index. */
export type DesignLiveChats = (chatIds: readonly string[], workspaceId: string) => Promise<Set<string>>;

export function createDesignLiveChats(chats: {
  /** The chats of a workspace, from the chat index (`ChatStore.list`). */
  list(workspaceId?: string): Promise<ReadonlyArray<{ id: string }>>;
}): DesignLiveChats {
  return async (chatIds, workspaceId) => {
    if (chatIds.length === 0) return new Set();
    const here = new Set((await chats.list(workspaceId)).map((meta) => meta.id));
    return new Set(chatIds.filter((chatId) => here.has(chatId)));
  };
}
