import { ipcMain, logger } from "../platform.js";
import { chatStore } from "../services/chat-store.js";
import { botApplicationService } from "../services/bot-application-service-main.js";
import { configStore } from "../services/config-store.js";
import { BOT_DESKTOP_AUDIENCE_ID } from "../services/bot-runtime-authority-main.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { workspaceMutationGate } from "../services/workspace-mutation-gate.js";
import { registerBotAccessHandlers } from "./bot-access.js";
import { registerBotTelegramHandlers } from "./bot-telegram.js";
import { botMutationGate } from "../services/bot-mutation-gate.js";
import { createMainBotAvatarApplicationAdapter } from "../services/bot-avatar-store-main.js";
import { projectBotAvatarForRenderer } from "../services/bot-avatar-renderer-projection.js";
import { getAidenRemoteRuntime } from "../services/aiden-remote-service-main.js";
import {
  botLiveProjection,
  botSessionRuntime,
  dismissBotConnection,
} from "../services/bot-runtime/bot-session-main.js";
import { botStarter } from "../services/bot-runtime/bot-starter-main.js";
import { stopWithIntents } from "../services/bot-runtime/bot-turn-intents.js";
import { botTurnIntents } from "../services/bot-runtime/bot-turn-intents-main.js";
import {
  parseAidenRemoteBotAvatarUploadRequest,
  type AidenRemoteBotAvatarUploadRequest,
} from "../services/aiden-remote-protocol.js";
import { registerBotLiveHandlers } from "./bot-live.js";
import { registerBotPauseHandlers } from "./bot-pause.js";
import { registerBotQuestionHandlers } from "./bot-questions.js";
import { registerBotHandoffHandlers } from "./bot-handoffs.js";
import { botExistsIn, registerBotMemoryHandlers } from "./bot-memory.js";
import { registerBotRuleHandlers } from "./bot-rules.js";
import { botRules } from "../services/bot-rules/store-main.js";
import { botMemoryService } from "../services/bot-memory/bot-memory-main.js";
import { registerBotBrowserHandlers } from "./bot-browser.js";
import { registerBotFileHandlers } from "./bot-files.js";
import { listWorkspaceFiles, readWorkspaceFile } from "../services/workspace-files.js";
import { botQuestions } from "../services/bot-runtime/bot-questions-main.js";
import { botHandoffs } from "../services/bot-runtime/bot-handoffs-main.js";
import { botBrowserWorkspace } from "../services/bot-runtime/bot-browser-main.js";
import { openBotHandoffById } from "../services/bot-runtime/bot-handoff-open-main.js";
import { botApprovals } from "../services/bot-runtime/bot-approvals-main.js";
import {
  telegramBotBindingAuthority,
  telegramBotBindings,
} from "../services/telegram/telegram-bot-bindings.js";
import { telegramService } from "../services/telegram/telegram-service.js";
import { telegramProfileMutationFence } from "../services/telegram/telegram-profile-mutation-fence.js";
import {
  parseBotCreateFromPreset,
  parseConnectionPluginId,
  parseBotId,
  parseBotSend,
  parseBotSessionAction,
  parseBotApprovalDecision,
  parseBotUpdate,
  parseBotWithdraw,
} from "./bot-params.js";

async function desktopAvatarAdapter() {
  const instanceId = (await (await getAidenRemoteRuntime()).state.snapshot()).instanceId;
  return createMainBotAvatarApplicationAdapter(instanceId);
}

/** Choose photo: replaces the Bot's one canonical photo (the same store the phones use). */
async function setBotPhoto(botId: string, upload: AidenRemoteBotAvatarUploadRequest): Promise<void> {
  const avatar = await desktopAvatarAdapter();
  await botApplicationService.withBotMutation(botId, async () => {
    const bot = await botApplicationService.get(botId);
    if (!bot) throw new Error("This Bot no longer exists.");
    const current = await avatar.view(botId, bot.avatar);
    await avatar.put(
      {
        botId,
        expectedAssetRevision: current.asset?.assetRevision ?? null,
        operationId: `avatarop_desktop_${crypto.randomUUID().split("-").join("")}`,
      },
      upload,
    );
  });
}

/** Remove photo: back to the Bot's character. */
async function removeBotPhoto(botId: string): Promise<void> {
  const avatar = await desktopAvatarAdapter();
  await botApplicationService.withBotMutation(botId, async () => {
    const bot = await botApplicationService.get(botId);
    if (!bot) throw new Error("This Bot no longer exists.");
    const current = await avatar.view(botId, bot.avatar);
    if (!current.asset) return;
    await avatar.delete({
      botId,
      expectedAssetRevision: current.asset.assetRevision,
      operationId: `avatarop_desktop_${crypto.randomUUID().split("-").join("")}`,
    });
  });
}

