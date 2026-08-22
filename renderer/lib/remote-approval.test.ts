import assert from "node:assert/strict";
import test from "node:test";
import { isLatestRemoteApprovalRefresh, mergeRemoteApproval } from "./remote-approval.js";

const remote = {
  approvalId: "approval-remote",
  streamId: "stream-1",
  chatId: "chat-1",
  summary: "Run this command?",
  toolCallId: "tool-1",
  toolName: "run_command",
  expiresAt: "2026-08-22T19:05:00.000Z",
  canAllow: true,
};

test("remote approval reconciliation preserves local prompts and replaces stale remote state", () => {
  const local = {
    approvalId: "approval-local",
    toolCallId: "tool-local",
    toolName: "write",
    summary: "Write this file?",
  };
  const staleRemote = { ...local, approvalId: "approval-old", source: "remote" as const };
  assert.deepEqual(
    mergeRemoteApproval([local, staleRemote], remote, Date.parse("2026-08-22T19:00:00.000Z")),
    [local, {
      approvalId: "approval-remote",
      toolCallId: "tool-1",
      toolName: "run_command",
      summary: "Run this command?",
      canAllow: true,
      source: "remote",
    }],
  );
  assert.deepEqual(
    mergeRemoteApproval([local, staleRemote], remote, Date.parse(remote.expiresAt)),
    [local],
  );
  assert.deepEqual(mergeRemoteApproval([local, staleRemote], null), [local]);
});

test("remote approval reconciliation preserves validated privileged details and deny-only state", () => {
  const details = {
    kind: "subagent-shell" as const,
    childLabel: "Checks",
    command: "npm test",
    initialCwd: "/Users/example/project",
    shell: "/bin/zsh -f -c" as const,
    argumentDigestPrefix: "a".repeat(12),
    rootDigestPrefix: "b".repeat(12),
    effectDigestPrefix: "c".repeat(12),
    timeoutMs: 120_000,
    stdoutLimitBytes: 512 * 1024,
    stderrLimitBytes: 512 * 1024,
    workspaceLabel: "Project",
    isManagedWorktree: false,
    worktreeLabel: null,
    environmentProfile: "minimal-private-0700-v1" as const,
    osSandboxed: false as const,
    rollbackAvailable: false as const,
    outputSentToModel: true as const,
    arbitraryNetworkAvailable: true as const,
    detachedProcessesMaySurvive: true as const,
  };
  assert.deepEqual(
    mergeRemoteApproval([], { ...remote, canAllow: false, details }, Date.parse("2026-08-22T19:00:00.000Z")),
    [{
      approvalId: remote.approvalId,
      toolCallId: remote.toolCallId,
      toolName: remote.toolName,
      summary: remote.summary,
      canAllow: false,
      details,
      source: "remote",
    }],
  );
});

test("only the newest remote approval refresh may mutate UI state", () => {
  assert.equal(isLatestRemoteApprovalRefresh(2, 2), true);
  assert.equal(isLatestRemoteApprovalRefresh(1, 2), false);
});
