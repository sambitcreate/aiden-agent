// Design Studio's IPC exists only while its capability is on. With it off, no
// designProjects channel is registered and none of its dependencies is built.
import { registerDesignProjectHandlers, type DesignIpcRegistrar, type DesignProjectHandlerDeps } from "./projects.js";
import { registerDesignRunHandlers, type DesignRunHandlerDeps } from "./run.js";

export interface DesignHandlerDeps {
  projects: DesignProjectHandlerDeps;
  runs: DesignRunHandlerDeps;
}

/** Registers the ten designProjects channels when enabled; returns whether it did. */
export function registerDesignStudioHandlers(
  enabled: boolean,
  ipc: DesignIpcRegistrar,
  deps: () => DesignHandlerDeps,
): boolean {
  if (!enabled) return false;
  const { projects, runs } = deps();
  registerDesignProjectHandlers(ipc, projects);
  registerDesignRunHandlers(ipc, runs);
  return true;
}
