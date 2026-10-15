// Whether the user can currently see and is using this window. Safety-net
// polling only runs while it is active; push events cover the rest.

export interface WindowActivityTarget {
  hasFocus(): boolean;
  visibilityState: DocumentVisibilityState;
}

function currentDocument(): WindowActivityTarget | undefined {
  return typeof document === "undefined" ? undefined : document;
}

export function isWindowActive(target: WindowActivityTarget | undefined = currentDocument()): boolean {
  if (!target) return true;
  return target.visibilityState === "visible" && target.hasFocus();
}

/** Calls `listener` each time the window goes from inactive (hidden or blurred) to active. */
export function subscribeWindowActivated(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
  let active = isWindowActive();
  const update = () => {
    const next = isWindowActive();
    if (next && !active) listener();
    active = next;
  };
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  document.addEventListener("visibilitychange", update);
  return () => {
    window.removeEventListener("focus", update);
    window.removeEventListener("blur", update);
    document.removeEventListener("visibilitychange", update);
  };
}
