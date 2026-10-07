import { createStudioAssetRequestHandler } from "./request-handler.js";
import type { StudioAssetGrants } from "./delivery-core.js";
import type { StudioAssetStore } from "./store.js";

/**
 * Startup wiring for the studio asset store and `aiden-asset:` handler.
 * Disabled means no store open (so no userData directory or database file) and
 * no protocol handler. Enabled always installs the handler, even when the store
 * fails to open: the failure is reported through `onError` and requests answer
 * 503 (the handler maps StudioAssetError "unavailable") instead of the scheme
 * being unhandled. Resolves true when the store is open; the store's status()
 * keeps reporting "failed" for later surfaces, and initialize() can be retried.
 */
export async function startStudioAssets(deps: {
  enabled: boolean;
  store: Pick<StudioAssetStore, "initialize" | "read" | "thumbnail">;
  grants: Pick<StudioAssetGrants, "resolve">;
  registerProtocol: (handler: (request: Request) => Promise<Response>) => void;
  onError: (error: unknown) => void;
}): Promise<boolean> {
  if (!deps.enabled) return false;
  deps.registerProtocol(createStudioAssetRequestHandler({ store: deps.store, grants: deps.grants }));
  try {
    await deps.store.initialize();
    return true;
  } catch (error) {
    deps.onError(error);
    return false;
  }
}
