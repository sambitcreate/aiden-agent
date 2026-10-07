import { createStudioAssetRequestHandler } from "./request-handler.js";
import type { StudioAssetGrants } from "./delivery-core.js";
import type { StudioAssetStore } from "./store.js";

/**
 * Startup wiring for the studio asset store and `aiden-asset:` handler.
 * Disabled means no store open (so no userData directory or database file) and
 * no protocol handler. An open failure is reported and leaves the handler
 * uninstalled, so the app still starts.
 */
export async function startStudioAssets(deps: {
  enabled: boolean;
  store: Pick<StudioAssetStore, "initialize" | "read" | "thumbnail">;
  grants: Pick<StudioAssetGrants, "resolve">;
  registerProtocol: (handler: (request: Request) => Promise<Response>) => void;
  onError: (error: unknown) => void;
}): Promise<boolean> {
  if (!deps.enabled) return false;
  try {
    await deps.store.initialize();
    deps.registerProtocol(createStudioAssetRequestHandler({ store: deps.store, grants: deps.grants }));
    return true;
  } catch (error) {
    deps.onError(error);
    return false;
  }
}
