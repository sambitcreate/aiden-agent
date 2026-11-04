import os from "node:os";
import { app, ipcMain } from "../../platform.js";
import type { BotAccessChoice } from "../../../renderer/shared/bot-access-requests.js";
import { createBotAccessRequests } from "./bot-access-requests.js";
import { createBotAccessAuthorizer } from "./bot-access-authorization.js";
import { resolveBotAccessTarget } from "./bot-access-target.js";

export const botAccessRequests = createBotAccessRequests();

/** Shared desktop and Remote answer entry. Only host-captured authorization grants access. */
export async function answerBotAccessRequest(
  botId: string,
  waitId: string,
  choice: BotAccessChoice,
): Promise<{ answered: boolean }> {
  // The bridge must initialize before the session runtime subscribes. Loading
  // tool sources here avoids a bridge → sources → session → bridge cycle.
  const [application, capabilities, authority, sources] = await Promise.all([
    import("../bot-application-service-main.js"),
    import("../bot-capability-services-main.js"),
    import("../bot-runtime-authority-main.js"),
    import("./bot-tool-sources-main.js"),
  ]);
  const { botApplicationService } = application;
  const { botCapabilityStore } = capabilities;
  const { BOT_DESKTOP_AUDIENCE_ID, botRuntimeAuthority } = authority;
  const { botRunAccess } = sources;
  const authorize = createBotAccessAuthorizer({
    now: Date.now,
    audienceId: BOT_DESKTOP_AUDIENCE_ID,
    runAccess: botRunAccess,
    resolveTarget: (requested) =>
      resolveBotAccessTarget(requested, {
        homeDirectory: os.homedir,
        privateRoots: () => [app.getPath("userData")],
        approvedRoots: async () =>
          (await (await import("../aiden-remote-service-main.js")).getAidenRemoteRuntime()).state
            .snapshot()
            .then((state) => state.approvedRoots),
      }),
    revalidate: async (id, expectedRevision) => {
      if ((await botCapabilityStore.getBotPolicy(id)).revision !== expectedRevision)
        throw new Error("This Bot's access changed. Ask for access again.");
      const chat = await botApplicationService.getCanonicalChat(id);
      if (!chat) throw new Error("This Bot's task is no longer available.");
      const admission = await botRuntimeAuthority.admit({
        audienceId: BOT_DESKTOP_AUDIENCE_ID,
        botId: id,
        chatId: chat.id,
      });
      try {
        if (
          admission.authority.accessMode !== "custom" ||
          admission.authority.files.mode !== "scoped" ||
          (await botCapabilityStore.getBotPolicy(id)).revision !== expectedRevision
        )
          throw new Error("This Bot's access changed. Ask for access again.");
        await admission.revalidateBeforeEffect();
      } finally {
        admission.release();
      }
    },
    grantFolder: async (input, owner) => {
      await botApplicationService.grantBotFolder(input, owner);
      return botApplicationService.botFolderGrantPolicyRevision(input.botId, input.operationId);
    },
    changed: (id) => ipcMain.broadcast("bots:changed", { botId: id }),
  });
  const outcome = await botAccessRequests.answer(botId, waitId, choice, authorize);
  if (outcome === "invalid") throw new Error("That answer doesn’t match the card.");
  return { answered: outcome === "answered" };
}
