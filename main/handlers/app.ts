/**
 * App Handlers - Application-level IPC methods
 *
 * This is where you add your app-specific backend logic
 *
 * Register handlers using the ipcMain API:
 *
 * @example
 * ```typescript
 * import { ipcMain } from '../platform.js';
 *
 * ipcMain.handle('app:myMethod', async (event, arg1, arg2) => {
 *   // Your logic here
 *   return { result: 'success' };
 * });
 * ```
 */

import { app, logger } from "../platform.js";
import { currentRuntimeProfile } from "../runtime-profile.js";
import { subagentsEnabled } from "../services/subagents/feature-flag.js";
import { ambientMusicEnabled } from "../services/ambient-music-feature-flag.js";

// App handlers - these are the methods your app provides to the frontend
export const appHandlers = {
  // Example: Get app information
  getInfo: async () => {
    logger.info("app", "App info requested");
    return {
      name: app.getName(),
      version: app.getVersion(),
      environment: currentRuntimeProfile().id,
      capabilities: {
        subagents: subagentsEnabled(),
        ambientMusic: ambientMusicEnabled(),
      },
    };
  },

  // TODO: Add your app handlers here
  // Example:
  // myMethod: async (params: { arg1: string }) => {
  //   return { result: 'success' };
  // }
};
