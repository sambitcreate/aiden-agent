// Electron wraps every error thrown by an `ipcMain.handle` handler as
// "Error invoking remote method '<channel>': Error: <message>". The wrapper is
// transport noise, not user-facing copy, so the renderer strips it once at the
// IPC boundary instead of in each screen.
const REMOTE_METHOD_PREFIX = /^Error invoking remote method(?: ['"][^'"]*['"])?:\s*/u;
const ERROR_CLASS_PREFIX = /^[A-Z]?[A-Za-z]*Error:\s*/u;

/** Remove Electron's remote-method wrapper and the serialized error class name. */
export function stripIpcErrorPrefix(message: string): string {
  const unwrapped = message.replace(REMOTE_METHOD_PREFIX, "");
  if (unwrapped === message) return message;
  const stripped = unwrapped.replace(ERROR_CLASS_PREFIX, "").trim();
  return stripped || unwrapped.trim() || message;
}

/** Re-throwable error whose message no longer carries the IPC wrapper. */
export function normalizeIpcError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const message = stripIpcErrorPrefix(error.message);
  if (message === error.message) return error;
  return new Error(message);
}

/** User-facing text for any caught error, with the IPC wrapper removed. */
export function userFacingErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return stripIpcErrorPrefix(raw).trim() || fallback;
}
