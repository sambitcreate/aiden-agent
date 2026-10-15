// Minimal IPC bridge primitives. Kept free of runtime parsers so small windows
// (the dictation pill) can talk to main without loading the full `ipc.ts` graph.

import { normalizeIpcError } from "./ipc-error";

function bridge() {
  return window.aidenAPI.ipc;
}

export function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return (bridge().invoke(channel, ...args) as Promise<T>).catch((error: unknown) => {
    throw normalizeIpcError(error);
  });
}

export function onNotification<T>(method: string, handler: (payload: T) => void): () => void {
  return bridge().onNotification(method, handler as (params: unknown) => void);
}
