import { ipcMain } from "../platform.js";
import type { UsageDateRange } from "../services/types.js";
import { usageStore } from "../services/usage-store.js";

const RANGES = new Set<UsageDateRange>(["7d", "30d", "90d", "1y", "all"]);

function parseRange(value: unknown): UsageDateRange {
  return RANGES.has(value as UsageDateRange) ? (value as UsageDateRange) : "1y";
}

export function registerUsageHandlers(): void {
  ipcMain.handle("usage:summary", async (_event, range: unknown) => {
    return usageStore.summary(parseRange(range));
  });
}
