import * as path from "node:path";
import { app } from "electron";
import { createHookService, type HookService } from "./hook-service.js";
import { setHookDispatcher } from "./index.js";
import { setProtectedAgentConfigRoots } from "../protected-agent-config-paths.js";

let service: HookService | undefined;

/** The app's hook service, once startup installed it. */
export function getHookService(): HookService | undefined {
  return service;
}

/**
 * Load hook state from `<userData>/hooks/` and install the real dispatcher.
 * Until this runs, and if it fails, `getHookDispatcher()` runs no hooks.
 */
export async function initializeHookService(): Promise<HookService> {
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
  return created;
}
