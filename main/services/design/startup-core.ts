import type { DesignProjectStore } from "./store.js";

/**
 * Design Studio startup reconciliation, run in the main/index.ts startup chain before
 * IPC admission opens. Disabled means no directory, no manifest read and no chat write.
 * A failure to open the store is logged through onError and the app still starts. The
 * store then lists no projects and refuses writes: it has no availability signal yet, so
 * the Design surface cannot tell this apart from an empty library. A failure to finish
 * an interrupted deletion is logged too, and the cascade resumes on the next launch.
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
