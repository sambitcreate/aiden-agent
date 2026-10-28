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
  // Appended without a submission: a write submission starts the Bot's
  // scheduler, which would run a turn left interrupted or paused.
  async appendEntry(botId, kind, data) {
    const { botSessionRuntime } = await import("./bot-runtime/bot-session-main.js");
    await (await botSessionRuntime()).appendEntry(botId, kind, data as JsonValue);
  },
  // The active entries the live projection renders as cards.
  async conversationEntries(botId) {
    const { botSessionRuntime } = await import("./bot-runtime/bot-session-main.js");
    const conversation = await (await botSessionRuntime()).conversation(botId);
    return (await conversation.context(BACKGROUND_CONTEXT)).entries;
  },
  // An answered follow-up frees a slot for the next noted promise.
  onSettled(botId, proposalId, status) {
    void import("./bot-commitments/commitments-main.js").then(({ commitmentProposalSettled }) =>
      commitmentProposalSettled(botId, proposalId, status));
  },
});
