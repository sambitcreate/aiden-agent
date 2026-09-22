import assert from "node:assert/strict";
import test from "node:test";
import {
  isAssistantAutomationApprovalDetails,
  isScheduledTaskApprovalDetails,
  isSubagentMcpMutationApprovalDetails,
  isSubagentWorkspaceWriteApprovalDetails,
  type AssistantAutomationApprovalDetails,
  type ScheduledTaskApprovalDetails,
  type SubagentMcpMutationApprovalDetails,
  type SubagentWorkspaceWriteApprovalDetails,
} from "./assistant.js";

const mcpMutation: SubagentMcpMutationApprovalDetails = {
  kind: "subagent-mcp-mutation",
  childLabel: "Publisher",
  serverId: "docs",
  toolName: "publish",
  connectionDigestPrefix: "aaaaaaaaaaaa",
  schemaDigestPrefix: "bbbbbbbbbbbb",
  profileDigestPrefix: "cccccccccccc",
  argumentDigestPrefix: "dddddddddddd",
  classification: "declared_mutating",
  destructive: "destructive",
  idempotency: "not_declared",
  openWorld: "open",
  taskSupport: "optional",
  timeoutMs: 30_000,
  canonicalArguments: '{"title":"Safe\\u202e title","value":1}',
  priorUnknownEffect: false,
  automaticRetry: false,
  rollbackAvailable: false,
};

const base: AssistantAutomationApprovalDetails = {
  kind: "assistant-automation",
  action: "create",
  name: "Daily report",
  prompt: "Update the report.",
  cron: "0 9 * * *",
  timezone: "UTC",
  nextRunAt: 1_800_000_000_000,
  notify: true,
  mode: "llm",
  permission: "read-only",
  workspaceId: null,
  workspaceName: null,
  mcpServerIds: [],
  mcpServerNames: [],
  providerId: "local-provider",
  providerName: "Local Provider",
  model: "local-model",
  modelName: "Local Model",
  schedulerEnabled: true,
};

const workspaceWrite: SubagentWorkspaceWriteApprovalDetails = {
  kind: "subagent-workspace-write",
  operation: "edit",
  childLabel: "Correct the parser",
  path: "renderer/shared/assistant.ts",
  workspaceLabel: "Aiden",
  worktreeLabel: null,
  isManagedWorktree: false,
  preDigestPrefix: "0123456789ab",
  postDigestPrefix: "abcdef012345",
  beforeBytes: 1_024,
  afterBytes: 1_080,
  diffPreview: "- old\n+ new",
  diffTruncated: false,
  commandWillRun: false,
  refuseIfChanged: true,
};

const scheduledTaskApproval: ScheduledTaskApprovalDetails = {
  kind: "scheduled-task",
  action: "create",
  taskId: null,
  expectedUpdatedAt: null,
  enabled: true,
  name: "Inbox monitor",
  prompt: "Summarize inbox changes.",
  script: null,
  cron: "0 9 * * *",
  timezone: "UTC",
  nextRunAt: 1_800_000_000_000,
  notify: true,
  mode: "llm",
  permission: "full",
  workspaceId: null,
  workspaceName: null,
  mcpServerIds: ["gmail"],
  mcpServerNames: ["Gmail"],
  providerId: "local-provider",
  providerName: "Local Provider",
  model: "local-model",
  modelName: "Local Model",
  legacyGlobalMcp: false,
  schedulerEnabled: true,
};

test("standard schedule approval details bind exact action, content, and scope", () => {
  assert.equal(isScheduledTaskApprovalDetails(scheduledTaskApproval), true);
  assert.equal(
    isScheduledTaskApprovalDetails({ ...scheduledTaskApproval, action: "update" }),
    false,
  );
  assert.equal(
    isScheduledTaskApprovalDetails({
      ...scheduledTaskApproval,
      action: "update",
      taskId: "task-1",
      expectedUpdatedAt: 4,
    }),
    true,
  );
  assert.equal(
    isScheduledTaskApprovalDetails({ ...scheduledTaskApproval, mcpServerNames: [] }),
    false,
  );
  assert.equal(
    isScheduledTaskApprovalDetails({ ...scheduledTaskApproval, prompt: "Unsafe\u2028line" }),
    false,
  );
});

test("Assistant automation details require a matching project identity for Full access", () => {
  assert.equal(isAssistantAutomationApprovalDetails(base), true);
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      permission: "full",
      workspaceId: "workspace-1",
      workspaceName: "Website",
    }),
    true,
  );
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      permission: "full",
      workspaceId: "workspace-1",
      workspaceName: "Website",
      mcpServerIds: ["gmail"],
      mcpServerNames: ["Gmail"],
    }),
    false,
  );
  assert.equal(isAssistantAutomationApprovalDetails({ ...base, permission: "full" }), false);
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      permission: "full",
      mcpServerIds: ["gmail"],
      mcpServerNames: ["Gmail"],
    }),
    true,
  );
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      mcpServerIds: ["gmail"],
      mcpServerNames: ["Gmail"],
    }),
    false,
  );
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      permission: "full",
      mcpServerIds: ["gmail"],
      mcpServerNames: [],
    }),
    false,
  );
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      workspaceId: "workspace-1",
      workspaceName: null,
    }),
    false,
  );
});

