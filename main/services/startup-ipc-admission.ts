// Startup admission for renderer invokes.
//
// The main window is created while the persisted-state reconcile chain is
// still running, so its renderer bundle loads in parallel with that work.
// Renderers must still never read or mutate chats, artifacts, workspaces, or
// settings before reconciliation finishes. Installing this admission before
// any `ipcMain.handle` registration holds every invoke (in arrival order) until
// `open()` is called, which keeps the old "no renderer before reconcile"
// invariant without touching each of the individual handlers.

import type { IpcMain } from "electron";

export type InvokeHandlerTarget = Pick<IpcMain, "handle">;

export interface StartupIpcAdmission {
  /** Admit every held and future invoke. Idempotent. */
  open(): void;
  isOpen(): boolean;
}

export function installStartupIpcAdmission(
  target: InvokeHandlerTarget,
): StartupIpcAdmission {
  let opened = false;
  let release: () => void = () => undefined;
  const admitted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handle = target.handle.bind(target);
  target.handle = (channel, listener) => {
    handle(channel, (event, ...args) =>
      opened
        ? listener(event, ...args)
        : admitted.then(() => listener(event, ...args)),
    );
  };
  return {
    open() {
      if (opened) return;
      opened = true;
      release();
    },
    isOpen: () => opened,
  };
}

let processAdmission: StartupIpcAdmission | null = null;

/** Install the process-wide admission once, before the app registers handlers. */
export function installProcessStartupIpcAdmission(
  target: InvokeHandlerTarget,
): void {
  processAdmission ??= installStartupIpcAdmission(target);
}

/** Admit renderer invokes once startup reconciliation has finished. */
export function openProcessStartupIpcAdmission(): void {
  processAdmission?.open();
}
