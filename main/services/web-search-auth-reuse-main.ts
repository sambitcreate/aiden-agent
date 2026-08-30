/** Electron-main binding for the Web Search existing-auth service. */

import { app } from "../platform.js";
import { DataStore } from "./data-store.js";
import { piCredentialStore } from "./pi-credential-store.js";
import { providerRegistry } from "./provider-registry.js";
import { invalidateBotRuntimeInventoryAuthority } from "./bot-runtime-inventory-lease.js";
import {
  emptyWebSearchExistingAuthBindingDocument,
  normalizeWebSearchExistingAuthBindingDocument,
  type WebSearchExistingAuthBindingDocument,
} from "./web-search-auth-reuse-core.js";
import {
  WebSearchExistingAuthReuseService,
  WEB_SEARCH_EXISTING_AUTH_BINDINGS_FILE,
  WEB_SEARCH_EXISTING_AUTH_BINDINGS_MAX_BYTES,
} from "./web-search-auth-reuse.js";

/** Production binding store. It lives in userData and is never portable. */
export const webSearchExistingAuthBindingStore =
  new DataStore<WebSearchExistingAuthBindingDocument>(
    WEB_SEARCH_EXISTING_AUTH_BINDINGS_FILE,
    emptyWebSearchExistingAuthBindingDocument(),
    () => app.getPath("userData"),
    {
      maxBytes: WEB_SEARCH_EXISTING_AUTH_BINDINGS_MAX_BYTES,
      fileMode: 0o600,
      normalize: normalizeWebSearchExistingAuthBindingDocument,
      isSafe: (value) => {
        try {
          normalizeWebSearchExistingAuthBindingDocument(value);
          return true;
        } catch {
          return false;
        }
      },
      preserveCorruptFile: true,
      rejectCorruptWrite: true,
      rejectUnsafeWrite: true,
      // An explicit binding changes the global provider authority seen by Bot
      // inventory. Fence active leases immediately before and after the durable
      // publication, just as the encrypted Pi credential store does.
      beforeWritePublish: () => invalidateBotRuntimeInventoryAuthority("provider_credential"),
      afterWritePublish: () => invalidateBotRuntimeInventoryAuthority("provider_credential"),
    },
  );

/** Main-only service using the exact persisted Pi credential authority. */
export const webSearchExistingAuthReuse = new WebSearchExistingAuthReuseService({
  credentials: piCredentialStore,
  models: providerRegistry.models,
  store: webSearchExistingAuthBindingStore,
});
