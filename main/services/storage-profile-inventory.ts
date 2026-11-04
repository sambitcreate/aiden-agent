// Desktop Settings → Storage: the profile inventory.
//
// One place lists every directory under Aiden's device-local user-data profile
// and says which Storage category it belongs to. The scanner walks only paths
// named here, so a new store must be added deliberately and can never be
// measured — or cleared — by accident.

import * as path from "node:path";
import type { StorageCategoryId } from "../../renderer/shared/storage.js";

export interface StorageProfileEntry {
  /** Path relative to the profile root. */
  relativePath: string;
  category: StorageCategoryId;
}

/**
 * Directories Aiden writes under its user-data profile, by category.
 *
 * `caches` covers records that are safe to regenerate: they are measured but
 * never offered for deletion, because deleting them silently loses paired-device
 * state, approvals, and Bot bindings rather than reclaiming anything meaningful.
 */
export const STORAGE_PROFILE_LAYOUT: readonly StorageProfileEntry[] = [
  // Worktrees and their restorable snapshots.
  { relativePath: "worktrees", category: "worktrees" },
  { relativePath: "worktree-snapshots", category: "snapshots" },

  // Chats: transcripts, their image files, and the private per-chat runtime stores.
  { relativePath: "chats", category: "threads" },
  { relativePath: "pi-compaction-sessions", category: "threads" },
  { relativePath: "pi-runtime-effects.json", category: "threads" },
  { relativePath: "subagent-runs", category: "threads" },
  { relativePath: "subagent-runs-v2", category: "threads" },
  { relativePath: "tool-output-spills.json", category: "threads" },
  { relativePath: "display-image-artifacts.json", category: "threads" },
  { relativePath: "generative-ui-artifacts.json", category: "threads" },
  { relativePath: "chat-pull-requests", category: "threads" },
  { relativePath: "chat-folders", category: "threads" },
  { relativePath: "follow-through", category: "threads" },
  { relativePath: "interrupted-waits.json", category: "threads" },
  { relativePath: "chat-triage.json", category: "threads" },
  { relativePath: "chat-read-markers.json", category: "threads" },
  { relativePath: "first-message-worktrees.json", category: "threads" },
  { relativePath: "bots", category: "threads" },
  { relativePath: "memory", category: "threads" },

  // Long-lived generated output.
  { relativePath: "workspace-artifacts", category: "artifacts" },
  { relativePath: "create-images", category: "artifacts" },
  { relativePath: "studio-assets", category: "artifacts" },
  { relativePath: "design-projects", category: "artifacts" },

  // App output the person can always regenerate or live without.
  { relativePath: "logs", category: "logs" },
  { relativePath: "Crashpad", category: "logs" },
  { relativePath: "terminal-history", category: "logs" },

  // Regenerable or binding state. Measured, never offered for deletion.
  { relativePath: "browser", category: "caches" },
  { relativePath: "background-jobs", category: "caches" },
  { relativePath: "devices", category: "caches" },
  { relativePath: "aiden-live", category: "caches" },
  { relativePath: "acp", category: "caches" },
  { relativePath: "pi-upgrade-rollout", category: "caches" },
  { relativePath: "provider-login-device-id", category: "caches" },
  { relativePath: "telegram-inbox", category: "caches" },
  { relativePath: "telegram-bot-outbox", category: "caches" },
  { relativePath: "bot-avatar-store", category: "caches" },

  // Downloaded runtimes and models.
  { relativePath: "voice-models", category: "downloads" },
  { relativePath: "parakeet-models", category: "downloads" },
  { relativePath: "form-fill-model", category: "downloads" },
  { relativePath: "bot-computers", category: "downloads" },
];

/** The profile files and directories a "clear logs" action may remove contents of. */
export const STORAGE_LOGS_PATHS: readonly string[] = [
  "logs",
  "Crashpad",
  "terminal-history",
];

export function storageProfilePaths(
  category: StorageCategoryId,
): readonly string[] {
  return STORAGE_PROFILE_LAYOUT.filter((entry) => entry.category === category).map(
    (entry) => entry.relativePath,
  );
}

/** Absolute paths for one category under `profileRoot`. */
export function storageCategoryPaths(
  profileRoot: string,
  category: StorageCategoryId,
): string[] {
  return storageProfilePaths(category).map((relativePath) => path.join(profileRoot, relativePath));
}

/**
 * Everything under the profile root is inside it by construction (the relative
 * paths above are literals), so this only guards a cleanup target that somehow
 * escaped. Kept small and explicit because it gates deletion.
 */
export function resolveProfilePath(profileRoot: string, relativePath: string): string {
  const resolvedRoot = path.resolve(profileRoot);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Aiden refused to touch a path outside its own storage.");
  }
  return resolved;
}
