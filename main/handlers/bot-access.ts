// Bot identity, access, and one-time notice IPC.
//
// Every audience id is chosen here in main: the desktop document always acts
// as the fixed desktop audience, and a paired Telegram owner is derived from
// the main-owned profile settings. Renderer input never names an audience.

import { parseBotNoticeAcknowledgement } from "../../renderer/shared/bot-capabilities.js";
import type { BotApplicationService } from "../services/bot-application-service.js";
import { normalizeTelegramProfileName, telegramBotNoticeAudienceId } from "../services/telegram/telegram-profile-config.js";
import { botAccessUpdateRendererError, botCreateRendererError } from "./bot-renderer-errors.js";
import { parseBotAccessUpdateInput, parseBotCreateWithAccess, parseBotId } from "./bot-params.js";

export interface BotAccessTelegramProfile {
  name: string;
  settings: { allowedUserId?: number };
}

export interface BotAccessHandlerDependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  service: Pick<
    BotApplicationService,
    | "noticeStatus"
    | "acknowledgeNotice"
    | "createBot"
    | "capabilityCatalog"
    | "getBotAccess"
    | "modelSelection"
    | "visionModelSelection"
    | "updateBotAccess"
  >;
  /** The fixed audience every desktop document acts as. */
  desktopAudienceId: string;
  /** The live application document that sent the request; throws for a stale one. */
  documentOwner(event: Event): { isDestroyed(): boolean };
  telegramProfiles(): Promise<readonly BotAccessTelegramProfile[]>;
  warn(message: string, error: unknown): void;
}

export function registerBotAccessHandlers<Event>(deps: BotAccessHandlerDependencies<Event>): void {
  const { service, desktopAudienceId } = deps;
  const pairedTelegramAudience = async (profileValue: unknown) => {
    const profileName = normalizeTelegramProfileName(
      typeof profileValue === "string" ? profileValue : "",
    );
    const profile = (await deps.telegramProfiles()).find(({ name }) => name === profileName);
    const ownerUserId = profile?.settings.allowedUserId;
    if (!profile || ownerUserId === undefined) {
      throw new Error("Choose a Telegram profile with a paired owner.");
    }
    return {
      profileName,
      audienceId: telegramBotNoticeAudienceId(profileName, ownerUserId),
    };
  };
  const ownerCheck = (event: Event) => {
    const owner = deps.documentOwner(event);
    return () => {
      if (owner.isDestroyed()) {
        throw new Error("The application changed before Bot access was confirmed.");
      }
    };
  };

  deps.handle("bots:getAccessNotice", async () => service.noticeStatus(desktopAudienceId));
  deps.handle("bots:acknowledgeAccessNotice", async (event, input: unknown) => {
    const assertCurrent = ownerCheck(event);
    return service.acknowledgeNotice(
      desktopAudienceId,
      parseBotNoticeAcknowledgement(input),
      assertCurrent,
    );
  });
  deps.handle("bots:getTelegramAccessNotice", async (_event, profile: unknown) => {
    const principal = await pairedTelegramAudience(profile);
    return service.noticeStatus(principal.audienceId);
  });
  deps.handle("bots:acknowledgeTelegramAccessNotice", async (event, input: unknown) => {
    const assertCurrent = ownerCheck(event);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Invalid Telegram Bot access notice fields.");
    }
    const raw = input as Record<string, unknown>;
    if (
      !Object.keys(raw).every((key) => key === "profile" || key === "acknowledgement") ||
      Object.keys(raw).length !== 2
    ) {
      throw new Error("Invalid Telegram Bot access notice fields.");
    }
    const principal = await pairedTelegramAudience(raw.profile);
    return service.acknowledgeNotice(
      principal.audienceId,
      parseBotNoticeAcknowledgement(raw.acknowledgement),
      assertCurrent,
    );
  });
  deps.handle("bots:create", async (_event, input: unknown) => {
    const parsed = parseBotCreateWithAccess(input);
    try {
      return await service.createBot({
        audienceId: desktopAudienceId,
        bot: parsed.bot,
        access: parsed.access,
      });
    } catch (error) {
      deps.warn("Bot creation failed.", error);
      throw botCreateRendererError(error);
    }
  });
  deps.handle("bots:getCapabilityCatalog", async (_event, id: unknown) =>
    service.capabilityCatalog(desktopAudienceId, id === undefined ? undefined : parseBotId(id)),
  );
  deps.handle("bots:getBotAccess", async (_event, id: unknown) => {
    const botId = parseBotId(id);
    const [access, modelSelection, visionModelSelection] = await Promise.all([
      service.getBotAccess(botId),
      service.modelSelection(desktopAudienceId, botId),
      service.visionModelSelection(desktopAudienceId, botId),
    ]);
    return { access, modelSelection, visionModelSelection };
  });
  deps.handle("bots:updateBotAccess", async (_event, input: unknown) => {
    const parsed = parseBotAccessUpdateInput(input);
    try {
      return await service.updateBotAccess({
        audienceId: desktopAudienceId,
        botId: parsed.botId,
        expectedRevision: parsed.expectedRevision,
        access: parsed.access,
      });
    } catch (error) {
      throw botAccessUpdateRendererError(error);
    }
  });
}
