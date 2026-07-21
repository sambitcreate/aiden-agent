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
  if (changed || options.touch) {
    delete document.documentElement.dataset.aidenApprovedGuardRevision;
  }
  publish();
}

export function rendererLifecycleGuarded(): boolean {
  return current.dirty || current.gitBusy || current.saving;
}

export function consumeRendererLifecycleUnloadApproval(): boolean {
  const approved = document.documentElement.dataset.aidenApprovedGuardRevision;
  if (approved !== String(current.revision)) return false;
  delete document.documentElement.dataset.aidenApprovedGuardRevision;
  return true;
}

publish();
