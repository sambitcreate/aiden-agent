// Whether a workspace's folder is still on disk, as main reports it to the
// renderer. `none`: the workspace has no folder. `unknown`: the check could not
// answer (for example a permission error), which is not treated as missing.
export interface WorkspaceFolderPresenceResult {
  presence: "present" | "missing" | "unknown" | "none";
  /** The folder with the home folder shown as `~`; absent for `none`. */
  folder?: string;
}

/** One sentence naming a moved or deleted workspace folder, shared by main and the renderer. */
export function workspaceFolderMissingMessage(name: string, folder?: string): string {
  const where = folder ? `: ${folder}` : "";
  return `The folder for “${name}” is missing${where}. It may have been moved, renamed or deleted. Put it back, or start the chat in another workspace.`;
}
