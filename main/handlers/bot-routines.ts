import { ipcMain } from "../platform.js";
import { BOT_ROUTINE_PROPOSAL_CHANNELS } from "../../renderer/shared/bot-routine-proposals.js";
import { parseBotRoutineProposalRespond } from "../services/bot-routine-proposals.js";
import { botRoutineProposals } from "../services/bot-routine-proposals-main.js";
import { botRoutineService } from "../services/scheduled-bot-routines-main.js";
import {
  parseBotRoutineBotId,
  parseBotRoutineCreate,
  parseBotRoutineDelete,
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
  // Add routine / Not now on a card the Bot showed. A repeat returns the settled answer.
  ipcMain.handle(BOT_ROUTINE_PROPOSAL_CHANNELS.respond, (_event, input: unknown) =>
    botRoutineProposals.respond(parseBotRoutineProposalRespond(input)),
  );
}