test("Assistant edit approvals require an exact task identity and enabled state", () => {
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      action: "edit",
      taskId: "task-1",
      enabled: true,
    }),
    true,
  );
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      action: "edit",
      enabled: true,
    }),
    false,
  );
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      action: "edit",
      taskId: "task-1",
    }),
    false,
  );
  assert.equal(isAssistantAutomationApprovalDetails({ ...base, taskId: "task-1" }), false);
});

test("subagent workspace-write details accept only exact bounded truthful fields", () => {
  assert.equal(isSubagentWorkspaceWriteApprovalDetails(workspaceWrite), true);
  assert.equal(
    isSubagentWorkspaceWriteApprovalDetails({
      ...workspaceWrite,
      diffPreview: "- old\n+ new\n",
    }),
    true,
  );
  assert.equal(
    isSubagentWorkspaceWriteApprovalDetails({
      ...workspaceWrite,
      isManagedWorktree: true,
      worktreeLabel: "feature/approval-ui",
    }),
    true,
  );
  for (const invalid of [
    { ...workspaceWrite, extra: true },
    { ...workspaceWrite, operation: "delete" },
    { ...workspaceWrite, childLabel: "Unsafe\nlabel" },
    { ...workspaceWrite, path: "/tmp/outside" },
    { ...workspaceWrite, path: "src/../outside" },
    { ...workspaceWrite, path: "src\\outside" },
    { ...workspaceWrite, path: "src//file.ts" },
    { ...workspaceWrite, worktreeLabel: "feature/x", isManagedWorktree: false },
    { ...workspaceWrite, worktreeLabel: null, isManagedWorktree: true },
    { ...workspaceWrite, preDigestPrefix: "ABCDEF012345" },
    { ...workspaceWrite, postDigestPrefix: "too-short" },
    { ...workspaceWrite, beforeBytes: -1 },
    { ...workspaceWrite, afterBytes: Number.MAX_SAFE_INTEGER },
    { ...workspaceWrite, diffPreview: "   \n" },
    { ...workspaceWrite, diffPreview: "+ unsafe\u202e" },
    { ...workspaceWrite, commandWillRun: true },
    { ...workspaceWrite, refuseIfChanged: false },
  ]) {
    assert.equal(isSubagentWorkspaceWriteApprovalDetails(invalid), false);
  }
});

test("subagent create approvals bind absence while edits bind a preimage", () => {
  assert.equal(
    isSubagentWorkspaceWriteApprovalDetails({
      ...workspaceWrite,
      operation: "create",
      preDigestPrefix: null,
      beforeBytes: 0,
    }),
    true,
  );
  assert.equal(
    isSubagentWorkspaceWriteApprovalDetails({
      ...workspaceWrite,
      operation: "create",
      preDigestPrefix: workspaceWrite.preDigestPrefix,
    }),
    false,
  );
  assert.equal(
    isSubagentWorkspaceWriteApprovalDetails({
      ...workspaceWrite,
      preDigestPrefix: null,
    }),
    false,
  );
});

test("workspace-write display fields reject bidi controls and Unicode line separators", () => {
  const unsafe = ["\u061c", "\u200e", "\u200f", "\u2028", "\u2029"];
  for (const character of unsafe) {
    for (const invalid of [
      { ...workspaceWrite, childLabel: `child${character}label` },
      { ...workspaceWrite, path: `src/${character}file.ts` },
      { ...workspaceWrite, workspaceLabel: `work${character}space` },
      {
        ...workspaceWrite,
        isManagedWorktree: true,
        worktreeLabel: `feature/${character}write`,
      },
      { ...workspaceWrite, diffPreview: `- old\n+ new${character}line` },
    ]) {
      assert.equal(isSubagentWorkspaceWriteApprovalDetails(invalid), false);
    }
  }
});

test("MCP mutation details require exact canonical safe arguments and literal safeguards", () => {
  assert.equal(isSubagentMcpMutationApprovalDetails(mcpMutation), true);
  for (const invalid of [
    { ...mcpMutation, extra: true },
    { ...mcpMutation, classification: "read" },
    { ...mcpMutation, connectionDigestPrefix: "short" },
    { ...mcpMutation, timeoutMs: 0 },
    { ...mcpMutation, automaticRetry: true },
    { ...mcpMutation, rollbackAvailable: true },
    { ...mcpMutation, canonicalArguments: '{"value":1,"title":"out of order"}' },
    { ...mcpMutation, canonicalArguments: '{"title":"raw\u202e","value":1}' },
    { ...mcpMutation, canonicalArguments: "[]" },
  ]) {
    assert.equal(isSubagentMcpMutationApprovalDetails(invalid), false);
  }
});
