/**
 * Main-frame load completion for a programmatic browser navigation.
 *
 * Electron's `webContents.loadURL` settles on the first main-frame
 * `did-finish-load` or `did-fail-load` after the call. When the call replaces a
 * document that has committed but is still loading, that old document's own
 * completion arrives after the new navigation started: its `did-finish-load`
 * resolves the new promise before the requested page exists, and its load
 * abort (`did-fail-load` with ERR_ABORTED) rejects the new promise although the
 * requested page loads. Both describe the replaced document, not this load.
 *
 * Electron reports a cancelled provisional navigation without `did-fail-load`,
 * so before this navigation commits, a main-frame ERR_ABORTED and a finished
 * load can only belong to the replaced document. Every other rule matches
 * Electron's: a later cross-document start aborts this load, a failure is
 * reported when loading ends, and destruction fails it.
 */

const ERR_ABORTED = -3;
const ERR_FAILED = -2;

/** The Electron `WebContents` surface this waiter uses. */
export interface BrowserLoadTarget {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  loadURL(url: string): Promise<void>;
}

type LoadFailure = { errorCode: number; errorDescription: string; url: string };

function loadError({ errorCode, errorDescription, url }: LoadFailure): Error {
  // Same text and fields as Electron's own loadURL rejection.
  return Object.assign(new Error(`${errorDescription} (${errorCode}) loading '${url.slice(0, 2048)}'`), {
    errno: errorCode,
    code: errorDescription,
    url,
  });
}

export function loadBrowserUrl(contents: BrowserLoadTarget, url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let started = false;
    let sameDocument = false;
    let committed = false;
    let failure: LoadFailure | undefined;
    const listeners: Array<[string, (...args: any[]) => void]> = [];
    const listen = (event: string, listener: (...args: any[]) => void) => {
      listeners.push([event, listener]);
      contents.on(event, listener);
    };
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      for (const [event, listener] of listeners) contents.removeListener(event, listener);
      if (error) reject(error);
      else resolve();
    };
    const finish = () => settle(failure ? loadError(failure) : undefined);
    listen("did-start-navigation", (_event, startedUrl: string, isSameDocument: boolean, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      if (!started) {
        // loadURL starts its own navigation synchronously, before any other.
        started = true;
        sameDocument = isSameDocument;
      } else if (!isSameDocument) {
        settle(loadError({ errorCode: ERR_ABORTED, errorDescription: "ERR_ABORTED", url: startedUrl }));
      }
    });
    listen("did-navigate", () => {
      if (started && !sameDocument) committed = true;
    });
    listen("did-navigate-in-page", () => {
      if (started && sameDocument) finish();
    });
    listen("did-fail-load", (_event, errorCode: number, errorDescription: string, validatedUrl: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      // The replaced document's load abort, delivered after this navigation began.
      if (started && !sameDocument && !committed && errorCode === ERR_ABORTED) return;
      failure ??= { errorCode, errorDescription, url: validatedUrl };
      if (!started) finish();
    });
    listen("did-finish-load", () => {
      // Before this navigation commits, a finished load is the replaced document's.
      if (started && !sameDocument && !committed && !failure) return;
      finish();
    });
    const stopped = () => {
      failure ??= { errorCode: ERR_FAILED, errorDescription: "ERR_FAILED", url };
      finish();
    };
    listen("did-stop-loading", stopped);
    listen("destroyed", stopped);
    try {
      // Electron's own promise carries only failures that precede any navigation
      // (for example, a rejected URL); after one starts, the listeners above decide.
      contents.loadURL(url).catch((error: unknown) => {
        if (!started) settle(error);
      });
    } catch (error) {
      settle(error);
    }
  });
}
