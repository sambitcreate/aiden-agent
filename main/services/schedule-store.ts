import { DataStore } from "./data-store.js";
import { createScheduleStore } from "./schedule-store-core.js";
export * from "./schedule-store-core.js";

const taskPersistence = new DataStore<unknown[]>("schedules.json", []);
const runPersistence = new DataStore<unknown[]>("schedule-runs.json", []);

// Imported lazily to keep the pure schedule-store factory free from config I/O in tests.
const resolvePersistedProviderId = async (providerId: string | undefined) => {
  const { configStore } = await import("./config-store.js");
  return configStore.resolveProviderId(providerId);
};

export const scheduleStore = createScheduleStore(
  taskPersistence,
  runPersistence,
  Date.now,
  resolvePersistedProviderId,
);
