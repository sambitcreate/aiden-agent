export interface RendererQuitWindow {
  isDestroyed(): boolean;
  close(): void;
  destroy(): void;
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  webContents: {
    once(event: string, listener: () => void): unknown;
    removeListener(event: string, listener: () => void): unknown;
  };
}

export type DeadlineOutcome<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "timed-out" };

/**
 * Settle `work` within `budgetMs`. A synchronous throw counts as a rejection,
 * and the timer is always cleared so a fast step never holds the loop open.
 * The work itself is not cancelled: quit and close paths use the outcome to
 * stop waiting on a hung renderer or service.
 */
export async function withDeadline<T>(
  work: () => PromiseLike<T> | T,
  budgetMs: number,
): Promise<DeadlineOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<DeadlineOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed-out" }), Math.max(0, budgetMs));
  });
  const settled = (async (): Promise<DeadlineOutcome<T>> => {
    try {
      return { status: "fulfilled", value: await work() };
    } catch (error) {
      return { status: "rejected", error };
    }
  })();
  try {
    return await Promise.race([settled, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long a closing renderer may stay silent before Aiden destroys it. */
export const RENDERER_CLOSE_DEADLINE_MS = 5_000;

/**
 * Resolve true only after the renderer can no longer veto or issue IPC.
 *
 * A hung renderer never answers beforeunload, so neither `closed` nor
 * `will-prevent-unload` arrives. After `deadlineMs` of silence the window is
 * destroyed, which skips its unload handlers; callers have already authorized
 * the close by then.
 */
export function closeRendererBeforeShutdown(
  window: RendererQuitWindow,
  deadlineMs = RENDERER_CLOSE_DEADLINE_MS,
): Promise<boolean> {
  if (window.isDestroyed()) return Promise.resolve(true);
  // BrowserWindow.webContents becomes an invalid native getter as soon as the
  // `closed` event fires. Retain the EventEmitter object before closing and
  // never dereference the destroyed BrowserWindow during listener cleanup.
  const webContents = window.webContents;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try {
        window.removeListener("closed", didClose);
      } catch {
        // A real BrowserWindow can reject method access after destruction.
      }
      try {
        webContents.removeListener("will-prevent-unload", didPreventUnload);
      } catch {
        // The close event is already authoritative; cleanup stays best effort.
      }
      resolve(closed);
    };
    const didClose = () => finish(true);
    const didPreventUnload = () => finish(false);
    window.once("closed", didClose);
    webContents.once("will-prevent-unload", didPreventUnload);
    try {
      window.close();
    } catch {
      finish(false);
      return;
    }
    if (settled) return;
    deadline = setTimeout(() => {
      if (settled) return;
      try {
        if (!window.isDestroyed()) window.destroy();
      } catch {
        // Destruction is the last resort; the window is unusable either way.
      }
      finish(true);
    }, Math.max(0, deadlineMs));
  });
}
