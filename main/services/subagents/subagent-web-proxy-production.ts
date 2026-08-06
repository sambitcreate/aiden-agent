import { configStore } from "../config-store.js";
import { secrets } from "../secrets.js";
import { SubagentWebProxyHost } from "./subagent-web-proxy.js";

/** Electron-main singleton; neither configuration nor credentials enter child contracts. */
export const productionSubagentWebProxyHost = new SubagentWebProxyHost({
  fetch: (input, init) => fetch(input, init),
  webSearchEnabled: async () => (await configStore.getSettings()).exaEnabled === true,
  readExaApiKey: () => secrets.getKey("exa"),
  now: Date.now,
  scheduleTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
});
