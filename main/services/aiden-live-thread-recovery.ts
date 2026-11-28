import * as path from "node:path";
import { app } from "../platform.js";
import { AidenLiveThreadStore } from "./aiden-live-thread-store.js";

export const aidenLiveThreadStore = new AidenLiveThreadStore(() =>
  path.join(app.getPath("userData"), "aiden-live"),
);

let aidenLiveThreadRecovery: Promise<void> | null = null;

export function ensureAidenLiveThreadRecovery(): Promise<void> {
  aidenLiveThreadRecovery ??= aidenLiveThreadStore
    .reconcileActive()
    .then(() => undefined)
    .catch((error: unknown) => {
      aidenLiveThreadRecovery = null;
      process.stderr.write(
        `[aiden-live] stage=thread-recovery result=failed type=${error instanceof Error ? error.name : "unknown"}\n`,
      );
      throw error;
    });
  return aidenLiveThreadRecovery;
}

/** Run crash reconciliation at application startup before a renderer can start Live. */
export function initializeAidenLiveService(): Promise<void> {
  return ensureAidenLiveThreadRecovery();
}
