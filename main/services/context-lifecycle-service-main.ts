import { isAcpHarnessProvider } from "../../renderer/shared/acp-harness.js";
import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { compactionEngineFrom } from "../../renderer/shared/compaction.js";
import { customModelThinkingLevels } from "../../renderer/shared/custom-model-options.js";
import { ANTHROPIC_PROVIDER_ID } from "./anthropic-provider.js";
import { chatStore } from "./chat-store.js";
import { OPENAI_CODEX_PROVIDER_ID } from "./codex-provider.js";
import { configStore } from "./config-store.js";
import { ContextLifecycleService } from "./context-lifecycle-service.js";
import { resolveGenerationThinkingLevel } from "./generation-runtime.js";
import { runsWorkspaceChatHooks } from "./hooks-tool.js";
import { GOOGLE_PROVIDER_ID } from "./google-provider.js";
import { llmClient } from "./llm-client.js";
import { resolveModelRuntime, resolveCompactionModelMetadata } from "./model-runtime.js";
import { piCompactionSessionStore } from "./pi-compaction-session-store.js";
import { piUpgradeBehaviorEnabledAtStartup } from "./pi-upgrade-rollout.js";
import { piUpgradeChatBehaviorEligible } from "./pi-upgrade-rollout.js";
import { piUpgradeRolloutStore } from "./pi-upgrade-rollout-main.js";
import { isPackagedRuntime } from "../runtime-mode.js";
import { assistantUsageRecord, isLocalModelProvider } from "./usage-accounting.js";
import { spending } from "./spending-main.js";
import { responseCostUsd, spendCounts } from "./spending-service.js";
import { usageStore } from "./usage-store.js";
import {
  createWorkspaceChatHooks,
  markWorkspaceChatCompacted,
  preCompactSummaryInstructions,
} from "./workspace-chat-hooks.js";

export const contextLifecycleService = new ContextLifecycleService({
  compactionEnabled: () => piUpgradeBehaviorEnabledAtStartup,
  compactionEligible: async (chat) =>
    piUpgradeChatBehaviorEligible(await piUpgradeRolloutStore.load(), chat, {
      development: !isPackagedRuntime(),
      behaviorEnabled: piUpgradeBehaviorEnabledAtStartup,
    }),
  skillsEnabled: async () => (await configStore.getSettings()).skillsEnabled !== false,
  getChat: (chatId) => chatStore.get(chatId),
  listChatsByBot: (botId) => chatStore.listByBot(botId),
  beginChatTurn: (chatId, turnId, ownerId) => llmClient.beginChatTurn(chatId, turnId, ownerId),
  openSession: async (chatId) => {
    const chat = await chatStore.get(chatId);
    if (!chat) throw new Error("Chat is unavailable.");
    const opened = await piCompactionSessionStore.openChatIfEligible(chatId, chat);
    // Rollout-ineligible chats (pre-activation or deferred v3 migration) resolve
    // compaction benignly instead of throwing a fail-closed journal error.
    return opened.session ?? null;
  },
  resolveRuntime: resolveModelRuntime,
  resolveLocalModel: resolveCompactionModelMetadata,
  getCompactionPreferences: async () => {
    const settings = await configStore.getSettings();
    return { compactionEngine: compactionEngineFrom(settings.compactionEngine), compactionModelOverrides: settings.compactionModelOverrides };
  },
  recordUsage: async (message, runtime, chatId) => {
    // A compaction summary is the chat's spending too.
    const cost = responseCostUsd(message);
    if (cost > 0) {
      const chat = await chatStore.get(chatId).catch(() => undefined);
      const owner = chat?.botId ? { kind: "bot" as const, id: chat.botId } : { kind: "chat" as const, id: chatId };
      if (await spendCounts({ local: isLocalModelProvider(runtime.provider), provider: runtime.provider, models: runtime.models })) {
        await spending.record(owner, cost).catch(() => undefined);
      }
    }
    await usageStore.record(
      assistantUsageRecord({
        message,
        provider: runtime.provider,
        model: runtime.model,
        source: "compaction",
      }),
    );
  },
  // PreCompact for a compaction outside a turn: the person's Compact action
  // ("manual") or recovery ("auto"), in the chats whose turns run hooks.
  preCompact: async (chat, { audience, trigger, signal }) => {
    if (
      !runsWorkspaceChatHooks({
        usageSource: "chat",
        interactionSurface: audience.kind === "telegram" ? "telegram" : undefined,
        bot: Boolean(chat.botId),
        design: chat.owner !== undefined,
        assistant: persistedChatWorkspaceId(chat.workspaceId) === ASSISTANT_WORKSPACE_ID,
        harnessProvider: Boolean(chat.providerId && isAcpHarnessProvider(chat.providerId)),
      })
    ) {
      return undefined;
    }
    const workspace = chat.workspaceId ? await configStore.getWorkspace(chat.workspaceId) : undefined;
    const hooks = createWorkspaceChatHooks({
      chatId: chat.id,
      ...(workspace?.folderPath && workspace.noWorkspace !== true ? { workspaceRoot: workspace.folderPath } : {}),
    });
    return preCompactSummaryInstructions(hooks, {
      trigger,
      reason: trigger === "manual" ? "manual" : "automatic-recovery",
      signal,
    });
  },
  // The next SessionStart reports `compact`, as after a compaction in a turn.
  compacted: (chat) => markWorkspaceChatCompacted(chat.id),
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
              : runtime.provider.isBuiltin || (runtime.provider.kind === "openai" &&
                  customModelThinkingLevels(runtime.provider.modelMetadata?.[chat.model!]?.overrides))
                ? settings.providerThinkingByModel?.[chat.providerId!]?.[chat.model!]
                : undefined;
    return resolveGenerationThinkingLevel(chat.providerId!, runtime.model, requested);
  },
});
