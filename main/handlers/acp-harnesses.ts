/**
 * IPC for ACP harness providers: runtime install state and the explicit,
 * user-initiated install/cancel/remove actions. Sign-in and sign-out use the
 * shared `providers:auth:*` flow like every other provider.
 */
import type { AcpHarnessStatus } from "../../renderer/shared/acp-harness.js";
import { projectRuntime } from "../services/acp/status.js";
import { antigravityEnabled, antigravityService, shutdownAntigravity } from "../services/antigravity/index.js";
import type { AntigravityService } from "../services/antigravity/service.js";
import { ANTIGRAVITY_PROVIDER_ID } from "../services/antigravity/models.js";
import { app, ipcMain, logger } from "../platform.js";

interface HarnessEntry {
  service(): AntigravityService;
}

function harnesses(): ReadonlyMap<string, HarnessEntry> {
  const entries = new Map<string, HarnessEntry>();
  if (antigravityEnabled()) entries.set(ANTIGRAVITY_PROVIDER_ID, { service: antigravityService });
  return entries;
}

function harnessFor(providerId: unknown): HarnessEntry {
  const entry = typeof providerId === "string" ? harnesses().get(providerId) : undefined;
  if (!entry) throw new Error("This provider does not use a managed runtime.");
  return entry;
}

async function statusOf(providerId: string, entry: HarnessEntry): Promise<AcpHarnessStatus> {
  const status = await entry.service().status();
  return {
    providerId,
    publisher: status.publisher,
    runtime: projectRuntime(status.runtime, status.downloadHost),
    signedIn: status.signedIn,
    busy: status.busy,
  };
}

export function registerAcpHarnessHandlers(): void {
  const subscribed = new Set<string>();
  const subscribe = (providerId: string, entry: HarnessEntry) => {
    if (subscribed.has(providerId)) return;
    subscribed.add(providerId);
    let pending = false;
    entry.service().onChange(() => {
      // Progress can fire many times a second; coalesce to one status read.
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        void statusOf(providerId, entry)
          .then((status) => ipcMain.broadcast("providers:harness:changed", status))
          .catch((error: unknown) => logger.warn("acp", "Could not publish harness status.", error));
      }, 150);
    });
  };

  ipcMain.handle("providers:harness:status", async (_event, providerId: unknown) => {
    const entry = harnessFor(providerId);
    subscribe(providerId as string, entry);
    return statusOf(providerId as string, entry);
  });

  ipcMain.handle("providers:harness:install", async (_event, providerId: unknown) => {
    const entry = harnessFor(providerId);
    subscribe(providerId as string, entry);
    try {
      await entry.service().install();
    } catch (error) {
      logger.warn("acp", "Harness runtime install did not finish.", error);
    }
    return statusOf(providerId as string, entry);
  });

  ipcMain.handle("providers:harness:cancel", async (_event, providerId: unknown) => {
    harnessFor(providerId).service().cancelInstall();
  });

  ipcMain.handle("providers:harness:remove", async (_event, providerId: unknown) => {
    const entry = harnessFor(providerId);
    await entry.service().removeRuntime();
    return statusOf(providerId as string, entry);
  });

  app.once("before-quit", () => {
    void shutdownAntigravity();
  });
}
