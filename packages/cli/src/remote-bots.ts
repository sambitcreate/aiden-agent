import { createCliBotAvatars } from "./bot-avatars.ts";
import { join } from "node:path";
import { AidenRemoteBotService, EMPTY_AIDEN_REMOTE_BOT_FAVORITES, type AidenRemoteBotFavoritesSnapshot } from "../../../main/services/aiden-remote-bots.js";
import { AidenRemoteBotFileService } from "../../../main/services/aiden-remote-bot-files.js";
import { createBotArchivedFileReadAuthority } from "../../../main/services/bot-archived-file-read-authority.js";
import { createBotInboxProjectionService, mergeBotInboxActivityPreviews } from "../../../main/services/bot-inbox-projection.js";
import { AidenRemoteServiceError } from "../../../main/services/aiden-remote-errors.js";
import type { AidenIdempotencyLedger, AidenIdempotencySnapshot } from "../../../main/services/aiden-remote-operation-contract.js";
import type { createCliBots } from "./bots.ts";
import type { createCliRemoteChats } from "./remote-chats.ts";
import type { createDaemonChats } from "./daemon-chats.ts";
import { JsonStore } from "./state.ts";

export function createCliRemoteBots(agentDir: string, instanceId: string, runtime: Awaited<ReturnType<typeof createCliBots>>, daemon: ReturnType<typeof createDaemonChats>, chatApi: Awaited<ReturnType<typeof createCliRemoteChats>>,
  idempotency: AidenIdempotencyLedger, persistIdempotency: (value: AidenIdempotencySnapshot) => Promise<void>) {
  const favorites = new JsonStore<AidenRemoteBotFavoritesSnapshot>(join(agentDir, "bot-favorites.json"), EMPTY_AIDEN_REMOTE_BOT_FAVORITES);
  const bots = new AidenRemoteBotService({ avatar: createCliBotAvatars(agentDir, instanceId), application: runtime.application, chatStore: daemon.chatStore, favorites, idempotency, persistIdempotency,
    inbox: { list: (deviceId, input) => createBotInboxProjectionService({
      listBots: () => runtime.application.list(true), listChatMetadata: () => daemon.chatStore.list(),
      projectBatch: async (request) => mergeBotInboxActivityPreviews(request, await chatApi.streams.projectChatActivities(deviceId, request.map(({ chatId }) => chatId))),
    }).list(input) },
    resolveProviderModel: async ({ audienceId, botId, providerId, modelId }) => {
      const lease = runtime.inventoryLeases.acquire();
      try {
        const defaultSelection = providerId === undefined || modelId === undefined ? await chatApi.models.resolve() : undefined;
        const retained = await runtime.capabilities.getBotBinding(botId);
        const snapshot = await runtime.catalog.snapshot({ audienceId, botId, ...(retained ? { retainedBindings: [retained] } : {}) });
        lease.assertCurrent();
        const provider = snapshot.resources.providers.find((item) => providerId ? item.option.id === providerId : item.sourceId === defaultSelection?.providerId);
        const model = provider?.models.find((item) => modelId ? item.option.id === modelId : item.sourceId === defaultSelection?.modelId);
        if (!provider?.option.available || !model?.option.available) throw new AidenRemoteServiceError("operation_stale", "Refresh the Bot capability list and choose an available model.", 409, true);
        return { providerId: provider.sourceId, model: model.sourceId, assertCurrent: lease.assertCurrent, release: lease.release };
      } catch (error) { lease.release(); throw error; }
    },
  });
  const botFiles = new AidenRemoteBotFileService({ instanceId, authority: runtime.authority, chats: daemon.chatStore,
    archivedRead: createBotArchivedFileReadAuthority({ bots: runtime.botStore, chats: daemon.chatStore, capabilities: runtime.capabilities, catalog: runtime.catalog,
      managedWorkspace: runtime.managedWorkspace, mutationGate: runtime.mutationGate, inventoryLeases: runtime.inventoryLeases }),
  });
  return { bots, botFiles, botNotice: { status: (id: string) => runtime.application.noticeStatus(id), acknowledge: (id: string, value: import("../../../renderer/shared/bot-capabilities.js").BotNoticeAcknowledgement) => runtime.application.acknowledgeNotice(id, value) } };
}
