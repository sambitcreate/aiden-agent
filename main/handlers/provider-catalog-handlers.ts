// Provider catalog IPC: Pi inventory refreshes, offline model info, and the
// one explicit foreground models.dev update. Dependencies are injected so the
// manual-only network contract can be exercised without Electron.

import type { IpcMainInvokeEvent } from "electron";
import type { ProviderAuthOwner } from "../services/provider-auth-flow-core.js";
import type { ModelsDevCatalogStatus } from "../services/models-dev-cache-core.js";
import { asProviderId } from "./provider-payload.js";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

export interface ProviderCatalogIpc {
  handle(channel: string, handler: Handler): void;
}

export interface ProviderCatalogHandlerDependencies<Inventory extends { providers: unknown; errors: unknown }> {
  providerAuthOwner(event: IpcMainInvokeEvent): ProviderAuthOwner;
  isBuiltinProvider(providerId: string): boolean;
  refreshProviderCatalogs(providerIds?: readonly string[], force?: boolean): Promise<Inventory>;
  /** The only path that may contact models.dev. */
  modelsDev: { refresh(): Promise<{ status: ModelsDevCatalogStatus }> };
  modelsDevStatus(): Promise<ModelsDevCatalogStatus>;
  modelInfo: { infoMany(providerId: string, modelIds: string[]): Promise<unknown> };
}

export function registerProviderCatalogHandlers<
  Inventory extends { providers: unknown; errors: unknown },
>(ipc: ProviderCatalogIpc, deps: ProviderCatalogHandlerDependencies<Inventory>): void {
  ipc.handle("providers:refresh", async (event, providerValue?: unknown) => {
    // A catalog refresh can renew OAuth credentials inside Pi, so treat it as
    // a credential-affecting operation rather than accepting stale documents.
    deps.providerAuthOwner(event);
    const providerId = providerValue === undefined ? undefined : asProviderId(providerValue);
    if (providerId !== undefined && !deps.isBuiltinProvider(providerId)) {
      throw new Error("Only provider catalogs built into Aiden can be refreshed.");
    }
    return deps.refreshProviderCatalogs(providerId === undefined ? undefined : [providerId]);
  });

  ipc.handle("providers:refreshIfStale", async (event) => {
    deps.providerAuthOwner(event);
    return deps.refreshProviderCatalogs(undefined, false);
  });

  ipc.handle("providers:catalogStatus", () => deps.modelsDevStatus());

  // Offline, display-only model metadata for one provider's models.
  ipc.handle("models:info", async (_event, providerId: unknown, modelIds: unknown) => {
    const pid = typeof providerId === "string" ? providerId : "";
    const ids = Array.isArray(modelIds)
      ? modelIds.filter((m): m is string => typeof m === "string")
      : [];
    return deps.modelInfo.infoMany(pid, ids);
  });

  ipc.handle("providers:updateCatalogs", async (event) => {
    deps.providerAuthOwner(event);
    const inventory = await deps.refreshProviderCatalogs();
    let modelsDev;
    try {
      const refreshed = await deps.modelsDev.refresh();
      modelsDev = { ok: true as const, status: refreshed.status };
    } catch (error) {
      modelsDev = {
        ok: false as const,
        status: await deps.modelsDevStatus(),
        message:
          error instanceof Error
            ? error.message.slice(0, 240)
            : "The models.dev catalog could not be updated.",
      };
    }
    return {
      providers: inventory.providers,
      inventoryErrors: inventory.errors,
      modelsDev,
    };
  });
}
