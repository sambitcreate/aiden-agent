/**
 * Application-level IPC methods owned by the desktop shell.
 */
import { app, logger } from "../platform.js";
import { currentRuntimeProfile } from "../runtime-profile.js";
import { subagentsEnabled } from "../services/subagents/feature-flag.js";

export const appHandlers = {
  getInfo: async () => {
    logger.info("app", "App info requested");
    return {
      name: app.getName(),
      version: app.getVersion(),
      environment: currentRuntimeProfile().id,
      capabilities: {
        subagents: subagentsEnabled(),
      },
    };
  },
};
