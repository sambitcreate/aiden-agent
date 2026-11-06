import path from "node:path";
import { logger } from "../platform.js";
import { configStore } from "./config-store.js";
import { ensureUserDataDir } from "./data-store.js";
import {
  createFileFirstMessageWorktreeLedger,
  createFirstMessageWorktreeCoordinator,
} from "./first-message-worktree.js";
import { workspaceWorktreeApplicationService } from "./workspace-worktree-application-service-main.js";

/**
 * The app's one first-message worktree coordinator, shared by desktop drafts
 * (`chats:createWithFirstMessage`) and phones (`POST /chats/{id}/worktree`),
 * so both use one ledger and one per-key queue.
 */
export const firstMessageWorktrees = createFirstMessageWorktreeCoordinator({
  ledger: createFileFirstMessageWorktreeLedger({
    filePath: async () => path.join(await ensureUserDataDir(), "first-message-worktrees.json"),
    logError: (message, error) => logger.error("git", message, error),
  }),
  createFromBase: (owner, sourceWorkspaceId, request) =>
    workspaceWorktreeApplicationService.createFromBase(owner, sourceWorkspaceId, request),
  discardInterruptedWorktree: (owner, sourceWorkspaceId, attempt) =>
    workspaceWorktreeApplicationService.discardInterruptedWorktree(owner, sourceWorkspaceId, attempt),
  getWorkspace: (workspaceId) => configStore.getWorkspace(workspaceId),
  logError: (message, error) => logger.error("git", message, error),
});
