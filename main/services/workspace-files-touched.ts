/**
 * Tells every window that an agent tool may have changed files in a
 * workspace folder, whichever window, phone or routine started the turn.
 * `chat:tool` reaches only the window that owns the turn, and `git:changed`
 * watches HEAD, the index and refs, not working files, so without this the
 * Files panel, the Changes card and the skills menu wait for the turn to end.
 */

/** Tools that can write to the chat's workspace folder. */
export const FILE_TOUCHING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "run_command",
  "codemode",
  "subagent",
]);

/** Agent tools can run back to back; one notice per workspace per window of this length. */
export const WORKSPACE_FILES_TOUCHED_DELAY_MS = 750;

export interface WorkspaceFilesTouchedOptions {
  broadcast(workspaceId: string): void;
  delayMs?: number;
  schedule?(callback: () => void, delayMs: number): unknown;
}

export function createWorkspaceFilesTouchedNotifier(options: WorkspaceFilesTouchedOptions) {
  const delayMs = options.delayMs ?? WORKSPACE_FILES_TOUCHED_DELAY_MS;
  const schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms).unref?.());
  const pending = new Set<string>();
  return (workspaceId: string | undefined, toolName: string): void => {
    if (!workspaceId || !FILE_TOUCHING_TOOL_NAMES.has(toolName) || pending.has(workspaceId)) return;
    pending.add(workspaceId);
    schedule(() => {
      pending.delete(workspaceId);
      options.broadcast(workspaceId);
    }, delayMs);
  };
}
