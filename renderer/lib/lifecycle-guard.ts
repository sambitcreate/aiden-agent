export interface RendererLifecycleGuard {
  dirty: boolean;
  gitBusy: boolean;
  revision: number;
  saving: boolean;
}

let current: RendererLifecycleGuard = { dirty: false, gitBusy: false, revision: 0, saving: false };

function publish(): void {
  document.documentElement.dataset.aidenDirty = current.dirty ? "1" : "0";
  document.documentElement.dataset.aidenGitBusy = current.gitBusy ? "1" : "0";
  document.documentElement.dataset.aidenGuardRevision = String(current.revision);
  document.documentElement.dataset.aidenSaving = current.saving ? "1" : "0";
}

export function setRendererLifecycleGuard(
  patch: Partial<Omit<RendererLifecycleGuard, "revision">>,
  options: { touch?: boolean } = {},
): void {
  const next = { ...current, ...patch };
  const changed =
    next.dirty !== current.dirty ||
    next.gitBusy !== current.gitBusy ||
    next.saving !== current.saving;
  current = {
    ...next,
    revision: changed || options.touch ? current.revision + 1 : current.revision,
  };
  if (changed || options.touch) clearRendererLifecycleUnloadApproval();
  publish();
}

/**
 * Main arms an unload for the guard revision the person just confirmed. Main
 * cannot cancel the script that calls this, so a call that arrives after
 * `armBy` (main has stopped waiting) installs nothing, and an approval is
 * only honoured until `expiresAt`, so a late one never lingers for an
 * unrelated reload.
 */
export function armRendererLifecycleUnloadApproval(
  revision: number,
  armBy: number,
  expiresAt: number,
  now = Date.now(),
): boolean {
  if (now > armBy || revision !== current.revision) return false;
  document.documentElement.dataset.aidenApprovedGuardRevision = String(revision);
  document.documentElement.dataset.aidenApprovedGuardExpiresAt = String(expiresAt);
  return true;
}

/** Main calls this when an action it armed is declined or abandoned. */
export function clearRendererLifecycleUnloadApproval(): void {
  delete document.documentElement.dataset.aidenApprovedGuardRevision;
  delete document.documentElement.dataset.aidenApprovedGuardExpiresAt;
}

export function rendererLifecycleGuarded(): boolean {
  return current.dirty || current.gitBusy || current.saving;
}

export function consumeRendererLifecycleUnloadApproval(now = Date.now()): boolean {
  const { aidenApprovedGuardRevision: approved, aidenApprovedGuardExpiresAt: expiresAt } =
    document.documentElement.dataset;
  clearRendererLifecycleUnloadApproval();
  return approved === String(current.revision) && now <= Number(expiresAt);
}

type LifecycleFlush = () => Promise<void>;
const flushes = new Set<LifecycleFlush>();

/**
 * Registers work that saves pending edits. Main runs every registered flush (bounded) before it
 * reads the close guard for quit, close or reload, so an edit waiting on a debounce is saved
 * instead of stopping on the unsaved-changes prompt. Returns the unregister function.
 */
export function registerLifecycleFlush(flush: LifecycleFlush): () => void {
  flushes.add(flush);
  return () => {
    flushes.delete(flush);
  };
}

async function flushPendingSaves(): Promise<void> {
  await Promise.allSettled([...flushes].map((flush) => flush()));
}

declare global {
  interface Window {
    /** Called by main through executeJavaScript before it reads the close guard. */
    __aidenFlushPendingSaves?: () => Promise<void>;
    /** Called by main through executeJavaScript once the person confirms a protected unload. */
    __aidenArmUnloadApproval?: (revision: number, armBy: number, expiresAt: number) => boolean;
    /** Called by main through executeJavaScript when a protected unload is declined. */
    __aidenClearUnloadApproval?: () => void;
  }
}

window.__aidenFlushPendingSaves = flushPendingSaves;
window.__aidenArmUnloadApproval = (revision, armBy, expiresAt) =>
  armRendererLifecycleUnloadApproval(revision, armBy, expiresAt);
window.__aidenClearUnloadApproval = clearRendererLifecycleUnloadApproval;
publish();
