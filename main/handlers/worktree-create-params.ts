import {
  MAX_WORKSPACE_ID_BYTES,
  MAX_WORKSPACE_ID_CHARS,
} from "../../renderer/shared/chat-message-contract.js";

export const MAX_WORKTREE_BRANCH_CHARS = 100;
export const MAX_WORKTREE_BRANCH_BYTES = 400;

function boundedString(
  value: unknown,
  label: string,
  maxChars: number,
  maxBytes: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

export function parseWorktreeCreateParams(
  workspaceIdValue: unknown,
  branchValue: unknown,
): { workspaceId: string; branch: string } {
  const workspaceId = boundedString(
    workspaceIdValue,
    "workspace identifier",
    MAX_WORKSPACE_ID_CHARS,
    MAX_WORKSPACE_ID_BYTES,
  );
  const rawBranch = boundedString(
    branchValue,
    "worktree branch",
    MAX_WORKTREE_BRANCH_CHARS,
    MAX_WORKTREE_BRANCH_BYTES,
  );
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
