import { compactionEngineFrom } from "../../renderer/shared/compaction.js";
import { ANTHROPIC_PROVIDER_ID } from "./anthropic-provider.js";
import { botStore } from "./bot-store.js";
import { chatStore } from "./chat-store.js";
import { OPENAI_CODEX_PROVIDER_ID } from "./codex-provider.js";
import { configStore } from "./config-store.js";
import { ContextLifecycleService } from "./context-lifecycle-service.js";
import { resolveGenerationThinkingLevel } from "./generation-runtime.js";
import { GOOGLE_PROVIDER_ID } from "./google-provider.js";
import { llmClient } from "./llm-client.js";
import { resolveModelRuntime, resolveCompactionModelMetadata } from "./model-runtime.js";
import { piCompactionSessionStore } from "./pi-compaction-session-store.js";
import { piUpgradeBehaviorEnabledAtStartup } from "./pi-upgrade-rollout.js";
import { piUpgradeChatBehaviorEligible } from "./pi-upgrade-rollout.js";
import { piUpgradeRolloutStore } from "./pi-upgrade-rollout-main.js";
import { isPackagedRuntime } from "../runtime-mode.js";
import { assistantUsageRecord } from "./usage-accounting.js";
import { usageStore } from "./usage-store.js";

export const contextLifecycleService = new ContextLifecycleService({
  compactionEnabled: () => piUpgradeBehaviorEnabledAtStartup,
  compactionEligible: async (chat) =>
    piUpgradeChatBehaviorEligible(await piUpgradeRolloutStore.load(), chat, {
      development: !isPackagedRuntime(),
      behaviorEnabled: piUpgradeBehaviorEnabledAtStartup,
    }),
  getChat: (chatId) => chatStore.get(chatId),
  listChatsByBot: (botId) => chatStore.listByBot(botId),
  isBotArchived: async (botId) => (await botStore.get(botId))?.archivedAt !== undefined,
  beginChatTurn: (chatId, turnId, ownerId) => llmClient.beginChatTurn(chatId, turnId, ownerId),
  openSession: async (chatId) => {
    const chat = await chatStore.get(chatId);
    if (!chat) throw new Error("Chat is unavailable.");
    return piCompactionSessionStore.openChat(chatId, chat);
  },
  resolveRuntime: resolveModelRuntime,
  resolveLocalModel: resolveCompactionModelMetadata,
  getCompactionEngine: async () =>
    compactionEngineFrom((await configStore.getSettings()).compactionEngine),
  recordUsage: (message, runtime) =>
    usageStore.record(
      assistantUsageRecord({
        message,
        provider: runtime.provider,
        model: runtime.model,
        source: "compaction",
      }),
    ),
  resolveThinkingLevel: async (chat, audience, runtime) => {
    const settings = await configStore.getSettings();
    const requested =
      audience.kind === "telegram"
        ? (settings.telegramProfiles?.[audience.profile]?.thinkingLevel ??
          settings.telegramThinkingLevel)
        : chat.providerId === GOOGLE_PROVIDER_ID
          ? settings.googleThinkingByModel?.[chat.model!]
          : chat.providerId === OPENAI_CODEX_PROVIDER_ID
            ? settings.codexThinkingByModel?.[chat.model!]
            : chat.providerId === ANTHROPIC_PROVIDER_ID
              ? settings.anthropicThinkingByModel?.[chat.model!]
              : settings.providerThinkingByModel?.[chat.providerId!]?.[chat.model!];
    return resolveGenerationThinkingLevel(chat.providerId!, runtime.model, requested);
  },
});
