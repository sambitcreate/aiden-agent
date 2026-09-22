export interface CreateImagesRunOwnerSnapshot {
  status: string;
  activeRun?: { runId: string };
}

/**
 * A transient/busy snapshot proves nothing about run liveness. Renderer
 * disconnect ownership may be released only by an authoritative ready list
 * that proves this exact run is no longer active.
 */
export function shouldReleaseCreateImagesRunOwner(
  runId: string,
  snapshot: CreateImagesRunOwnerSnapshot,
): boolean {
  return snapshot.status === "ready" && snapshot.activeRun?.runId !== runId;
}
