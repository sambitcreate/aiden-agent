// The process-wide Bot approval bridge. Prompts are broadcast to every desktop
// window (`bots:approval`) and withdrawn with `bots:approval-settled`; answers
// arrive by `waitId` over `bots:approve`, `chat:approve`, or the Remote
// approval routes (through `llmClient.approve` / `approveAsHost`).

import { ipcMain } from "../../platform.js";
import { createBotApprovals } from "./bot-approvals.js";

export const botApprovals = createBotApprovals({
  publish: (prompt) => ipcMain.broadcast("bots:approval", prompt),
  withdraw: (prompt, outcome) =>
    ipcMain.broadcast("bots:approval-settled", { botId: prompt.botId, waitId: prompt.waitId, outcome }),
});
