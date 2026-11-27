import {
  MAX_WORKSPACE_ID_BYTES,
  MAX_WORKSPACE_ID_CHARS,
} from "../../renderer/shared/chat-message-contract.js";
import { parseUtf8BoundedString } from "../shared/guards.js";

export const MAX_WORKTREE_BRANCH_CHARS = 100;
export const MAX_WORKTREE_BRANCH_BYTES = 400;

export function parseWorktreeCreateParams(
  workspaceIdValue: unknown,
  branchValue: unknown,
): { workspaceId: string; branch: string } {
  const workspaceId = parseUtf8BoundedString(
    workspaceIdValue,
    "workspace identifier",
    MAX_WORKSPACE_ID_CHARS,
    MAX_WORKSPACE_ID_BYTES,
  ).value;
  const rawBranch = parseUtf8BoundedString(
    branchValue,
    "worktree branch",
    MAX_WORKTREE_BRANCH_CHARS,
    MAX_WORKTREE_BRANCH_BYTES,
  ).value;
  const branch = rawBranch.trim();
  if (
    !branch || branch !== rawBranch ||
    /[\s~^:?*\\\p{Cc}\p{Cf}]/u.test(branch) ||
    branch.includes("[") ||
    branch.includes("]") ||
    branch.startsWith("/") ||
    branch.startsWith(".") ||
    branch.startsWith("-") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{")
  ) {
    throw new Error("Invalid worktree branch.");
  }
  return { workspaceId, branch };
}
