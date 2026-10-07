import { ipcMain } from "../platform.js";
import { chatStore } from "../services/chat-store.js";
import { botApplicationService } from "../services/bot-application-service-main.js";
import { configStore } from "../services/config-store.js";
import { BOT_DESKTOP_AUDIENCE_ID } from "../services/bot-runtime-authority-main.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { workspaceMutationGate } from "../services/workspace-mutation-gate.js";
import {
  BotCapabilityValidationError,
  parseBotNoticeAcknowledgement,
} from "../../renderer/shared/bot-capabilities.js";
import {
  BotApplicationUnavailableError,
} from "../services/bot-application-service.js";
import { BotRuntimeInventoryLeaseInvalidError } from "../services/bot-runtime-inventory-lease.js";
import {
  BotCapabilityCatalogConflictError,
  BotCapabilityRevisionConflictError,
  BotCapabilitySubsetError,
  BotCapabilityUnavailableError,
} from "../services/bot-capability-store-core.js";
import { botMutationGate } from "../services/bot-mutation-gate.js";
import { createMainBotAvatarApplicationAdapter } from "../services/bot-avatar-store-main.js";
import { projectBotAvatarForRenderer } from "../services/bot-avatar-renderer-projection.js";
import { getAidenRemoteRuntime } from "../services/aiden-remote-service-main.js";
import { botSessionRuntime } from "../services/bot-runtime/bot-session-main.js";
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
  parseBotAccessUpdateInput,
  parseBotCreateWithAccess,
  parseBotId,
  parseBotSend,
  parseBotSessionAction,
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
  ipcMain.handle("bots:create", async (_event, input: unknown) => {
    const parsed = parseBotCreateWithAccess(input);
    try {
      return await botApplicationService.createBot({
        audienceId: desktopAudienceId,
        bot: parsed.bot,
        access: parsed.access,
      });
    } catch (error) {
      throw botAccessUpdateRendererError(error);
    }
  });
  ipcMain.handle("bots:sessionState", async (_event, id: unknown) =>
    (await botSessionRuntime()).state(parseBotId(id)),
  );
  ipcMain.handle("bots:send", async (_event, input: unknown) => {
    const { botId, ...message } = parseBotSend(input);
    return (await botSessionRuntime()).send(botId, message);
  });
  ipcMain.handle("bots:resume", async (_event, input: unknown) => {
    const { botId, requestId } = parseBotSessionAction(input, "resume");
    return (await botSessionRuntime()).resume(botId, requestId);
  });
  ipcMain.handle("bots:dismiss", async (_event, input: unknown) => {
    const { botId, requestId } = parseBotSessionAction(input, "dismiss");
    return (await botSessionRuntime()).dismiss(botId, requestId);
  });
  // The desktop chat view still renders a Bot through its one ChatStore chat.
  // Returns that chat's id, creating it on first open, until the renderer
  // moves to the live projection (plan Task 1.4/2.3).
  ipcMain.handle("bots:openChat", async (_event, id: unknown) => {
    const botId = parseBotId(id);
    const chat =
      (await botApplicationService.getCanonicalChat(botId)) ??
      (await botApplicationService.createChat({ audienceId: desktopAudienceId, botId }));
    return { chatId: chat.id, updatedAt: chat.updatedAt, title: chat.title };
  });
  ipcMain.handle("bots:delete", async (_event, id: unknown) => {
    await (await botSessionRuntime()).deleteBot(parseBotId(id));
  });
  ipcMain.handle("bots:update", async (_event, input: unknown) => {
    return botApplicationService.updateBot(parseBotUpdate(input));
  });
  ipcMain.handle("bots:getCapabilityCatalog", async (_event, id: unknown) =>
    botApplicationService.capabilityCatalog(desktopAudienceId, id === undefined ? undefined : parseBotId(id)),
  );
  ipcMain.handle("bots:getBotAccess", async (_event, id: unknown) => {
    const botId = parseBotId(id);
    const [access, modelSelection, visionModelSelection] = await Promise.all([
      botApplicationService.getBotAccess(botId),
      botApplicationService.modelSelection(desktopAudienceId, botId),
      botApplicationService.visionModelSelection(desktopAudienceId, botId),
    ]);
    return { access, modelSelection, visionModelSelection };
  });
  ipcMain.handle("bots:updateBotAccess", async (_event, input: unknown) => {
    const parsed = parseBotAccessUpdateInput(input);
    try {
      return await botApplicationService.updateBotAccess({
        audienceId: desktopAudienceId,
        botId: parsed.botId,
        expectedRevision: parsed.expectedRevision,
        access: parsed.access,
      });
    } catch (error) {
      throw botAccessUpdateRendererError(error);
    }
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
}

/**
 * Surface the same recovery guidance the remote protocol gives iOS so the Mac
 * editor can reconcile instead of showing a raw service error.
 */
function botAccessUpdateRendererError(error: unknown): unknown {
  if (error instanceof BotRuntimeInventoryLeaseInvalidError) {
    return new Error("Bot capabilities kept changing. Review the latest choices and try again.");
  }
  if (error instanceof BotApplicationUnavailableError) {
    return new Error(
      error.reason === "archived"
        ? "Restore this Bot before making changes."
        : "This Bot no longer exists.",
    );
  }
  if (
    error instanceof BotCapabilityRevisionConflictError ||
    error instanceof BotCapabilityCatalogConflictError
  ) {
    return new Error("This Bot changed. Refresh it before trying again.");
  }
  if (error instanceof BotCapabilitySubsetError) {
    return new Error("This Bot cannot use more access than its policy allows.");
  }
  if (error instanceof BotCapabilityUnavailableError) {
    return new Error("Some selected Bot access is unavailable. Refresh and review it.");
  }
  if (error instanceof BotCapabilityValidationError) {
    return new Error(error.message);
  }
  return error;
}
