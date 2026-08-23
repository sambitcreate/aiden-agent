import { ipcMain } from "../platform.js";
import { chatStore } from "../services/chat-store.js";
import { botApplicationService } from "../services/bot-application-service-main.js";
import { configStore } from "../services/config-store.js";
import { llmClient } from "../services/llm-client.js";
import { BOT_DESKTOP_AUDIENCE_ID } from "../services/bot-runtime-authority-main.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { chatForRenderer } from "../services/visible-chat-projection.js";
import { workspaceMutationGate } from "../services/workspace-mutation-gate.js";
import { isChatCreateReconciliationRequiredError } from "../services/chat-store-core.js";
import { appendReconciliationFailureMessage } from "../../renderer/shared/chat-message-contract.js";
import { parseBotNoticeAcknowledgement } from "../../renderer/shared/bot-capabilities.js";
import { botMutationGate } from "../services/bot-mutation-gate.js";
import { generateBotAvatarSuggestion } from "../services/bot-avatar-generator.js";
import { botAvatarOperations } from "../services/bot-avatar-operation-registry.js";
import { createMainBotAvatarApplicationAdapter } from "../services/bot-avatar-store-main.js";
import { projectBotAvatarForRenderer } from "../services/bot-avatar-renderer-projection.js";
import { getAidenRemoteRuntime } from "../services/aiden-remote-service-main.js";
import {
  telegramBotBindingAuthority,
  telegramBotBindings,
} from "../services/telegram/telegram-bot-bindings.js";
import { telegramService } from "../services/telegram/telegram-service.js";
import {
  normalizeTelegramProfileName,
  telegramBotNoticeAudienceId,
} from "../services/telegram/telegram-profile-config.js";
import { telegramProfileMutationFence } from "../services/telegram/telegram-profile-mutation-fence.js";
import {
  parseBotAvatarSuggestionInput,
  parseBotAvatarRequestId,
  parseBotChatCreate,
  parseBotCreate,
  parseBotId,
  parseBotRevision,
  parseBotUpdate,
} from "./bot-params.js";

