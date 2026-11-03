import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface AcpScratchDirectoriesOptions {
  /** Parent of the per-chat directories, for example `userData/acp/scratch`. */
  root: () => string;
  /** Parent of the private fallback when `root` cannot be prepared. */
  tempRoot?: () => string;
  onPrepareError?: (error: unknown) => void;
}

export interface AcpScratchDirectories {
  /** Working directory for an agent turn in a chat without a folder. It grants no file access. */
  directoryFor(chatId: string): Promise<string>;
  /** Removes a deleted chat's directory and its fallback, if any. Never throws. */
  forget(chatId: string): Promise<void>;
}

function safeName(chatId: string): string {
  return chatId.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80) || "chat";
}

export function createAcpScratchDirectories(options: AcpScratchDirectoriesOptions): AcpScratchDirectories {
  const tempRoot = options.tempRoot ?? tmpdir;
  const fallbacks = new Map<string, Promise<string>>();
  return {
    async directoryFor(chatId) {
      const directory = join(options.root(), safeName(chatId));
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        return directory;
      } catch (error) {
        // Never fail a generation over its working directory; this one grants
        // no file access either way.
        options.onPrepareError?.(error);
        // A private directory, never the shared temp folder itself, reused for
        // the chat so its agent session is not rebuilt on every turn.
        let fallback = fallbacks.get(chatId);
        if (!fallback) {
          const parent = tempRoot();
          fallback = mkdtemp(join(parent, "aiden-acp-scratch-")).catch(() => parent);
          fallbacks.set(chatId, fallback);
        }
        return fallback;
      }
    },
    async forget(chatId) {
      const fallback = fallbacks.get(chatId);
      fallbacks.delete(chatId);
      const directories = [join(options.root(), safeName(chatId))];
      if (fallback) {
        const directory = await fallback;
        // The fallback can degrade to the shared temp folder itself; never remove that.
        if (directory !== tempRoot()) directories.push(directory);
      }
      await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true }).catch(() => undefined)),
      );
    },
  };
}
