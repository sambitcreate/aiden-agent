import {
  isChatCreateReconciliationRequiredError,
  type ChatStore,
} from "./chat-store-core.js";

/**
 * Preserve the exact main-minted chat identity when background creation is
 * durable but its metadata repair remains indeterminate. The schedule store
 * can persist this claim before a later run/restart retries any work, avoiding
 * a second dedicated chat for the same task.
 */
export async function createScheduledChatClaim(
  claimedChatId: string,
  create: () => Promise<Awaited<ReturnType<ChatStore["create"]>>>,
): Promise<{ id: string }> {
  try {
    const created = await create();
    if (created.id !== claimedChatId) {
      throw new Error("Scheduled chat creation returned the wrong identity.");
    }
    return created;
  } catch (error) {
    if (isChatCreateReconciliationRequiredError(error)) {
      if (error.chatId !== claimedChatId) {
        throw new Error(
          "Scheduled chat reconciliation returned the wrong identity.",
        );
      }
      return { id: error.chatId };
    }
    throw error;
  }
}
