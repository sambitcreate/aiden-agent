import { ipcMain } from "../platform.js";
import { BOT_ROUTINE_PROPOSAL_CHANNELS, type BotRoutineProposalRespondResult } from "../../renderer/shared/bot-routine-proposals.js";
import { parseBotRoutineProposalRespond } from "../services/bot-routine-proposals.js";
import { botRoutineProposals } from "../services/bot-routine-proposals-main.js";
import { botRoutineService } from "../services/scheduled-bot-routines-main.js";
import {
  parseBotRoutineBotId,
  parseBotRoutineCreate,
  parseBotRoutineDelete,
  parseBotRoutineRunNow,
  parseBotRoutineUpdate,
} from "../services/scheduled-bot-routines.js";

/**
 * Bot routine IPC. Every call names its Bot; a routine id from another Bot is
 * reported as missing. Raw cron never crosses this boundary.
 */
export function registerBotRoutineHandlers(): void {
  ipcMain.handle("bots:routines:list", (_event, botId: unknown) =>
    botRoutineService.list(parseBotRoutineBotId(botId)),
  );
  ipcMain.handle("bots:routines:create", (_event, input: unknown) =>
    botRoutineService.create(parseBotRoutineCreate(input)),
  );
  ipcMain.handle("bots:routines:update", (_event, input: unknown) =>
    botRoutineService.update(parseBotRoutineUpdate(input)),
  );
  ipcMain.handle("bots:routines:delete", (_event, input: unknown) =>
    botRoutineService.delete(parseBotRoutineDelete(input)),
  );
  // Run now, from the "skipped while paused" notice: starts one run and returns its id.
  ipcMain.handle("bots:routines:runNow", (_event, input: unknown) =>
    botRoutineService.runNow(parseBotRoutineRunNow(input)),
  );
  // Add routine / Not now on a card the Bot showed. A repeat returns the settled answer.
  // Accepting a link routine shows its link once, here only: the token never
  // reaches the Bot, the conversation or a phone.
  ipcMain.handle(BOT_ROUTINE_PROPOSAL_CHANNELS.respond, async (_event, input: unknown): Promise<BotRoutineProposalRespondResult> => {
    const { token, ...answer } = await botRoutineProposals.respond(parseBotRoutineProposalRespond(input));
    if (token === undefined) return answer;
    const { botRoutineWebhookLink } = await import("../services/bot-routine-events/sources-main.js");
    return { ...answer, link: await botRoutineWebhookLink(token) };
  });
}
