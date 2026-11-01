import * as path from "node:path";
import { app } from "electron";
import { createHookService, type HookService } from "./hook-service.js";
import { setHookDispatcher } from "./index.js";
import { setProtectedAgentConfigRoots } from "../protected-agent-config-paths.js";
import { hostPlatformCapabilities } from "../host-platform-capabilities.js";

let service: HookService | undefined;

/** The app's hook service, once startup installed it. */
export function getHookService(): HookService | undefined {
  return service;
}

/**
 * Load hook state from `<userData>/hooks/` and install the real dispatcher.
 * Until this runs, and if it fails, `getHookDispatcher()` runs no hooks. On a
 * host that can't run hooks (not macOS or Linux) nothing is installed, so no
 * hook ever runs there.
 */
export async function initializeHookService(supported: boolean = hostPlatformCapabilities().hooks): Promise<HookService | undefined> {
  if (!supported) return undefined;
  const root = path.join(app.getPath("userData"), "hooks");
  // Agent file tools never write the hook store, whatever the workspace.
  setProtectedAgentConfigRoots([root]);
  const created = createHookService({
    root: () => root,
    homeDir: () => app.getPath("home"),
  });
  await created.load();
  service = created;
  setHookDispatcher(created.dispatcher);
  // Background (`async`) hooks don't outlive the app.
  app.once("before-quit", () => created.dispatcher.stopBackgroundHooks());
  return created;
}
