/** Electron-main binding for the `web_fetch` service. */

import { WEB_EXTRACT_MODELS } from "../../renderer/shared/web-fetch-settings.js";
import { configStore } from "./config-store.js";
import { webSearchCredentials, webSearchKeyPoolTracker } from "./web-search-credentials.js";
import { WebFetchService } from "./web-fetch.js";

export const webFetchService = new WebFetchService({
  getSettings: () => configStore.getWebFetchSettings(),
  webSearchEnabled: async () => (await configStore.getWebSearchSettings()).enabled,
  getExtractKeyPool: (modelId) =>
    webSearchCredentials.readPool(webSearchCredentials.reference(WEB_EXTRACT_MODELS[modelId].credentialId)),
  // Shared with Settings, so a cooled-down key shows there too.
  keyPoolTracker: webSearchKeyPoolTracker,
});
