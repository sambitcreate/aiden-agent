// The process-wide Bot approval bridge. Prompts are broadcast to every desktop
// window (`bots:approval`) and withdrawn with `bots:approval-settled`; answers
// arrive by `waitId` over `bots:approve`, `chat:approve`, or the Remote
// approval routes (through `llmClient.approve` / `approveAsHost`).

import { ipcMain } from "../../platform.js";
import { createBotApprovals, publicBotApprovalPrompt, type BotApprovalDecisionLookup } from "./bot-approvals.js";

let decisionLookup: BotApprovalDecisionLookup | undefined;
/** Configured by desktop wiring; this module never imports the ledger or session singleton. */
export function configureBotApprovalDecisionLookup(lookup: BotApprovalDecisionLookup): void { decisionLookup = lookup; }

export const botApprovals = createBotApprovals({
  lookupDecision: (botId, id, fingerprint) => decisionLookup?.(botId, id, fingerprint) ?? Promise.resolve(undefined),
  publish: (prompt) => ipcMain.broadcast("bots:approval", publicBotApprovalPrompt(prompt)),
  withdraw: (prompt, outcome) =>
    ipcMain.broadcast("bots:approval-settled", { botId: prompt.botId, waitId: prompt.waitId, outcome }),
});
