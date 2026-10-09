// Production wiring of Bot routine proposals.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { app } from "../platform.js";
import { createBotRoutineProposalService } from "./bot-routine-proposals.js";
import { systemTimezone } from "./schedule-store.js";
import { botRoutineService } from "./scheduled-bot-routines-main.js";

const profileDir = () => app.getPath("userData");

export const botRoutineProposals = createBotRoutineProposalService({
  profileDir,
  routines: botRoutineService,
  defaultTimezone: systemTimezone,
  async appendEntry(botId, kind, data) {
    const { botSessionRuntime } = await import("./bot-runtime/bot-session-main.js");
    const conversation = await (await botSessionRuntime()).conversation(botId);
    await conversation.submit({ type: "write", entry: { kind, data: data as JsonValue } }, BACKGROUND_CONTEXT);
  },
});
