import { app, logger } from "../platform.js";
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
import { botAvatarStore } from "./bot-avatar-store-main.js";
import { createBotLegacyTranscriptWipeMarker } from "./bot-legacy-transcript-wipe.js";
import { piCompactionSessionStore } from "./pi-compaction-session-store.js";
import { botRuntimeInventoryLeases } from "./bot-runtime-inventory-lease.js";
import os from "node:os";
import { fileBotFolderGrantJournal } from "./bot-folder-grant-journal.js";
import { botAccessPrivateRoots } from "./bot-runtime/bot-access-target.js";
import { aidenConfigDir } from "./aiden-config-dir.js";

const approvedFolderRuntime = async () => (await import("./aiden-remote-service-main.js")).getAidenRemoteRuntime();

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
  approvedFolders: {
    list: async () => (await (await approvedFolderRuntime()).state.snapshot()).approvedRoots,
    add: async (folderPath, input) => (await approvedFolderRuntime()).approvedRoots.addLocalFolder(folderPath, { ...input, botsOnly: true }),
    removeOwned: async (rootId, operationId) => (await approvedFolderRuntime()).approvedRoots.removeLocalRoot(rootId, operationId),
    withInventoryLock: async (action) => (await approvedFolderRuntime()).approvedRoots.withInventoryLock(action),
    target: { homeDirectory: os.homedir, privateRoots: () => botAccessPrivateRoots(app.getPath("userData"), aidenConfigDir()) },
    journal: fileBotFolderGrantJournal(() => app.getPath("userData")),
  },
  deleteChatWithEffects: (chatId, assertCurrent, onDeletionRollForward) =>
    chatApplicationService.remove(chatId, { assertCurrent, onDeletionRollForward }),
  deleteBotPhoto: (botId) => botAvatarStore.deleteBot(botId),
  // Its cookies and site data go with it; loaded lazily (Electron web contents).
  deleteBotBrowserProfile: async (botId) => {
    const managed = await botManagedWorkspace.resolve(botId).catch(() => undefined);
    const { browserService } = await import("./browser/service.js");
    await browserService.clearBotProfile(botId, managed?.workspaceId ?? "");
  },
  legacyTranscriptWipe: {
    ...createBotLegacyTranscriptWipeMarker(() => app.getPath("userData")),
    clearChatJournal: (chatId) => piCompactionSessionStore.deleteChat(chatId),
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
      // The durable Bot runtime starts once Bot identity is restored: it sweeps
      // orphaned sessions and records interrupted turns, and never resumes one.
      // A failure leaves Bots unavailable without blocking the rest of Aiden.
      void import("./bot-runtime/bot-session-main.js")
        .then(({ initializeBotSessionRuntime }) => initializeBotSessionRuntime())
        .catch((error: unknown) => logger.error("bots", "The Bot runtime could not start.", error));
    })
    .catch((error) => {
      initialization = undefined;
      throw error;
    });
  return initialization;
}
