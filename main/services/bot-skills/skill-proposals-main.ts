// Production wiring of Bot skill proposals and folder-skill review.

import type { JsonValue } from "@earendil-works/chord";
import { app } from "../../platform.js";
import {
  botManagedWorkspace,
  botSkillApprovals,
  botSkillNameSources,
  invalidateBotSkills,
} from "../bot-capability-services-main.js";
import { createBotSkillProposalService } from "./proposals.js";

export const botSkillProposals = createBotSkillProposalService({
  profileDir: () => app.getPath("userData"),
  homePath: async (botId) => (await botManagedWorkspace.resolve(botId)).homePath,
  approvals: botSkillApprovals,
  existingSources: botSkillNameSources,
  async appendEntry(botId, kind, data) {
    const { botSessionRuntime } = await import("../bot-runtime/bot-session-main.js");
    await (await botSessionRuntime()).appendEntry(botId, kind, data as JsonValue);
  },
  invalidate: invalidateBotSkills,
  recordAdded: async (botId, change) => (await import("../bot-learning/learning-main.js")).recordBotSkillAdded(botId, change),
});
