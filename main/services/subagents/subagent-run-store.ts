import { createProductionSubagentRunStore } from "./subagent-run-store-production.js";

export const subagentRunStore = createProductionSubagentRunStore({
  resolveUserDataDirectory: async () =>
    (await import("../../platform.js")).app.getPath("userData"),
});
