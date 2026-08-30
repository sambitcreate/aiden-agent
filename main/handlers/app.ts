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
import { hostPlatformCapabilities } from "../services/host-platform-capabilities.js";
import { subagentsEnabled } from "../services/subagents/feature-flag.js";

// App handlers - these are the methods your app provides to the frontend
export const appHandlers = {
  // Example: Get app information
  getInfo: async () => {
    logger.info("app", "App info requested");
    const host = hostPlatformCapabilities();
    return {
      name: app.getName(),
      version: app.getVersion(),
      environment: currentRuntimeProfile().id,
      capabilities: {
        platform: host.platform,
        subagents: subagentsEnabled(),
        bots: host.bots,
        computerUse: host.computerUse,
        dockIcon: host.dockIcon,
        accessibilityPaste: host.accessibilityPaste,
        nativeShare: host.nativeShare,
        appleFoundationModels: host.appleFoundationModels,
      },
    };
  },

  // TODO: Add your app handlers here
  // Example:
  // myMethod: async (params: { arg1: string }) => {
  //   return { result: 'success' };
  // }
};
