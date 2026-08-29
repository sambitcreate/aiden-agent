/** Electron-main binding for the shared Web Search service. */

import { configStore } from "./config-store.js";
import { configStores } from "./portable-config.js";
import { webSearchCredentials } from "./web-search-credentials.js";
import { WebSearchService } from "./web-search.js";

/**
 * Read the local marker before configStore.getSettings() runs its one-time
 * provider seeding. This preserves the durable fresh-vs-upgrade discriminator.
 */
export const webSearchService = new WebSearchService({
  getMigrationEvidence: async () => {
    const local = await configStores.local.load();
    return {
      seeded: local.seeded,
      ...(local.webSearchProfileKind === undefined
        ? {}
        : { profileKind: local.webSearchProfileKind }),
    };
  },
  getSettings: async () => {
    // The generic settings projection omits unsupported/future Web Search
    // documents. Supplying the dedicated fail-closed projection keeps the
    // runtime from mistaking a preserved future document for legacy absence
    // and trying to persist a replacement during its first request.
    const [settings, webSearch] = await Promise.all([
      configStore.getSettings(),
      configStore.getWebSearchSettings(),
    ]);
    return { ...settings, webSearch };
  },
  getCredential: async (providerId) => {
    try {
      return await webSearchCredentials.read(webSearchCredentials.reference(providerId));
    } catch {
      // Unsupported/future provider credentials fail closed at this binding;
      // adapters may be added without teaching the renderer about secrets.
      return null;
    }
  },
  persistSettings: (patch) => configStore.setSettings(patch),
});
