import { logger } from "../platform.js";
import { HostRunRegistry } from "./host-run-registry.js";
import { createHostRunRecorders } from "./host-runs.js";

/** The host-wide journal of every generation run in this process. */
export const hostRunRegistry = new HostRunRegistry({ now: Date.now });

export const {
  recordRunBegin,
  recordRunNotification,
  recordRunAttentionResolved,
  recordRunSettled,
} = createHostRunRecorders((scope, message, error) => logger.warn(scope, message, error));
