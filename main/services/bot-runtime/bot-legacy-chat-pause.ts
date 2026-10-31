// Pausing a Bot also stops its legacy chat work (plan §7).
//
// Paired desktops and Remote revision-35 phones still drive a Bot through its
// chat (`POST /chats/{id}/turns`), which runs on `llmClient` outside the
// Bot's durable session, so closing the harness never reaches it. This pause
// step runs after the pause is recorded: a turn admitted from then on is
// refused (the Remote route checks again once it holds the chat's turn, and
// the generation checks once it is registered), and this stops what already
// runs on every chat the Bot owns, leaving other Bots and workspace chats
// alone.

export interface BotLegacyChatWork {
  /** Every chat the Bot owns (`chatStore.listByBot`). */
  chatIds(botId: string): Promise<readonly string[]>;
  /**
   * Stop the chat's starting and running generations, their tools and
   * subagents, and resolve once nothing runs on it; `false` when work was
   * still settling at the bound.
   */
  stopChat(chatId: string): Promise<boolean>;
}

/** Stop and settle the Bot's legacy chat work. Throws when some of it was still settling at the bound. */
export async function stopBotLegacyChatWork(botId: string, work: BotLegacyChatWork): Promise<void> {
  const chatIds = await work.chatIds(botId);
  const settled = await Promise.all(chatIds.map((chatId) => work.stopChat(chatId)));
  const unsettled = settled.filter((done) => !done).length;
  if (unsettled > 0) {
    throw new Error(`${unsettled} of the Bot's chats were still stopping when the pause finished.`);
  }
}
