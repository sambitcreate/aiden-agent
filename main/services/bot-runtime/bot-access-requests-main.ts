import os from "node:os";
import { app, ipcMain } from "../../platform.js";
import type { BotAccessChoice } from "../../../renderer/shared/bot-access-requests.js";
import { createBotAccessRequests } from "./bot-access-requests.js";
import { createBotAccessAuthorizer, createBotAccessRevalidator, createBotAccessDecisionSettlement } from "./bot-access-authorization.js";
import { botAccessPrivateRoots, resolveBotAccessTarget } from "./bot-access-target.js";
import { aidenConfigDir } from "../aiden-config-dir.js";

export const botAccessRequests = createBotAccessRequests();
const folderDecisions = createBotAccessDecisionSettlement({
  now: Date.now,
  allowList: {
    decision: async (...args) => (await import("./bot-session-main.js")).botAllowList.decision(...args),
    settleFolder: async input => (await import("./bot-session-main.js")).botAllowList.settleFolder(input),
  },
  receipts: async (botId, decisionId) => (await import("../bot-application-service-main.js")).botApplicationService.botFolderApprovalReceipts({ botId, decisionId }),
});
botAccessRequests.onChange(() => folderDecisions.forgetInactive(new Set(botAccessRequests.pending().map(prompt => prompt.waitId))));

/** Shared desktop and Remote answer entry. Only host-captured authorization grants access. */
export async function answerBotAccessRequest(
  botId: string,
  waitId: string,
  choice: BotAccessChoice,
): Promise<{ answered: boolean; savedForFuture?: true }> {
  // The bridge must initialize before the session runtime subscribes. Loading
  // tool sources here avoids a bridge → sources → session → bridge cycle.
  const [application, capabilities, authority, sources, runtime] = await Promise.all([
    import("../bot-application-service-main.js"),
    import("../bot-capability-services-main.js"),
    import("../bot-runtime-authority-main.js"),
    import("./bot-tool-sources-main.js"),
    import("./bot-session-main.js"),
  ]);
  const { botApplicationService } = application;
  const { botCapabilityStore } = capabilities;
  const { BOT_DESKTOP_AUDIENCE_ID, botRuntimeAuthority } = authority;
  const { botRunAccess } = sources;
  if (!botAccessRequests.get(botId, waitId)) {
    const recovered = await folderDecisions.reconcileAbsent(botId, waitId);
    if (recovered || await botApplicationService.botFolderGrantCommitted(botId, waitId)) return { answered: true, savedForFuture: true };
  }
  const authorize = createBotAccessAuthorizer({
    now: Date.now,
    captureDecision: folderDecisions.captureDecision,
    audienceId: BOT_DESKTOP_AUDIENCE_ID,
    runAccess: botRunAccess,
    resolveTarget: (requested) =>
      resolveBotAccessTarget(requested, {
        homeDirectory: os.homedir,
        privateRoots: () => botAccessPrivateRoots(app.getPath("userData"), aidenConfigDir()),
        approvedRoots: async () =>
          (await (await import("../aiden-remote-service-main.js")).getAidenRemoteRuntime()).state
            .snapshot()
            .then((state) => state.approvedRoots),
      }),
    revalidate: createBotAccessRevalidator({
      policyRevision: async (id) => (await botCapabilityStore.getBotPolicy(id)).revision,
      canonicalChatId: async (id) => (await botApplicationService.getCanonicalChat(id))?.id,
      admit: (id, chatId) => botRuntimeAuthority.admit({
        audienceId: BOT_DESKTOP_AUDIENCE_ID,
        botId: id,
        chatId,
      }),
    }),
    grantFolder: async (input, owner) => {
      await botApplicationService.grantBotFolder(input, owner);
      return botApplicationService.botFolderGrantPolicyRevision(input.botId, input.operationId);
    },
    folderCommitted: (id, operationId) => botApplicationService.botFolderGrantCommitted(id, operationId),
    changed: (id) => { runtime.botAllowList.changed(id); ipcMain.broadcast("bots:changed", { botId: id }); },
  });
  const outcome = await botAccessRequests.answer(botId, waitId, choice, (prompt, answer) => folderDecisions.authorize(prompt, answer, authorize), folderDecisions.settle);
  if (outcome === "invalid") throw new Error("That answer doesn’t match the card.");
  return { answered: outcome === "answered" || outcome === "saved_for_future", ...(outcome === "saved_for_future" ? { savedForFuture: true } : {}) };
}
