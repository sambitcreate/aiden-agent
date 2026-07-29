import * as path from "node:path";
import { createSubagentRunStore } from "./subagent-run-store-core.js";

export const subagentRunStore = createSubagentRunStore(async () =>
  path.join((await import("../../platform.js")).app.getPath("userData"), "subagent-runs"),
);
