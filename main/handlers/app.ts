/**
 * App Handlers - Application-level IPC methods
 *
 * This is where you add your app-specific backend logic
 *
 * Register handlers using the ipcMain API:
 *
 * @example
 * ```typescript
 * import { ipcMain } from '@glaze/core/backend';
 *
 * ipcMain.handle('app:myMethod', async (event, arg1, arg2) => {
 *   // Your logic here
 *   return { result: 'success' };
 * });
 * ```
 */

import { logger } from "@glaze/core/backend";

// App handlers - these are the methods your app provides to the frontend
export const appHandlers = {
  // Example: Get app information
  getInfo: async () => {
    logger.info("app", "App info requested");
    return {
      name: "My Glaze App",
      version: "1.0.0",
      environment: process.env.NODE_ENV || "production",
    };
  },

  // TODO: Add your app handlers here
  // Example:
  // myMethod: async (params: { arg1: string }) => {
  //   return { result: 'success' };
  // }
};
