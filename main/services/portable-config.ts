// Electron runtime binding for the otherwise platform-independent config split.
//
// The portable half lives in ~/.aiden (see aiden-config-dir.ts); the local half
// falls back to DataStore's default root, app.getPath("userData").

import { createPortableConfigStores } from "./portable-config-core.js";
import { aidenConfigDir } from "./aiden-config-dir.js";

export const configStores = createPortableConfigStores(() => aidenConfigDir());

/**
 * Re-read the portable file from disk. Resolves true when its contents changed,
 * which is the app's cue to tell the renderer that its provider, MCP server, and
 * skill lists are stale.
 *
 * Only the portable store is reloaded, deliberately. The other three files are
 * machine-local and written exclusively by this process, so nothing can change
 * them behind our back — reloading them would only discard a warm cache. In
 * particular an external edit can change a provider's intent but never its
 * cached `models`, which is why listProviders still composes from memory.
 */
export function reloadPortableConfig(): Promise<boolean> {
  return configStores.portable.reload();
}
