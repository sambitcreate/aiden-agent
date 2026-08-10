import type { Chat } from "./types.js";
import {
  APPEND_RECONCILIATION_REQUIRED,
  appendReconciliationFailureMessage,
} from "../../renderer/shared/chat-message-contract.js";

export { APPEND_RECONCILIATION_REQUIRED };

export class AppendReconciliationRequiredError extends Error {
  constructor() {
    super(appendReconciliationFailureMessage("current"));
    this.name = "AppendReconciliationRequiredError";
  }
}

export function isAppendReconciliationRequiredError(
  error: unknown,
): error is AppendReconciliationRequiredError {
  return error instanceof AppendReconciliationRequiredError;
}

/**
 * Reconcile a store error against the exact main-minted message identity.
 * Atomic payload installation can succeed before a later directory/index
 * durability step reports failure. In that case the transaction-aware read
 * repairs metadata and the renderer must observe a committed send, not an
 * ordinary retryable draft.
 */
export async function appendChatMessageWithReconciliation(input: {
  messageId: string;
  append: () => Promise<Chat>;
  recover: () => Promise<Chat | null>;
}): Promise<Chat> {
  try {
    return await input.append();
  } catch (appendError) {
    let recovered: Chat | null;
    try {
      recovered = await input.recover();
    } catch {
      throw new AppendReconciliationRequiredError();
    }
    if (recovered?.messages.some((message) => message.id === input.messageId)) return recovered;
    throw appendError;
  }
}
