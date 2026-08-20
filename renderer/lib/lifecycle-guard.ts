export interface RendererLifecycleGuard {
  dirty: boolean;
  gitBusy: boolean;
  revision: number;
  saving: boolean;
}

let current: RendererLifecycleGuard = { dirty: false, gitBusy: false, revision: 0, saving: false };
const owners = new Map<string, Omit<RendererLifecycleGuard, "revision">>();

function publish(): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.aidenDirty = current.dirty ? "1" : "0";
  document.documentElement.dataset.aidenGitBusy = current.gitBusy ? "1" : "0";
  document.documentElement.dataset.aidenGuardRevision = String(current.revision);
  document.documentElement.dataset.aidenSaving = current.saving ? "1" : "0";
}

function aggregateOwners(): Omit<RendererLifecycleGuard, "revision"> {
  let dirty = false;
  let gitBusy = false;
  let saving = false;
  for (const owner of owners.values()) {
    dirty ||= owner.dirty;
    gitBusy ||= owner.gitBusy;
    saving ||= owner.saving;
  }
  return { dirty, gitBusy, saving };
}

export function setRendererLifecycleGuard(
  owner: string,
  patch: Partial<Omit<RendererLifecycleGuard, "revision">>,
  options: { touch?: boolean } = {},
): void {
  const previousOwner = owners.get(owner) ?? { dirty: false, gitBusy: false, saving: false };
  owners.set(owner, { ...previousOwner, ...patch });
  const aggregate = aggregateOwners();
  const next = { ...current, ...aggregate };
  const changed =
    next.dirty !== current.dirty ||
    next.gitBusy !== current.gitBusy ||
    next.saving !== current.saving;
  current = {
    ...next,
    revision: changed || options.touch ? current.revision + 1 : current.revision,
  };
  if (changed || options.touch) {
    if (typeof document !== "undefined") {
      delete document.documentElement.dataset.aidenApprovedGuardRevision;
    }
  }
  publish();
}

export function clearRendererLifecycleGuard(
  owner: string,
  options: { touch?: boolean } = {},
): void {
  const existed = owners.delete(owner);
  if (!existed && !options.touch) return;
  const aggregate = aggregateOwners();
  const changed =
    aggregate.dirty !== current.dirty ||
    aggregate.gitBusy !== current.gitBusy ||
    aggregate.saving !== current.saving;
  current = {
    ...aggregate,
    revision: changed || options.touch ? current.revision + 1 : current.revision,
  };
  if (changed || options.touch) {
    if (typeof document !== "undefined") {
      delete document.documentElement.dataset.aidenApprovedGuardRevision;
    }
  }
  publish();
}

export function rendererLifecycleGuarded(): boolean {
  return current.dirty || current.gitBusy || current.saving;
}

export function consumeRendererLifecycleUnloadApproval(): boolean {
  if (typeof document === "undefined") return false;
  const approved = document.documentElement.dataset.aidenApprovedGuardRevision;
  if (approved !== String(current.revision)) return false;
  delete document.documentElement.dataset.aidenApprovedGuardRevision;
  return true;
}

publish();
