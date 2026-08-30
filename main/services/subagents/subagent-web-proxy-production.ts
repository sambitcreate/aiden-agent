import { webSearchService } from "../web-search-main.js";
import { SubagentWebProxyHost } from "./subagent-web-proxy.js";

/** Electron-main singleton; neither configuration nor credentials enter child contracts. */
export const productionSubagentWebProxyHost = new SubagentWebProxyHost({
  search: (request, options) => webSearchService.search(request, options),
  webSearchAvailability: () => webSearchService.availability(),
  now: Date.now,
  scheduleTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    // This is the request's bounded-settlement deadline; it remains referenced
    // so an uncooperative fetch cannot leave an awaiting caller unresolved.
    return () => clearTimeout(timer);
  },
});
