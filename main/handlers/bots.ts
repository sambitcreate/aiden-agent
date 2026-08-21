import { ipcMain } from "../platform.js";
import { botStore } from "../services/bot-store.js";
import { chatStore } from "../services/chat-store.js";
import { configStore } from "../services/config-store.js";
import { llmClient } from "../services/llm-client.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { chatForRenderer } from "../services/visible-chat-projection.js";
import { workspaceMutationGate } from "../services/workspace-mutation-gate.js";
import {
  admitRendererOwnedWorkspaceOperation,
  workspaceOperationRegistry,
} from "../services/workspace-operation-registry.js";
import { isChatCreateReconciliationRequiredError } from "../services/chat-store-core.js";
import { appendReconciliationFailureMessage } from "../../renderer/shared/chat-message-contract.js";
import { botMutationGate } from "../services/bot-mutation-gate.js";
import { generateBotAvatarSuggestion } from "../services/bot-avatar-generator.js";
import { botAvatarOperations } from "../services/bot-avatar-operation-registry.js";
import { telegramBotBindings } from "../services/telegram/telegram-bot-bindings.js";
import { telegramService } from "../services/telegram/telegram-service.js";
import { normalizeTelegramProfileName } from "../services/telegram/telegram-profile-config.js";
import {
  parseBotAvatarSuggestionInput,
  parseBotAvatarRequestId,
  parseBotChatCreate,
  parseBotCreate,
  parseBotId,
  parseBotUpdate,
} from "./bot-params.js";

