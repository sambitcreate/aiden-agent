// Production wiring of settings from chat (plan §4.6).

import type { JsonValue } from "@earendil-works/chord";
import type { BotAccessUpdate } from "../../../renderer/shared/bot-capabilities.js";
import { resolveBotInterruptions, type BotDefinition } from "../../../renderer/shared/bots.js";
import type { BotSettingsPatch, BotSettingsValues } from "../../../renderer/shared/bot-settings-changes.js";
import { app, ipcMain } from "../../platform.js";
import { botApplicationService } from "../bot-application-service-main.js";
import { BOT_DESKTOP_AUDIENCE_ID } from "../bot-runtime-authority-main.js";
import { BotCapabilityRevisionConflictError } from "../bot-capability-store-core.js";
import { BotIdentityRevisionConflictError } from "../bot-store-core.js";

/**
 * The revision a change is decided on: the Bot's identity revision and its
 * access revision (the model lives there), so a desktop edit to either since
 * the read refuses the write.
 */
function joinRevision(bot: string, access: string): string {
  return JSON.stringify([bot, access]);
}
function splitRevision(revision: string): { bot: string; access: string } {
  try {
    const [bot, access] = JSON.parse(revision) as unknown[];
    if (typeof bot === "string" && typeof access === "string") return { bot, access };
  } catch {
    // Not one of ours: nothing matches it.
  }
  return { bot: "", access: "" };
}
import { BotSettingsConflictError, createBotSettingsChangeService, type BotSettingsModelOption } from "./service.js";

async function botOf(botId: string): Promise<BotDefinition> {
  const bot = await botApplicationService.get(botId);
  if (!bot) throw new Error("This Bot is no longer available.");
  return bot;
}

async function models(botId: string): Promise<BotSettingsModelOption[]> {
  const catalog = await botApplicationService.capabilityCatalog(BOT_DESKTOP_AUDIENCE_ID, botId);
  return catalog.providers
    .filter((provider) => provider.available)
    .flatMap((provider) => provider.models
      .filter((model) => model.available)
      .map((model) => ({ providerId: provider.id, modelId: model.id, label: `${model.label} (${provider.label})` })));
}

async function writeModel(botId: string, model: NonNullable<BotSettingsPatch["model"]>, expectedAccessRevision: string): Promise<void> {
  const catalog = await botApplicationService.capabilityCatalog(BOT_DESKTOP_AUDIENCE_ID, botId);
  const view = await botApplicationService.getBotAccess(botId);
  // Access changed since the read (a model or tools edit on the desktop): that edit wins.
  if (view.revision !== expectedAccessRevision) throw new BotSettingsConflictError();
  const access: BotAccessUpdate = view.accessMode === "full"
    ? {
        accessMode: "full",
        catalogRevision: catalog.revision,
        // The person asked for it in their own chat, or pressed Apply.
        confirmedForeground: true,
        providerId: model.providerId,
        modelId: model.modelId,
        webSearchEnabled: await botApplicationService.botWebSearchEnabled(botId),
      }
    : { accessMode: "custom", catalogRevision: catalog.revision, custom: { ...view.custom, providerId: model.providerId, modelId: model.modelId } };
  await botApplicationService.updateBotAccess({
    audienceId: BOT_DESKTOP_AUDIENCE_ID,
    botId,
    expectedRevision: expectedAccessRevision,
    access,
    // A model switch never re-grants folders or apps that drifted since.
    refuseDriftedGrants: true,
  }).catch((error: unknown) => {
    throw error instanceof BotCapabilityRevisionConflictError ? new BotSettingsConflictError() : error;
  });
}

export const botSettingsChanges = createBotSettingsChangeService({
  profileDir: () => app.getPath("userData"),
  async read(botId): Promise<{ values: BotSettingsValues; revision: string }> {
    const bot = await botOf(botId);
    const selection = await botApplicationService.modelSelection(BOT_DESKTOP_AUDIENCE_ID, botId).catch(() => undefined);
    // Unreadable access leaves an empty revision, which no model write matches.
    const access = await botApplicationService.getBotAccess(botId).then((view) => view.revision, () => "");
    const values: BotSettingsValues = {
      name: bot.name,
      description: bot.description ?? "",
      look: { color: bot.avatar.color, shape: bot.avatar.shape },
      instructions: bot.instructions,
      dailyCheckIns: bot.selfWakeUps !== false,
      notifications: resolveBotInterruptions(bot.interruptions),
      model: selection ? { providerId: selection.providerId, modelId: selection.modelId } : null,
    };
    return { values, revision: joinRevision(bot.revision, access) };
  },
  models,
  async write(botId, patch, expectedRevision) {
    // A Bot's model is never taken away from chat, and Undo never claims it was.
    if (patch.model === null) throw new Error("update_bot can't take a Bot's model away.");
    const identity = patch.name !== undefined || patch.description !== undefined || patch.look !== undefined
      || patch.instructions !== undefined || patch.dailyCheckIns !== undefined || patch.notifications !== undefined;
    const expected = splitRevision(expectedRevision);
    const bot = await botOf(botId);
    // The revision the change (or its Undo) was decided on: an edit since wins.
    if (bot.revision !== expected.bot) throw new BotSettingsConflictError();
    // Checked before anything is written, so a stale model never leaves half a change behind.
    if (patch.model && (await botApplicationService.getBotAccess(botId)).revision !== expected.access) throw new BotSettingsConflictError();
    if (identity) {
      const description = patch.description ?? bot.description ?? "";
      await botApplicationService.updateBot({
        id: botId,
        expectedRevision: expected.bot,
        name: patch.name ?? bot.name,
        ...(description ? { description } : {}),
        instructions: patch.instructions ?? bot.instructions,
        avatar: patch.look ? { version: 1, color: patch.look.color, shape: patch.look.shape } : bot.avatar,
        ...(patch.notifications ? { interruptions: patch.notifications } : {}),
        ...(patch.dailyCheckIns !== undefined ? { selfWakeUps: patch.dailyCheckIns } : {}),
      }).catch((error: unknown) => {
        throw error instanceof BotIdentityRevisionConflictError ? new BotSettingsConflictError() : error;
      });
      if (patch.dailyCheckIns === false) {
        const { botWakeUps } = await import("../bot-wake-ups/wake-ups-main.js");
        await botWakeUps.cancelAll(botId);
      }
    }
    if (patch.model) await writeModel(botId, patch.model, expected.access);
    ipcMain.broadcast("bots:changed", { botId });
  },
  async appendEntry(botId, kind, data) {
    const { botSessionRuntime } = await import("../bot-runtime/bot-session-main.js");
    await (await botSessionRuntime()).appendEntry(botId, kind, data as JsonValue);
  },
});
