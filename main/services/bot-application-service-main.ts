import { createBotApplicationService } from "./bot-application-service.js";
import {
  botCapabilityCatalog,
  botCapabilityMigrationSeal,
  botCapabilityStore,
  botLifecycleJournal,
  botManagedWorkspace,
  prepareBotServiceStorage,
} from "./bot-capability-services-main.js";
import { botMutationGate } from "./bot-mutation-gate.js";
import { botStore } from "./bot-store.js";
import { chatStore } from "./chat-store.js";
import { chatApplicationService } from "./chat-application-service-main.js";
import {
  telegramBotBindingAuthority,
  telegramBotBindings,
} from "./telegram/telegram-bot-bindings.js";
import { reconcileTelegramBotBindings } from "./telegram/telegram-bot-binding-reconciliation.js";
import { assertTelegramBackingChatMayBeDeleted } from "./telegram/telegram-bot-chat-lifecycle.js";
import { removeArchivedBotFavorite } from "./bot-favorites-main.js";
import { botRuntimeInventoryLeases } from "./bot-runtime-inventory-lease.js";

export const botApplicationService = createBotApplicationService({
  botStore,
  chatStore,
  capabilityStore: botCapabilityStore,
  catalog: botCapabilityCatalog,
  managedWorkspace: botManagedWorkspace,
  lifecycleJournal: botLifecycleJournal,
  migrationSeal: botCapabilityMigrationSeal,
  mutationGate: botMutationGate,
  inventoryLeases: botRuntimeInventoryLeases,
  deleteChatWithEffects: (chatId, assertCurrent, onDeletionRollForward) =>
    chatApplicationService.remove(chatId, { assertCurrent, onDeletionRollForward }),
  onArchiveBot: async (botId) => {
    if (await telegramBotBindings.get(botId)) {
      await telegramBotBindingAuthority.disableBot(botId);
    }
    await removeArchivedBotFavorite(botId);
  },
  assertChatDeletionAllowed: (botId, chatId) =>
    assertTelegramBackingChatMayBeDeleted({
      botId,
      chatId,
      getBinding: (id) => telegramBotBindings.get(id),
    }),
});

let initialization: Promise<void> | undefined;

export function initializeBotApplicationService(): Promise<void> {
  initialization ??= prepareBotServiceStorage()
    .then(async () => {
      await botApplicationService.initialize();
      await reconcileTelegramBotBindings({
        listBindings: () => telegramBotBindings.list(),
        disableBinding: (botId) =>
          telegramBotBindingAuthority.disableBot(botId),
        withBotMutation: (botId, action) =>
          botApplicationService.withBotMutation(botId, action),
        getChat: (chatId) => chatStore.get(chatId),
        getChatAccess: (chatId) => botApplicationService.getChatAccess(chatId),
      });
    })
    .catch((error) => {
      initialization = undefined;
      throw error;
    });
  return initialization;
}