export function registerBotHandlers(): void {
  ipcMain.handle("bots:list", async (_event, includeArchived: unknown) => {
    if (includeArchived !== undefined && typeof includeArchived !== "boolean")
      throw new Error("Invalid bot list fields.");
    return botStore.list(includeArchived === true);
  });
  ipcMain.handle("bots:get", async (_event, id: unknown) => botStore.get(parseBotId(id)));
  ipcMain.handle("bots:create", async (_event, input: unknown) =>
    botStore.create(parseBotCreate(input)),
  );
  ipcMain.handle("bots:suggestAvatar", async (event, input: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Bot avatar design requires the active application document."),
    );
    const parsed = parseBotAvatarSuggestionInput(input);
    const operation = botAvatarOperations.admit(owner.documentId, parsed.requestId);
    const unsubscribe = owner.onInvalidated(operation.cancel);
    try {
      return await generateBotAvatarSuggestion(parsed, operation.signal);
    } finally {
      unsubscribe();
      operation.finish();
    }
  });
  ipcMain.handle("bots:cancelAvatarSuggestion", async (event, requestId: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Bot avatar design requires the active application document."),
    );
    return botAvatarOperations.cancel(owner.documentId, parseBotAvatarRequestId(requestId));
  });
  ipcMain.handle("bots:update", async (_event, input: unknown) => {
    const parsed = parseBotUpdate(input);
    return botMutationGate.run(parsed.id, () => botStore.update(parsed));
  });
  ipcMain.handle("bots:archive", async (_event, id: unknown) => {
    const botId = parseBotId(id);
    return botMutationGate.run(botId, async () => {
      const archived = await botStore.archive(botId);
      if (await telegramBotBindings.get(botId)) await telegramBotBindings.unbind(botId);
      return archived;
    });
  });
  ipcMain.handle("bots:restore", async (_event, id: unknown) => {
    const botId = parseBotId(id);
    return botMutationGate.run(botId, () => botStore.restore(botId));
  });
  ipcMain.handle("bots:listChats", async (_event, id: unknown) => {
    const botId = parseBotId(id);
    if (!(await botStore.get(botId))) throw new Error("This bot is no longer available.");
    return chatStore.listByBot(botId);
  });
  ipcMain.handle("bots:getTelegramBinding", async (_event, id: unknown) =>
    telegramBotBindings.get(parseBotId(id)),
  );
  ipcMain.handle("bots:listTelegramTargets", async () => {
    const [profiles, workspaces] = await Promise.all([
      telegramService.listProfiles(),
      configStore.listWorkspaces(),
    ]);
    const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
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
          workspaceName: workspaceId ? workspaceNames.get(workspaceId) : undefined,
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
          workspaceName: target.workspaceId ? workspaceNames.get(target.workspaceId) : undefined,
        });
      }
    }
    return options;
  });
  ipcMain.handle("bots:bindTelegram", async (_event, input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid Telegram bot binding fields.");
    const raw = input as Record<string, unknown>;
    if (!Object.keys(raw).every((key) => ["botId", "profile", "threadId"].includes(key)))
      throw new Error("Invalid Telegram bot binding fields.");
    const botId = parseBotId(raw.botId);
    const profileName = normalizeTelegramProfileName(
      typeof raw.profile === "string" ? raw.profile : "",
    );
    const threadId = raw.threadId === undefined
      ? undefined
      : typeof raw.threadId === "number" && Number.isSafeInteger(raw.threadId) && raw.threadId > 0
        ? raw.threadId
        : (() => { throw new Error("Invalid Telegram thread id."); })();
    return botMutationGate.run(botId, async () => {
      const bot = await botStore.get(botId);
      if (!bot || bot.archivedAt !== undefined) throw new Error("Restore this bot before binding Telegram.");
      const profile = (await telegramService.listProfiles()).find(({ name }) => name === profileName);
      if (!profile || !profile.hasToken || profile.settings.allowedUserId === undefined)
        throw new Error("Choose a Telegram profile that has a token and paired owner.");
      const target = threadId === undefined
        ? {
            chatId: profile.settings.allowedUserId,
            workspaceId: profile.settings.workspaceId,
          }
        : (await telegramService.listTargets(profileName)).find(
            (candidate) => candidate.threadId === threadId && candidate.chatId === profile.settings.allowedUserId,
          );
      if (!target) throw new Error("That Telegram thread is no longer available.");
      if (!target.workspaceId)
        throw new Error("Choose a live folder workspace for this Telegram target before binding it.");
      const workspaceAdmission = workspaceMutationGate.admit(target.workspaceId);
      try {
        if (workspaceAdmission.signal.aborted || !(await configStore.getWorkspace(target.workspaceId)))
          throw new Error("The Telegram target workspace is no longer available.");
        const binding = await telegramBotBindings.bind({
          botId,
          profile: profileName,
          chatId: target.chatId,
          ...(threadId === undefined ? {} : { threadId }),
          ownerUserId: profile.settings.allowedUserId,
          workspaceId: target.workspaceId,
        });
        try {
          const existing = await chatStore.get(binding.backingChatId);
          if (existing) {
            if (existing.botId !== botId || existing.workspaceId !== target.workspaceId)
              throw new Error("This bot’s Telegram conversation belongs to a different workspace.");
          } else {
            await chatStore.create({
              id: binding.backingChatId,
              title: `Telegram · ${bot.name}`,
              workspaceId: target.workspaceId,
              botId,
              providerId: profile.settings.providerId,
              model: profile.settings.model,
              assertCurrent: () => {
                if (workspaceAdmission.signal.aborted)
                  throw new Error("The Telegram target workspace changed before binding completed.");
              },
            });
          }
          return binding;
        } catch (error) {
          await telegramBotBindings.unbind(botId).catch(() => undefined);
          throw error;
        }
      } finally {
        workspaceAdmission.release();
      }
    });
  });
  ipcMain.handle("bots:unbindTelegram", async (_event, id: unknown) => {
    const botId = parseBotId(id);
    return botMutationGate.run(botId, () => telegramBotBindings.unbind(botId));
  });
  ipcMain.handle("bots:createChat", async (event, input: unknown) => {
    const parsed = parseBotChatCreate(input);
    return botMutationGate.run(parsed.botId, async () => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Bot conversations require the active application document."),
    );
    if (llmClient.requiresAppendReconciliation(owner.documentId))
      throw new Error(appendReconciliationFailureMessage("blocked"));
    const bot = await botStore.get(parsed.botId);
    if (!bot || bot.archivedAt !== undefined)
      throw new Error("This bot is not available for new conversations.");
    if (!(await configStore.getWorkspace(parsed.workspaceId)))
      throw new Error("The selected workspace is no longer available.");

    const mutationAdmission = workspaceMutationGate.admit(parsed.workspaceId);
    let workspaceOperation:
      ReturnType<typeof admitRendererOwnedWorkspaceOperation> | undefined;
    const assertCurrent = () => {
      if (
        owner.isDestroyed() ||
        mutationAdmission.signal.aborted ||
        workspaceOperation?.signal.aborted
      ) {
        throw new Error("The workspace changed before the bot conversation was created.");
      }
      if (llmClient.requiresAppendReconciliation(owner.documentId))
        throw new Error(appendReconciliationFailureMessage("blocked"));
    };
    try {
      workspaceOperation = admitRendererOwnedWorkspaceOperation(
        workspaceOperationRegistry,
        owner,
        parsed.workspaceId,
      );
      return chatForRenderer(await chatStore.create({ ...parsed, assertCurrent }));
    } catch (error) {
      if (isChatCreateReconciliationRequiredError(error)) {
        llmClient.markAppendReconciliationRequired(owner.documentId);
        owner.onInvalidated(() =>
          llmClient.clearAppendReconciliationRequired(owner.documentId),
        );
        throw new Error(appendReconciliationFailureMessage("blocked"));
      }
      throw error;
    } finally {
      workspaceOperation?.release();
      mutationAdmission.release();
    }
    });
  });
}
