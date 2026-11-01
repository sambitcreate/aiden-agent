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
 * Install the real dispatcher and load hook state from `<userData>/hooks/`.
 * Until this runs, `getHookDispatcher()` runs no hooks. If the store can't be
 * read, the dispatcher is still installed and this rejects: tool calls are
 * then denied and each event tries loading again, so a fixed store takes
 * effect without a restart. On a host that can't run hooks (not macOS or
 * Linux) nothing is installed, so no hook ever runs there.
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
  service = created;
  setHookDispatcher(created.dispatcher);
  // Background (`async`) hooks don't outlive the app.
  app.once("before-quit", () => created.dispatcher.stopBackgroundHooks());
  await created.load();
  return created;
}
