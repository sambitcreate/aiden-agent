// The read and write ports behind settings from chat (plan §4.6), over the
// Bot and access stores. No Electron here: `service-main.ts` injects the real
// stores, and tests inject fakes.

import type { BotAccessUpdate, BotAccessView, BotCapabilityCatalog } from "../../../renderer/shared/bot-capabilities.js";
import type { BotSettingsPatch, BotSettingsValues } from "../../../renderer/shared/bot-settings-changes.js";
import { resolveBotInterruptions, type BotDefinition, type BotUpdateInput } from "../../../renderer/shared/bots.js";
import { BotCapabilityRevisionConflictError } from "../bot-capability-store-core.js";
import { BotIdentityRevisionConflictError } from "../bot-store-core.js";
import { BotSettingsConflictError, type BotSettingsModelOption, type BotSettingsPorts } from "./service.js";

/** The stores the ports read and write, already bound to the desktop audience. */
export interface BotSettingsPortDeps {
  profileDir(): string;
  getBot(botId: string): Promise<BotDefinition | null | undefined>;
  /** The Bot's own model, if it has one; may throw. */
  modelSelection(botId: string): Promise<{ providerId: string; modelId: string } | undefined>;
  /** The Bot's access view (where its model lives); may throw when unreadable. */
  getBotAccess(botId: string): Promise<BotAccessView>;
  capabilityCatalog(botId: string): Promise<Pick<BotCapabilityCatalog, "revision" | "providers">>;
  botWebSearchEnabled(botId: string): Promise<boolean>;
  /** Compare-and-swap on `expectedRevision`; throws `BotCapabilityRevisionConflictError` when it moved. */
  updateBotAccess(input: { botId: string; expectedRevision: string; access: BotAccessUpdate; refuseDriftedGrants: true }): Promise<unknown>;
  /** Compare-and-swap on `expectedRevision`; throws `BotIdentityRevisionConflictError` when it moved. */
  updateBot(input: BotUpdateInput): Promise<unknown>;
  cancelWakeUps(botId: string): Promise<void>;
  broadcastChanged(botId: string): void;
  appendEntry: BotSettingsPorts["appendEntry"];
}

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

export function createBotSettingsPorts(deps: BotSettingsPortDeps): BotSettingsPorts {
  async function botOf(botId: string): Promise<BotDefinition> {
    const bot = await deps.getBot(botId);
    if (!bot) throw new Error("This Bot is no longer available.");
    return bot;
  }

  async function writeModel(botId: string, model: NonNullable<BotSettingsPatch["model"]>, view: BotAccessView): Promise<void> {
    const catalog = await deps.capabilityCatalog(botId);
    const access: BotAccessUpdate = view.accessMode === "full"
      ? {
          accessMode: "full",
          catalogRevision: catalog.revision,
          // The person asked for it in their own chat, or pressed Apply.
          confirmedForeground: true,
          providerId: model.providerId,
          modelId: model.modelId,
          webSearchEnabled: await deps.botWebSearchEnabled(botId),
        }
      : { accessMode: "custom", catalogRevision: catalog.revision, custom: { ...view.custom, providerId: model.providerId, modelId: model.modelId } };
    await deps.updateBotAccess({
      botId,
      expectedRevision: view.revision,
      access,
      // A model switch never re-grants folders or apps that drifted since.
      refuseDriftedGrants: true,
    }).catch((error: unknown) => {
      throw error instanceof BotCapabilityRevisionConflictError ? new BotSettingsConflictError() : error;
    });
  }

  return {
    profileDir: () => deps.profileDir(),

    async read(botId) {
      const bot = await botOf(botId);
      const selection = await deps.modelSelection(botId).catch(() => undefined);
      // Unreadable access leaves an empty revision, which no model write matches.
      const access = await deps.getBotAccess(botId).then((view) => view.revision, () => "");
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

    async models(botId) {
      const catalog = await deps.capabilityCatalog(botId);
      return catalog.providers
        .filter((provider) => provider.available)
        .flatMap((provider) => provider.models
          .filter((model) => model.available)
          .map((model): BotSettingsModelOption => ({ providerId: provider.id, modelId: model.id, label: `${model.label} (${provider.label})` })));
    },

    async write(botId, patch, expectedRevision) {
      // A Bot's model is never taken away from chat, and Undo never claims it was.
      if (patch.model === null) throw new Error("update_bot can't take a Bot's model away.");
      const identity = patch.name !== undefined || patch.description !== undefined || patch.look !== undefined
        || patch.instructions !== undefined || patch.dailyCheckIns !== undefined || patch.notifications !== undefined;
      const expected = splitRevision(expectedRevision);
      // Both revisions the change (or its Undo) was decided on are checked
      // before anything is written: an edit to either since wins, whole.
      const bot = await botOf(botId);
      if (bot.revision !== expected.bot) throw new BotSettingsConflictError();
      const view = patch.model ? await deps.getBotAccess(botId) : undefined;
      if (view && view.revision !== expected.access) throw new BotSettingsConflictError();

      // A change is all or nothing. The identity half goes first because it
      // can be put back exactly: if the model half is then refused, the
      // identity write is undone (compare-and-swap on the revision it just
      // made), so a refused change leaves both stores as they were. The model
      // can't go first, since a Bot with no model before has nothing to put
      // back. The identity write cannot move the access revision, nor the
      // model write the Bot's, so neither invalidates the other's check.
      let wrote = false;
      let done = false;
      try {
        let writtenRevision: string | undefined;
        if (identity) {
          const description = patch.description ?? bot.description ?? "";
          await deps.updateBot({
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
          wrote = true;
          if (patch.model) writtenRevision = (await botOf(botId)).revision;
        }
        if (patch.model && view) {
          try {
            await writeModel(botId, patch.model, view);
          } catch (error) {
            if (writtenRevision !== undefined) {
              // Put the identity half back; if someone edited the Bot in the
              // meantime their edit stands and this change still reports refused.
              await deps.updateBot({
                id: botId,
                expectedRevision: writtenRevision,
                name: bot.name,
                ...(bot.description ? { description: bot.description } : {}),
                instructions: bot.instructions,
                avatar: bot.avatar,
                interruptions: resolveBotInterruptions(bot.interruptions),
                selfWakeUps: bot.selfWakeUps !== false,
              }).then(() => { wrote = false; }, () => undefined);
            }
            throw error;
          }
          wrote = true;
        }
        if (identity && patch.dailyCheckIns === false) await deps.cancelWakeUps(botId);
        done = true;
      } finally {
        // Whatever landed is shown, even when a later half was refused.
        if (done || wrote) deps.broadcastChanged(botId);
      }
    },

    appendEntry: (botId, kind, data) => deps.appendEntry(botId, kind, data),
  };
}
