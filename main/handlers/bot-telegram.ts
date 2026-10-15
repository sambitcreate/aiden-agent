// Bot ↔ Telegram binding IPC.
//
// Binding is main-owned: the target is resolved from the paired owner's own
// Telegram profile (never from renderer-supplied chat ids), serialized behind
// the Bot mutation and the profile's reset/delete fence, and its backing chat
// is created through the Bot application service's mutation operations.

import type { BotApplicationService } from "../services/bot-application-service.js";
import type { Chat, TelegramProfileSettings } from "../services/types.js";
import type { TelegramBotBinding, TelegramBotBindingInput } from "../services/telegram/telegram-bot-binding-store.js";
import type { TelegramProfileMutationAdmission } from "../services/telegram/telegram-profile-mutation-fence.js";
import { normalizeTelegramProfileName, telegramBotNoticeAudienceId } from "../services/telegram/telegram-profile-config.js";
import { parseBotId } from "./bot-params.js";

export interface BotTelegramProfile {
  name: string;
  hasToken: boolean;
  settings: Pick<TelegramProfileSettings, "enabled" | "allowedUserId" | "providerId" | "model" | "workspaceId">;
}

export interface BotTelegramTarget {
  threadId: number;
  chatId: number;
  name: string;
  workspaceId?: string;
}

export interface BotTelegramHandlerDependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  service: Pick<BotApplicationService, "withBotMutation" | "getChatAccess">;
  telegram: {
    listProfiles(): Promise<readonly BotTelegramProfile[]>;
    listTargets(profile: string): Promise<readonly BotTelegramTarget[]>;
  };
  bindings: {
    get(botId: string): Promise<TelegramBotBinding | null>;
    bind(input: TelegramBotBindingInput): Promise<TelegramBotBinding>;
  };
  /** Reduction-only authority; usable even when Bot mutation is unhealthy. */
  bindingAuthority: { disableBot(botId: string): Promise<TelegramBotBinding> };
  profileFence: {
    runBinding<Result>(
      profile: string,
      action: (admission: TelegramProfileMutationAdmission) => Promise<Result>,
    ): Promise<Result>;
  };
  botMutationGate: { run<Result>(botId: string, operation: () => Promise<Result>): Promise<Result> };
  workspaceGate: { admit(workspaceId: string): { signal: AbortSignal; release(): void } };
  workspaces: {
    list(): Promise<readonly { id: string; name: string }[]>;
    get(workspaceId: string): Promise<unknown>;
  };
  chats: { get(chatId: string): Promise<Pick<Chat, "botId" | "workspaceId"> | null | undefined> };
}

export function registerBotTelegramHandlers<Event>(deps: BotTelegramHandlerDependencies<Event>): void {
  deps.handle("bots:getTelegramBinding", async (_event, id: unknown) =>
    deps.bindings.get(parseBotId(id)),
  );
  deps.handle("bots:listTelegramTargets", async () => {
    const [profiles, workspaces] = await Promise.all([
      deps.telegram.listProfiles(),
      deps.workspaces.list(),
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
      for (const target of await deps.telegram.listTargets(profile.name)) {
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
  deps.handle("bots:bindTelegram", async (_event, input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid Telegram bot binding fields.");
    const raw = input as Record<string, unknown>;
    if (!Object.keys(raw).every((key) => ["botId", "profile", "threadId"].includes(key)))
      throw new Error("Invalid Telegram bot binding fields.");
    const botId = parseBotId(raw.botId);
    const profileName = normalizeTelegramProfileName(
      typeof raw.profile === "string" ? raw.profile : "",
    );
    const threadId =
      raw.threadId === undefined
        ? undefined
        : typeof raw.threadId === "number" && Number.isSafeInteger(raw.threadId) && raw.threadId > 0
          ? raw.threadId
          : (() => {
              throw new Error("Invalid Telegram thread id.");
            })();
    return deps.service.withBotMutation(botId, (operations) =>
      deps.profileFence.runBinding(profileName, async (profileAdmission) => {
        const profile = (await deps.telegram.listProfiles()).find(({ name }) => name === profileName);
        if (!profile || !profile.hasToken || profile.settings.allowedUserId === undefined)
          throw new Error("Choose a Telegram profile that has a token and paired owner.");
        const ownerUserId = profile.settings.allowedUserId;
        const target =
          threadId === undefined
            ? { chatId: ownerUserId, workspaceId: profile.settings.workspaceId }
            : (await deps.telegram.listTargets(profileName)).find(
                (candidate) => candidate.threadId === threadId && candidate.chatId === ownerUserId,
              );
        if (!target) throw new Error("That Telegram thread is no longer available.");
        if (!target.workspaceId)
          throw new Error("Choose a live folder workspace for this Telegram target before binding it.");
        const targetWorkspaceId = target.workspaceId;
        const workspaceAdmission = deps.workspaceGate.admit(targetWorkspaceId);
        try {
          if (workspaceAdmission.signal.aborted || !(await deps.workspaces.get(targetWorkspaceId)))
            throw new Error("The Telegram target workspace is no longer available.");
          profileAdmission.assertCurrent();
          const binding = await deps.bindings.bind({
            botId,
            profile: profileName,
            chatId: target.chatId,
            ...(threadId === undefined ? {} : { threadId }),
            ownerUserId,
            workspaceId: targetWorkspaceId,
            backingWorkspaceId: operations.managedWorkspace.workspaceId,
          });
          try {
            const existing = await deps.chats.get(binding.backingChatId);
            if (existing) {
              if (existing.botId !== botId || existing.workspaceId !== binding.backingWorkspaceId) {
                throw new Error("This bot’s Telegram conversation has a different backing home.");
              }
              const policy = await deps.service.getChatAccess(binding.backingChatId);
              if (policy.botId !== botId) {
                throw new Error("This bot’s Telegram conversation has invalid access state.");
              }
            } else {
              await operations.createChat({
                audienceId: telegramBotNoticeAudienceId(profileName, ownerUserId),
                chatId: binding.backingChatId,
                providerId: profile.settings.providerId,
                model: profile.settings.model,
                assertCurrent: () => {
                  profileAdmission.assertCurrent();
                  if (workspaceAdmission.signal.aborted)
                    throw new Error("The Telegram target workspace changed before binding completed.");
                },
              });
            }
            return binding;
          } catch (error) {
            await deps.bindingAuthority.disableBot(botId).catch(() => undefined);
            throw error;
          }
        } finally {
          workspaceAdmission.release();
        }
      }),
    );
  });
  deps.handle("bots:unbindTelegram", async (_event, id: unknown) => {
    const botId = parseBotId(id);
    return deps.botMutationGate.run(botId, () => deps.bindingAuthority.disableBot(botId));
  });
}
