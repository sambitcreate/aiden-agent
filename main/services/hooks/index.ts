import type { HookDispatcher, HookOutcome } from "./hook-types.js";

export * from "./hook-types.js";

const noHooks: HookDispatcher = {
  async dispatch(): Promise<HookOutcome> {
    return { ranHooks: [] };
  },
  hasHooks: () => false,
};

let current: HookDispatcher = noHooks;

/** The process-wide hook dispatcher. Callers on every surface go through this. */
export function getHookDispatcher(): HookDispatcher {
  return current;
}

/** Installed once at startup by the hook service; tests swap in fakes. */
export function setHookDispatcher(dispatcher: HookDispatcher | undefined): void {
  current = dispatcher ?? noHooks;
}
