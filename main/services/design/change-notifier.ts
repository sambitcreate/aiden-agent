// designProjects:changed broadcasts (ADR-DS §6), throttled per project. A
// subscriber re-reads designProjects:get for the full snapshot. A project that
// no longer exists is announced with revision 0, and its throttle is released.
export interface ProjectChangeEvent {
  projectId: string;
  revision: number;
}

interface ChangeTrigger {
  trigger(): void;
  dispose(): void;
}

export function createProjectChangeNotifier(deps: {
  broadcast(event: ProjectChangeEvent): void;
  /** The project's current revision, or undefined once it is deleted. */
  revisionOf(projectId: string): number | undefined;
  /** createThrottledTrigger in production. */
  createTrigger(run: () => void): ChangeTrigger;
}): (projectId: string) => void {
  const triggers = new Map<string, ChangeTrigger>();
  return (projectId) => {
    let entry = triggers.get(projectId);
    if (!entry) {
      const created: ChangeTrigger = deps.createTrigger(() => {
        const revision = deps.revisionOf(projectId);
        deps.broadcast({ projectId, revision: revision ?? 0 });
        if (revision === undefined) {
          created.dispose();
          if (triggers.get(projectId) === created) triggers.delete(projectId);
        }
      });
      entry = created;
      triggers.set(projectId, entry);
    }
    entry.trigger();
  };
}
