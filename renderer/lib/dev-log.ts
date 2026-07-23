// Dev-only renderer error capture: forwards uncaught exceptions and unhandled
// promise rejections to the main-process dev log file (see main/services/dev-log.ts).
// Installed only in development builds; a no-op in production.

import { devlogApi } from "./ipc";

export function installDevErrorLogging(): void {
  if (!import.meta.env.DEV) return;

  window.addEventListener("error", (event) => {
    const error = event.error;
    const detail = error instanceof Error && error.stack ? `\n${error.stack}` : "";
    void devlogApi.write("error", `Uncaught: ${event.message}${detail}`).catch(() => {});
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const detail =
      reason instanceof Error ? `${reason.message}${reason.stack ? `\n${reason.stack}` : ""}` : String(reason);
    void devlogApi.write("error", `Unhandled rejection: ${detail}`).catch(() => {});
  });
}