export function registerBotHandlers(): void {
  const desktopAudienceId = BOT_DESKTOP_AUDIENCE_ID;
  const pairedTelegramAudience = async (profileValue: unknown) => {
    const profileName = normalizeTelegramProfileName(
      typeof profileValue === "string" ? profileValue : "",
    );
    const profile = (await telegramService.listProfiles()).find(
      ({ name }) => name === profileName,
    );
    const ownerUserId = profile?.settings.allowedUserId;
    if (!profile || ownerUserId === undefined) {
      throw new Error("Choose a Telegram profile with a paired owner.");
    }
    return {
      profileName,
      audienceId: telegramBotNoticeAudienceId(profileName, ownerUserId),
    };
  };
  ipcMain.handle("bots:getAccessNotice", async () =>
    botApplicationService.noticeStatus(desktopAudienceId),
  );
  ipcMain.handle("bots:acknowledgeAccessNotice", async (event, input: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Bot access notice requires the active application document."),
    );
    return botApplicationService.acknowledgeNotice(
      desktopAudienceId,
      parseBotNoticeAcknowledgement(input),
      () => {
        if (owner.isDestroyed()) {
          throw new Error("The application changed before Bot access was confirmed.");
        }
      },
    );
  });
  ipcMain.handle("bots:getTelegramAccessNotice", async (_event, profile: unknown) => {
    const principal = await pairedTelegramAudience(profile);
    return botApplicationService.noticeStatus(principal.audienceId);
  });
  ipcMain.handle(
    "bots:acknowledgeTelegramAccessNotice",
    async (event, input: unknown) => {
      const owner = rendererDocumentOwner(
        event,
        () => new Error("Bot access notice requires the active application document."),
      );
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Invalid Telegram Bot access notice fields.");
      }
      const raw = input as Record<string, unknown>;
      if (
        !Object.keys(raw).every((key) =>
          key === "profile" || key === "acknowledgement",
        ) ||
        Object.keys(raw).length !== 2
      ) {
        throw new Error("Invalid Telegram Bot access notice fields.");
      }
      const principal = await pairedTelegramAudience(raw.profile);
      return botApplicationService.acknowledgeNotice(
        principal.audienceId,
        parseBotNoticeAcknowledgement(raw.acknowledgement),
        () => {
          if (owner.isDestroyed()) {
            throw new Error("The application changed before Bot access was confirmed.");
          }
        },
      );
    },
  );
  ipcMain.handle("bots:list", async (_event, includeArchived: unknown) => {
    if (includeArchived !== undefined && typeof includeArchived !== "boolean")
      throw new Error("Invalid bot list fields.");
    return botApplicationService.list(includeArchived === true);
  });
  ipcMain.handle("bots:get", async (_event, id: unknown) =>
    botApplicationService.get(parseBotId(id)),
  );
  ipcMain.handle("bots:getCanonicalPhoto", async (_event, id: unknown) => {
    const botId = parseBotId(id);
    const instanceId = (await (await getAidenRemoteRuntime()).state.snapshot()).instanceId;
    return projectBotAvatarForRenderer(botId, {
      bots: botApplicationService,
      avatar: createMainBotAvatarApplicationAdapter(instanceId),
    });
  });
  ipcMain.handle("bots:create", async (_event, input: unknown) =>
    botApplicationService.createBot({
      audienceId: desktopAudienceId,
      bot: parseBotCreate(input),
    }),
  );
  ipcMain.handle("bots:suggestAvatar", async (event, input: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () =>
        new Error(
          "Bot avatar design requires the active application document.",
        ),
    );
    const parsed = parseBotAvatarSuggestionInput(input);
    const operation = botAvatarOperations.admit(
      owner.documentId,
      parsed.requestId,
    );
    const unsubscribe = owner.onInvalidated(operation.cancel);
    try {
      return await generateBotAvatarSuggestion(parsed, operation.signal);
    } finally {
      unsubscribe();
      operation.finish();
    }
  });
  ipcMain.handle(
    "bots:cancelAvatarSuggestion",
    async (event, requestId: unknown) => {
      const owner = rendererDocumentOwner(
        event,
        () =>
          new Error(
            "Bot avatar design requires the active application document.",
          ),
      );
      return botAvatarOperations.cancel(
        owner.documentId,
        parseBotAvatarRequestId(requestId),
      );
    },
  );
  ipcMain.handle("bots:update", async (_event, input: unknown) => {
    return botApplicationService.updateBot(parseBotUpdate(input));
  });
  ipcMain.handle("bots:archive", async (_event, id: unknown) => {
    if (!id || typeof id !== "object" || Array.isArray(id)) {
      throw new Error("Invalid bot archive fields.");
    }
    const input = id as Record<string, unknown>;
    if (
      !Object.keys(input).every(
        (key) => key === "id" || key === "expectedRevision",
      )
    ) {
      throw new Error("Invalid bot archive fields.");
    }
    return botApplicationService.archiveBot({
      botId: parseBotId(input.id),
      expectedRevision: parseBotRevision(input.expectedRevision),
    });
  });
  ipcMain.handle("bots:restore", async (_event, id: unknown) => {
    if (!id || typeof id !== "object" || Array.isArray(id)) {
      throw new Error("Invalid bot restore fields.");
    }
    const input = id as Record<string, unknown>;
    if (
      !Object.keys(input).every(
        (key) => key === "id" || key === "expectedRevision",
      )
    ) {
      throw new Error("Invalid bot restore fields.");
    }
    return botApplicationService.restoreBot({
      botId: parseBotId(input.id),
      expectedRevision: parseBotRevision(input.expectedRevision),
    });
  });
  ipcMain.handle("bots:listChats", async (_event, id: unknown) => {
    return botApplicationService.listChats(parseBotId(id));
  });
  ipcMain.handle("bots:getTelegramBinding", async (_event, id: unknown) =>
    telegramBotBindings.get(parseBotId(id)),
  );
  ipcMain.handle("bots:listTelegramTargets", async () => {
    const [profiles, workspaces] = await Promise.all([
      telegramService.listProfiles(),
      configStore.listWorkspaces(),
    ]);
    const workspaceNames = new Map(
      workspaces.map((workspace) => [workspace.id, workspace.name]),
    );
    const options = [];
    for (const profile of profiles) {
      const paired = profile.settings.allowedUserId !== undefined;
      const workspaceId = profile.settings.workspaceId;
      if (paired) {
        options.push({
          profile: profile.name,
          label: `${profile.name} · Direct message`,
          paired,
          hasToken: profile.hasToken,
          enabled: profile.settings.enabled === true,
          chatId: profile.settings.allowedUserId,
          workspaceId,
          workspaceName: workspaceId
            ? workspaceNames.get(workspaceId)
            : undefined,
        });
      }
      for (const target of await telegramService.listTargets(profile.name)) {
        options.push({
          profile: profile.name,
          label: `${profile.name} · ${target.name}`,
          paired,
          hasToken: profile.hasToken,
          enabled: profile.settings.enabled === true,
          chatId: target.chatId,
          threadId: target.threadId,
          workspaceId: target.workspaceId,
          workspaceName: target.workspaceId
            ? workspaceNames.get(target.workspaceId)
            : undefined,
        });
      }
    }
    return options;
  });
  ipcMain.handle("bots:bindTelegram", async (_event, input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid Telegram bot binding fields.");
    const raw = input as Record<string, unknown>;
    if (
      !Object.keys(raw).every((key) =>
        ["botId", "profile", "threadId"].includes(key),
      )
    )
      throw new Error("Invalid Telegram bot binding fields.");
    const botId = parseBotId(raw.botId);
    const profileName = normalizeTelegramProfileName(
      typeof raw.profile === "string" ? raw.profile : "",
    );
    const threadId =
      raw.threadId === undefined
        ? undefined
        : typeof raw.threadId === "number" &&
            Number.isSafeInteger(raw.threadId) &&
            raw.threadId > 0
          ? raw.threadId
          : (() => {
              throw new Error("Invalid Telegram thread id.");
            })();
    return botApplicationService.withBotMutation(botId, (operations) =>
      telegramProfileMutationFence.runBinding(
        profileName,
        async (profileAdmission) => {
          const profile = (await telegramService.listProfiles()).find(
            ({ name }) => name === profileName,
          );
          if (
            !profile ||
            !profile.hasToken ||
            profile.settings.allowedUserId === undefined
          )
            throw new Error(
              "Choose a Telegram profile that has a token and paired owner.",
            );
          const target =
            threadId === undefined
              ? {
                  chatId: profile.settings.allowedUserId,
                  workspaceId: profile.settings.workspaceId,
                }
              : (await telegramService.listTargets(profileName)).find(
                  (candidate) =>
                    candidate.threadId === threadId &&
                    candidate.chatId === profile.settings.allowedUserId,
                );
          if (!target)
            throw new Error("That Telegram thread is no longer available.");
          if (!target.workspaceId)
            throw new Error(
              "Choose a live folder workspace for this Telegram target before binding it.",
            );
          const workspaceAdmission = workspaceMutationGate.admit(
            target.workspaceId,
          );
          try {
            if (
              workspaceAdmission.signal.aborted ||
              !(await configStore.getWorkspace(target.workspaceId))
            )
              throw new Error(
                "The Telegram target workspace is no longer available.",
              );
            profileAdmission.assertCurrent();
            const binding = await telegramBotBindings.bind({
              botId,
              profile: profileName,
              chatId: target.chatId,
              ...(threadId === undefined ? {} : { threadId }),
              ownerUserId: profile.settings.allowedUserId,
              workspaceId: target.workspaceId,
              backingWorkspaceId: operations.managedWorkspace.workspaceId,
            });
            try {
              const existing = await chatStore.get(binding.backingChatId);
              if (existing) {
                if (
                  existing.botId !== botId ||
                  existing.workspaceId !== binding.backingWorkspaceId
                ) {
                  throw new Error(
                    "This bot’s Telegram conversation has a different backing home.",
                  );
                }
                const policy = await botApplicationService.getChatAccess(
                  binding.backingChatId,
                );
                if (policy.botId !== botId) {
                  throw new Error(
                    "This bot’s Telegram conversation has invalid access state.",
                  );
                }
              } else {
                await operations.createChat({
                  audienceId: telegramBotNoticeAudienceId(
                    profileName,
                    profile.settings.allowedUserId,
                  ),
                  chatId: binding.backingChatId,
                  providerId: profile.settings.providerId,
                  model: profile.settings.model,
                  assertCurrent: () => {
                    profileAdmission.assertCurrent();
                    if (workspaceAdmission.signal.aborted)
                      throw new Error(
                        "The Telegram target workspace changed before binding completed.",
                      );
                  },
                });
              }
              return binding;
            } catch (error) {
              await telegramBotBindingAuthority
                .disableBot(botId)
                .catch(() => undefined);
              throw error;
            }
          } finally {
            workspaceAdmission.release();
          }
        },
      ),
    );
  });
  ipcMain.handle("bots:unbindTelegram", async (_event, id: unknown) => {
    const botId = parseBotId(id);
    return botMutationGate.run(botId, () =>
      telegramBotBindingAuthority.disableBot(botId),
    );
  });
  ipcMain.handle("bots:createChat", async (event, input: unknown) => {
    const parsed = parseBotChatCreate(input);
    const owner = rendererDocumentOwner(
      event,
      () =>
        new Error("Bot conversations require the active application document."),
    );
    if (llmClient.requiresAppendReconciliation(owner.documentId))
      throw new Error(appendReconciliationFailureMessage("blocked"));
    const assertCurrent = () => {
      if (owner.isDestroyed())
        throw new Error(
          "The application changed before the Bot conversation was created.",
        );
      if (llmClient.requiresAppendReconciliation(owner.documentId))
        throw new Error(appendReconciliationFailureMessage("blocked"));
    };
    try {
      return chatForRenderer(
        await botApplicationService.createChat({
          audienceId: desktopAudienceId,
          botId: parsed.botId,
          providerId: parsed.providerId,
          model: parsed.model,
          assertCurrent,
        }),
      );
    } catch (error) {
      if (isChatCreateReconciliationRequiredError(error)) {
        llmClient.markAppendReconciliationRequired(owner.documentId);
        owner.onInvalidated(() =>
          llmClient.clearAppendReconciliationRequired(owner.documentId),
        );
        throw new Error(appendReconciliationFailureMessage("blocked"));
      }
      throw error;
    }
  });
}
