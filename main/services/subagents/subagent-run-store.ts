import * as path from "node:path";
import {
  createProductionSubagentRunStore,
  SUBAGENT_RUNS_V2_DIRECTORY,
} from "./subagent-run-store-production.js";
import { createSubagentTranscriptStore } from "./subagent-transcript-store.js";

async function userDataDirectory(): Promise<string> {
  return (await import("../../platform.js")).app.getPath("userData");
}

/** Each helper's saved conversation, beside its record in `subagent-runs-v2`. */
export const subagentTranscriptStore = createSubagentTranscriptStore(async () =>
  path.join(await userDataDirectory(), SUBAGENT_RUNS_V2_DIRECTORY),
);

export const subagentRunStore = createProductionSubagentRunStore({
  resolveUserDataDirectory: userDataDirectory,
  deleteChatTranscripts: (chatId) => subagentTranscriptStore.deleteChat(chatId),
});
