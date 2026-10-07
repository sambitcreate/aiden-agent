import type { DesignProjectStore } from "./store.js";

/**
 * Design Studio startup reconciliation, run in the main/index.ts startup chain before
 * IPC admission opens. Disabled means no directory, no manifest read and no chat write.
 * A failure to open the store is reported and the app still starts; the Design surface
 * then reports a storage error. A failure to finish an interrupted deletion is reported
 * too, and the cascade resumes on the next launch.
 */
export async function startDesignStudio(deps: {
  enabled: boolean;
  store: Pick<DesignProjectStore, "initialize" | "resumeDeletions">;
  onError(error: unknown): void;
}): Promise<boolean> {
  if (!deps.enabled) return false;
  try {
    await deps.store.initialize();
  } catch (error) {
    deps.onError(error);
    return false;
  }
  try {
    await deps.store.resumeDeletions();
  } catch (error) {
    deps.onError(error);
  }
  return true;
}
