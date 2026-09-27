import { secrets } from "./secrets.js";
import {
  createWebSearchCredentialAccess,
  type WebSearchCredentialAccess,
} from "./web-search-credential-core.js";
import { WebSearchKeyPoolTracker } from "./web-search-key-pool-core.js";

/** Electron-bound Web Search credential access; plaintext stays in main. */
export const webSearchCredentials: WebSearchCredentialAccess =
  createWebSearchCredentialAccess(secrets);

/**
 * Process-local key-pool cooldown and rotation state. The search service
 * records failures here; Settings reads the redacted cooldown projection.
 */
export const webSearchKeyPoolTracker = new WebSearchKeyPoolTracker();
