export interface RendererLifecycleGuard {
  dirty: boolean;
  gitBusy: boolean;
  revision: number;
  saving: boolean;
}

/**
 * What holds unsaved work. Each source owns its own dirty and saving state, so one surface
 * clearing its state (the Files editor switching workspace) never releases another's (an image
 * workflow still autosaving), and main can name the right thing in the quit prompt.
 */
export type RendererLifecycleSource = "editor" | "images";

interface SourceState {
  dirty: boolean;
  saving: boolean;
  /** Shown to the person in main's prompt, e.g. the image workflow's title. */
  label?: string;
}

const SOURCES: readonly RendererLifecycleSource[] = ["editor", "images"];
const sources: Record<RendererLifecycleSource, SourceState> = {
  editor: { dirty: false, saving: false },
  images: { dirty: false, saving: false },
};
let current: RendererLifecycleGuard = { dirty: false, gitBusy: false, revision: 0, saving: false };

function publish(): void {
  const dataset = document.documentElement.dataset;
  dataset.aidenDirty = current.dirty ? "1" : "0";
  dataset.aidenGitBusy = current.gitBusy ? "1" : "0";
  dataset.aidenGuardRevision = String(current.revision);
  dataset.aidenSaving = current.saving ? "1" : "0";
  dataset.aidenDirtySources = SOURCES.filter((source) => sources[source].dirty).join(" ");
  dataset.aidenSavingSources = SOURCES.filter((source) => sources[source].saving).join(" ");
  const images = sources.images;
  if ((images.dirty || images.saving) && images.label) dataset.aidenImagesLabel = images.label;
  else delete dataset.aidenImagesLabel;
}

/**
 * Updates one source's dirty and saving state (the Files editor unless `source` says otherwise)
 * and the shared Git flag. The guard is dirty or saving while any source is.
 */
export function setRendererLifecycleGuard(
  patch: Partial<Omit<RendererLifecycleGuard, "revision">>,
  options: { touch?: boolean; source?: RendererLifecycleSource; label?: string } = {},
): void {
  const source = options.source ?? "editor";
  const before = sources[source];
  const after: SourceState = {
    dirty: patch.dirty ?? before.dirty,
    saving: patch.saving ?? before.saving,
    ...(options.label !== undefined ? { label: options.label } : before.label !== undefined ? { label: before.label } : {}),
  };
  sources[source] = after;
  const gitBusy = patch.gitBusy ?? current.gitBusy;
  const changed = after.dirty !== before.dirty || after.saving !== before.saving || gitBusy !== current.gitBusy;
  current = {
    dirty: SOURCES.some((name) => sources[name].dirty),
    gitBusy,
    saving: SOURCES.some((name) => sources[name].saving),
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
