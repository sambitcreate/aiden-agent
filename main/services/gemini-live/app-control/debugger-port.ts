// The DevTools protocol on Aiden's own window, through Electron's
// `webContents.debugger`, shared by every Live session on that window.
//
// Nothing else in Aiden attaches a debugger to the main window (the in-app
// browser attaches to its own tab views), so DevTools being open, or a
// debugger that is attached and not Live's, means someone is inspecting the
// window: Live reports that with a fixed error instead of taking it over.
//
// The attachment belongs to the window, not to one session: sessions share
// it and the last one to close detaches. A session that starts while the
// previous one is still closing therefore finds Live's own debugger, not a
// stranger's, and never reports a window that isn't being inspected.

import { AidenWindowInspectedError, type AidenWindowPort } from "./provider.js";

/** The parts of Electron's WebContents the port uses. */
export interface DebuggableContents {
  isDestroyed(): boolean;
  isDevToolsOpened(): boolean;
  on(event: "devtools-opened" | "did-navigate" | "did-navigate-in-page", listener: () => void): unknown;
  removeListener(event: "devtools-opened" | "did-navigate" | "did-navigate-in-page", listener: () => void): unknown;
  readonly debugger: {
    attach(protocolVersion?: string): void;
    detach(): void;
    isAttached(): boolean;
    sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
    on(event: "detach", listener: () => void): unknown;
    removeListener(event: "detach", listener: () => void): unknown;
  };
}

interface SharedAttachment {
  users: number;
  /** Live attached the debugger and still holds it. */
  ours: boolean;
  dispose(): void;
}

const attachments = new WeakMap<DebuggableContents, SharedAttachment>();

function detachIfOurs(contents: DebuggableContents, shared: SharedAttachment): void {
  if (shared.ours && !contents.isDestroyed() && contents.debugger.isAttached()) {
    try {
      contents.debugger.detach();
    } catch {
      // Already detached by the window closing.
    }
  }
  shared.ours = false;
}

function acquire(contents: DebuggableContents): SharedAttachment {
  let shared = attachments.get(contents);
  if (!shared) {
    const state: SharedAttachment = { users: 0, ours: false, dispose: () => undefined };
    const onDetach = () => {
      state.ours = false;
    };
    // DevTools opening is someone inspecting the window: Live lets go of it.
    const onDevToolsOpened = () => detachIfOurs(contents, state);
    contents.debugger.on("detach", onDetach);
    contents.on("devtools-opened", onDevToolsOpened);
    state.dispose = () => {
      if (contents.isDestroyed()) return;
      contents.debugger.removeListener("detach", onDetach);
      contents.removeListener("devtools-opened", onDevToolsOpened);
    };
    attachments.set(contents, state);
    shared = state;
  }
  shared.users += 1;
  return shared;
}

function release(contents: DebuggableContents, shared: SharedAttachment): void {
  shared.users -= 1;
  if (shared.users > 0) return;
  detachIfOurs(contents, shared);
  shared.dispose();
  attachments.delete(contents);
}

/** A port for one Live session; closing it releases its share of the attachment. */
export function createSharedDebuggerPort(contents: DebuggableContents): AidenWindowPort | null {
  if (contents.isDestroyed()) return null;
  const shared = acquire(contents);
  let closed = false;
  const ensureAttached = () => {
    if (closed || contents.isDestroyed()) throw new Error("Aiden's window is gone.");
    if (contents.isDevToolsOpened()) {
      detachIfOurs(contents, shared);
      throw new AidenWindowInspectedError();
    }
    if (shared.ours && contents.debugger.isAttached()) return;
    shared.ours = false;
    if (contents.debugger.isAttached()) throw new AidenWindowInspectedError();
    try {
      contents.debugger.attach("1.3");
      shared.ours = true;
    } catch {
      throw new AidenWindowInspectedError();
    }
  };
  return {
    async call(method, params) {
      ensureAttached();
      return contents.debugger.sendCommand(method, params);
    },
    onNavigate(listener) {
      const navigated = () => listener();
      contents.on("did-navigate", navigated);
      contents.on("did-navigate-in-page", navigated);
      return () => {
        if (contents.isDestroyed()) return;
        contents.removeListener("did-navigate", navigated);
        contents.removeListener("did-navigate-in-page", navigated);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      release(contents, shared);
    },
  };
}
