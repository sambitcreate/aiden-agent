import type { BotManagedWorkspaceResolution } from "../bot-managed-workspace-core.js";
import type { Chat } from "../types.js";
import type { TelegramBotBinding } from "./telegram-bot-binding-store.js";
import { telegramBotNoticeAudienceId } from "./telegram-profile-config.js";

interface TelegramBotMutationOperations {
  createChat(input: {
    audienceId: string;
    chatId: string;
  }): Promise<Chat>;
  managedWorkspace: BotManagedWorkspaceResolution;
}

export interface TelegramBotBindingReconciliationDependencies {
  listBindings(): Promise<readonly TelegramBotBinding[]>;
  disableBinding(botId: string): Promise<unknown>;
  withBotMutation<Result>(
    botId: string,
    action: (operations: TelegramBotMutationOperations) => Promise<Result>,
  ): Promise<Result>;
  getChat(chatId: string): Promise<Chat | null>;
  getChatAccess(chatId: string): Promise<{ botId: string }>;
}

export interface TelegramBotBindingReconciliationResult {
  inspected: number;
  repaired: number;
  disabled: number;
}

function assertBackingChat(binding: TelegramBotBinding, chat: Chat): void {
  if (
    chat.id !== binding.backingChatId ||
    chat.botId !== binding.botId ||
    chat.workspaceId !== binding.backingWorkspaceId
  ) {
    throw new Error("The Telegram binding's backing chat identity does not match its Bot home.");
  }
}

/**
 * Closes the crash window between durably binding a Telegram route and making
 * its Bot-owned backing chat visible. A binding is never left enabled unless
 * its exact chat and access policy can be proven under the Bot mutation gate.
 */
export async function reconcileTelegramBotBindings(
  deps: TelegramBotBindingReconciliationDependencies,
): Promise<TelegramBotBindingReconciliationResult> {
  const bindings = (await deps.listBindings()).filter((binding) => binding.enabled);
  let repaired = 0;
  let disabled = 0;

  for (const binding of bindings) {
    try {
      const didRepair = await deps.withBotMutation(binding.botId, async (operations) => {
        if (operations.managedWorkspace.workspaceId !== binding.backingWorkspaceId) {
          throw new Error("The Telegram binding points outside its Bot's managed home.");
        }

        const existing = await deps.getChat(binding.backingChatId);
        if (!existing) {
          const created = await operations.createChat({
            audienceId: telegramBotNoticeAudienceId(
              binding.profile,
              binding.ownerUserId,
            ),
            chatId: binding.backingChatId,
          });
          assertBackingChat(binding, created);
          return true;
        }

        assertBackingChat(binding, existing);
        const access = await deps.getChatAccess(binding.backingChatId);
        if (access.botId !== binding.botId) {
          throw new Error("The Telegram backing chat access policy has the wrong Bot owner.");
        }
        return false;
      });
      if (didRepair) repaired += 1;
    } catch {
      // unbind is the durable fail-closed boundary. If it cannot be persisted,
      // propagate so the caller can prevent Telegram from starting.
      await deps.disableBinding(binding.botId);
      disabled += 1;
    }
  }

  return { inspected: bindings.length, repaired, disabled };
}
