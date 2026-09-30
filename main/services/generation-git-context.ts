import { gitInfo, GitServiceError } from "./git.js";
import type { GitInfo } from "./types.js";

/** Optional prompt enrichment, never a replacement for managed-worktree admission. */
export async function generationGitContext(
  folderPath: string | undefined,
  signal: AbortSignal,
  lookup: typeof gitInfo = gitInfo,
): Promise<GitInfo> {
  signal.throwIfAborted();
  if (!folderPath) return { isRepo: false };
  try {
    const info = await lookup(folderPath, signal);
    signal.throwIfAborted();
    return info;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof GitServiceError && error.code === "aborted") throw error;
    return { isRepo: false };
  }
}