export function registerBotHandlers(): void {
  const desktopAudienceId = BOT_DESKTOP_AUDIENCE_ID;
  registerBotAccessHandlers<Electron.IpcMainInvokeEvent>({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    service: botApplicationService,
    desktopAudienceId,
    documentOwner: (event) =>
      rendererDocumentOwner(
        event,
        () => new Error("Bot access notice requires the active application document."),
      ),
    telegramProfiles: () => telegramService.listProfiles(),
    warn: (message, error) => logger.warn("bots", message, error),
  });
  // Bots are deleted, never archived; a legacy include-archived flag is ignored.
  ipcMain.handle("bots:list", async () => botApplicationService.list());
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
  // Pause / Resume (plan §7): the pause is the Mac's, and survives a restart.
  registerBotPauseHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    runtime: botSessionRuntime,
    getBot: (botId) => botApplicationService.get(botId),
  });
  ipcMain.handle("bots:withdraw", async (_event, input: unknown) => {
    const { botId, submissionId } = parseBotWithdraw(input);
    return (await botSessionRuntime()).withdraw(botId, submissionId);
  });
  ipcMain.handle("bots:stop", async (_event, id: unknown) => {
    const botId = parseBotId(id);
    // "Stopping" in every open chat, on the Mac and on phones; taken back if the Stop fails.
    return stopWithIntents(botTurnIntents, botId, async () => (await botSessionRuntime()).stop(botId));
  });
  ipcMain.handle("bots:createFromPreset", async (_event, input: unknown) => {
    const { presetId, access } = parseBotCreateFromPreset(input);
    // The chat opens as soon as the Bot exists; its self-intro arrives in that chat.
    const starter = botStarter();
    const { bot, created } = await starter.startFromPreset(presetId, { ...(access === undefined ? {} : { access }), introduce: false });
    if (created) void starter.introduce(bot.id);
    return { bot, created };
  });
  ipcMain.handle("bots:introduce", async (_event, id: unknown) => {
    // The create flow's one-time self-intro; deduped per Bot by the runtime.
    return botStarter().introduce(parseBotId(id));
  });
  ipcMain.handle("bots:connections:dismiss", async (_event, rawBotId: unknown, rawPluginId: unknown) => {
    const botId = parseBotId(rawBotId);
    const pluginId = parseConnectionPluginId(rawPluginId);
    await dismissBotConnection(botId, pluginId);
  });
  ipcMain.handle("bots:photo:set", async (_event, rawBotId: unknown, rawUpload: unknown) => {
    const botId = parseBotId(rawBotId);
    const upload = parseAidenRemoteBotAvatarUploadRequest(rawUpload);
    await setBotPhoto(botId, upload);
    ipcMain.broadcast("bots:changed", { botId });
  });
  ipcMain.handle("bots:photo:remove", async (_event, rawBotId: unknown) => {
    const botId = parseBotId(rawBotId);
    await removeBotPhoto(botId);
    ipcMain.broadcast("bots:changed", { botId });
  });
  registerBotLiveHandlers<Electron.IpcMainInvokeEvent>({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    owner: (event) => {
      const owner = rendererDocumentOwner(event, () => new Error("Bot chats require the active application document."));
      return {
        key: `${owner.id}:${owner.documentId}`,
        isDestroyed: owner.isDestroyed,
        onInvalidated: owner.onInvalidated,
        send: (channel, payload) => owner.send(channel, payload),
      };
    },
    projection: botLiveProjection,
    parseBotId,
  });
  // Bot tool approvals: any desktop window may answer; the first answer wins.
  ipcMain.handle("bots:approve", async (_event, input: unknown) => {
    const { waitId, decision } = parseBotApprovalDecision(input);
    return { decided: botApprovals.decide(waitId, decision) };
  });
  ipcMain.handle("bots:pendingApprovals", async (_event, id: unknown) => botApprovals.pending(parseBotId(id)));
  // Bot quick-reply questions: any desktop window may answer; the first answer wins.
  registerBotQuestionHandlers({ handle: (channel, handler) => ipcMain.handle(channel, handler), questions: botQuestions });
  // Bot hand-off cards: any desktop window may answer; the first answer wins. Open needs the app's own document.
  registerBotHandoffHandlers<Electron.IpcMainInvokeEvent>({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    handoffs: botHandoffs,
    open: async (botId, waitId, event) => {
      const owner = rendererDocumentOwner(event, () => new Error("Opening a hand-off requires the active application document."));
      // A link opens in the Bot's own browser, shown in this window.
      return openBotHandoffById(botId, waitId, "desktop", owner);
    },
  });
  // The Bot store answers null for a Bot it doesn't have.
  const botExists = botExistsIn(botApplicationService);
  // Profile → Memory: view, edit, delete and erase what the Bot remembers.
  registerBotMemoryHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    memory: botMemoryService,
    botExists,
  });
  // Profile → Rules: what the Bot must ask about or hand to the person.
  registerBotRuleHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    rules: botRules,
    botExists,
  });
  // Read-only Files: the Bot's own folder.
  registerBotFileHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    homePath: async (botId) => (await botApplicationService.resolveManagedWorkspace(botId)).homePath,
    list: listWorkspaceFiles,
    read: readWorkspaceFile,
  });
  // The Bot's own browser, watched and driven in its panel's Browser tab.
  registerBotBrowserHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    workspace: botBrowserWorkspace,
  });
  ipcMain.handle("bots:delete", async (_event, id: unknown) => {
    await (await botSessionRuntime()).deleteBot(parseBotId(id));
  });
  ipcMain.handle("bots:update", async (_event, input: unknown) => {
    return botApplicationService.updateBot(parseBotUpdate(input));
  });
  registerBotTelegramHandlers<Electron.IpcMainInvokeEvent>({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    service: botApplicationService,
    telegram: {
      listProfiles: () => telegramService.listProfiles(),
      listTargets: (profile) => telegramService.listTargets(profile),
    },
    bindings: telegramBotBindings,
    bindingAuthority: telegramBotBindingAuthority,
    profileFence: telegramProfileMutationFence,
    botMutationGate,
    workspaceGate: workspaceMutationGate,
    workspaces: {
      list: () => configStore.listWorkspaces(),
      get: (workspaceId) => configStore.getWorkspace(workspaceId),
    },
    chats: chatStore,
  });
}
