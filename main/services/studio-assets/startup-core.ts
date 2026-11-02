import { createStudioAssetRequestHandler } from "./request-handler.js";
import type { StudioAssetGrants } from "./delivery-core.js";
import type { StudioAssetStore } from "./store.js";

/**
 * Install the `aiden-asset:` handler. Call it before the main window starts
 * loading: Chromium gives a document its custom-scheme subresource loaders
 * when the document commits, so a page that loaded before the handler existed
 * fails every `aiden-asset:` image with net::ERR_UNKNOWN_URL_SCHEME until it
 * reloads. Installing ahead of the store is safe: grants come only from
 * feature IPC, which is admitted after the store opens, so earlier requests
 * answer 404, and a store that then fails to open answers 503 (the handler
 * maps StudioAssetError "unavailable"). Disabled installs nothing.
 */
export function installStudioAssetProtocol(deps: {
  enabled: boolean;
  store: Pick<StudioAssetStore, "read" | "thumbnail">;
  grants: Pick<StudioAssetGrants, "resolve">;
  registerProtocol: (handler: (request: Request) => Promise<Response>) => void;
}): boolean {
  if (!deps.enabled) return false;
  deps.registerProtocol(createStudioAssetRequestHandler({ store: deps.store, grants: deps.grants }));
  return true;
}

/**
 * Open the studio asset store inside the startup reconcile chain. Disabled
 * means no store open (so no userData directory or database file). A failure
 * is reported through `onError`; the store's status() keeps reporting "failed"
 * for later surfaces, and initialize() can be retried. Resolves true when the
 * store is open.
 */
export async function startStudioAssets(deps: {
  enabled: boolean;
  store: Pick<StudioAssetStore, "initialize">;
  onError: (error: unknown) => void;
}): Promise<boolean> {
  if (!deps.enabled) return false;
  try {
    await deps.store.initialize();
    return true;
  } catch (error) {
    deps.onError(error);
    return false;
  }
}
