import { AsyncLocalStorage } from "node:async_hooks";
import { tmpdir } from "node:os";

export const CURSOR_PROVIDER_ID = "cursor";
export const CURSOR_PROVIDER_NAME = "Cursor";
export const CURSOR_BASE_URL = "https://cursor.com";

export interface CursorSessionBinding {
  cwd: string;
  sessionId: string;
  sessionFile: string;
  projectTrusted: boolean;
}

const cursorSession = new AsyncLocalStorage<CursorSessionBinding>();

/** Bind one Aiden chat/child identity onto Cursor SDK's process-global session scope. */
export function runWithCursorSession<T>(binding: CursorSessionBinding, fn: () => T): T {
  return cursorSession.run(binding, fn);
}

export function currentCursorSession(): CursorSessionBinding | undefined {
  return cursorSession.getStore();
}

export function cursorSessionFileFor(sessionId: string): string {
  const id = sessionId.trim();
  return id ? `aiden:${id.slice(0, 128)}` : "aiden:anonymous";
}

/** Conservative scope when a Cursor stream runs outside an Aiden chat wrapper. */
export function unboundCursorSession(): CursorSessionBinding {
  return {
    cwd: tmpdir(),
    sessionId: "unbound",
    sessionFile: "aiden:unbound",
    projectTrusted: false,
  };
}
