import { ensureUserDataDir } from "./data-store.js";
import { MemoryStore } from "./memory-store.js";

export const memoryStore = new MemoryStore({
  root: () => ensureUserDataDir("memory"),
});
