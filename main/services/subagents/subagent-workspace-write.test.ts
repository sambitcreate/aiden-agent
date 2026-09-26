import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import Ajv from "ajv";
import {
  SUBAGENT_WORKSPACE_WRITE_CHILD_LABEL_LIMIT,
  SUBAGENT_WORKSPACE_WRITE_PATH_LIMIT,
  SUBAGENT_WORKSPACE_WRITE_WORKSPACE_LABEL_LIMIT,
  SUBAGENT_WORKSPACE_WRITE_WORKTREE_LABEL_LIMIT,
  type SubagentWorkspaceWriteApprovalDetails,
  isSubagentRunGrantApprovalDetails,
} from "../../../renderer/shared/assistant.js";
import type { Workspace } from "../types.js";
import { WorkspaceOperationRegistry } from "../workspace-operation-registry.js";
import { SubagentApprovalLedgerV2, SubagentRunGrantV2 } from "./approval-v2.js";
import { createSubagentAuthorityV2, type SubagentAuthorityV2 } from "./authority-v2.js";
import {
  createSubagentWorkspaceWriteApprovalBrokerV2,
  createSubagentWorkspaceWriteTools,
  subagentWorkspaceRevisionV2,
  type SubagentWorkspaceWriteApprovalBrokerV2Input,
} from "./subagent-workspace-write.js";

async function testWorkspace(t: test.TestContext): Promise<Workspace> {
  const folderPath = await mkdtemp(path.join(os.tmpdir(), "aiden-subagent-write-"));
  t.after(() => rm(folderPath, { recursive: true, force: true }));
  return {
    id: "workspace-write",
    name: "Workspace Write",
    folderPath,
    permission: "ask",
    createdAt: 1,
    updatedAt: 2,
  };
}

function authority(workspace: Workspace): SubagentAuthorityV2 {
  return createSubagentAuthorityV2({
    grantId: "grant-write",
    treeRootId: "tree-write",
    runId: "run-write",
    depth: 1,
    authorityRevision: 1,
    generationId: "generation-write",
    chatId: "chat-write",
    workspaceId: workspace.id,
    workspaceRevision: subagentWorkspaceRevisionV2(workspace),
    ownerDocumentId: "document-write",
    providerFingerprint: "provider-write",
    modelFingerprint: "model-write",
    contextRevision: "context-write",
    execution: "foreground",
    context: "fresh",
    thinkingLevel: "medium",
    capabilities: {
      workspaceRead: true,
      workspaceWrite: true,
      shell: false,
      web: false,
      delegation: false,
      mcp: [],
    },
    budgets: {
      deadlineMs: 60_000,
      maxTurns: 4,
      maxToolCalls: 4,
      maxOutputChars: 4_000,
      maxTokens: 4_000,
      maxLaunches: 1,
      maxDepth: 1,
      maxActive: 1,
      maxQueued: 1,
      maxNetworkOperations: 1,
    },
    expiresAt: 61_000,
  });
}

function call(
  toolName: "write_file" | "edit_file",
  args: unknown,
  id = "call-write",
): BeforeToolCallContext {
  return {
    toolCall: { type: "toolCall", id, name: toolName, arguments: args },
    args,
  } as unknown as BeforeToolCallContext;
}

function brokerInput(
  workspace: Workspace,
  overrides: Partial<SubagentWorkspaceWriteApprovalBrokerV2Input> = {},
): SubagentWorkspaceWriteApprovalBrokerV2Input {
  const granted = authority(workspace);
  return {
    authority: granted,
    childId: "child-write",
    childLabel: "Edit one file",
    workspace,
    workspaceRoot: workspace.folderPath!,
    bindings: [
      { toolName: "write_file", operation: "write" },
      { toolName: "edit_file", operation: "edit" },
    ],
    ledger: new SubagentApprovalLedgerV2(() => 1_000),
    currentAuthority: () => granted,
    currentWorkspace: async () => workspace,
    validateWorkspace: async () => {},
    requestApproval: async () => true,
    registry: new WorkspaceOperationRegistry(),
    now: () => 1_000,
    ...overrides,
  };
}

test("run grant singleflights concurrent calls and cannot revive after revoke", async (t) => {
  const workspace = await testWorkspace(t);
  const granted = authority(workspace);
  let settle!: (allowed: boolean) => void;
  let requests = 0;
  const grant = new SubagentRunGrantV2(granted, "ask", undefined, () => 1_000);
  const request = () => {
    requests += 1;
    return new Promise<boolean>((resolve) => { settle = resolve; });
  };
  const first = grant.ensure(granted, "ask", request);
  const second = grant.ensure(granted, "ask", request);
  await Promise.resolve();
  assert.equal(requests, 1);
  grant.revoke();
  settle(true);
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(grant.valid(granted, "ask"), false);
  assert.equal(await grant.ensure(granted, "ask", request), false);
  assert.equal(requests, 1);

  let clock = 1_000;
  let expiryRequests = 0;
  const expiring = new SubagentRunGrantV2(granted, "ask", undefined, () => clock);
  const approve = async () => { expiryRequests += 1; return true; };
  assert.equal(await expiring.ensure(granted, "ask", approve), true);
  clock = granted.expiresAt;
  assert.equal(await expiring.ensure(granted, "ask", approve), false);
  assert.equal(expiryRequests, 1);
});

test("attended write binds structured preview and commits exactly once", async (t) => {
  if (process.platform !== "darwin") return;
  const workspace = await testWorkspace(t);
  let details: SubagentWorkspaceWriteApprovalDetails | undefined;
  const broker = createSubagentWorkspaceWriteApprovalBrokerV2(
    brokerInput(workspace, {
      requestApproval: async (prompt) => {
        details = prompt.details as SubagentWorkspaceWriteApprovalDetails;
        return true;
      },
    }),
  );
  const args = { path: "notes.txt", content: "alpha\u2028beta\u2029gamma\n" };
  assert.equal(await broker.beforeToolCall(call("write_file", args)), undefined);
  assert.equal(details?.kind, "subagent-workspace-write");
  assert.equal(details?.operation, "create");
  assert.equal(details?.commandWillRun, false);
  assert.equal(details?.refuseIfChanged, true);
  assert.match(details?.diffPreview ?? "", /\\u\{2028\}/u);
  assert.match(details?.diffPreview ?? "", /\\u\{2029\}/u);

  const result = await broker.execute({
    toolCallId: "call-write",
    toolName: "write_file",
    arguments: args,
  });
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /committed/u);
  assert.equal(await readFile(path.join(workspace.folderPath!, "notes.txt"), "utf8"), args.content);
  await assert.rejects(
    broker.execute({
      toolCallId: "call-write",
      toolName: "write_file",
      arguments: args,
    }),
    /one-shot approval/u,
  );
  await broker.shutdown();
});

test("implementer Ask grants writes once across independent file mutations and refuses workspace drift", async (t) => {
  if (process.platform !== "darwin") return;
  const workspace = await testWorkspace(t);
  let prompts = 0;
  const broker = createSubagentWorkspaceWriteApprovalBrokerV2(brokerInput(workspace, {
    implementerRunGrant: true,
    parentPermission: "ask",
    requestApproval: async (prompt) => {
      prompts += 1;
      assert.equal(isSubagentRunGrantApprovalDetails(prompt.details), true);
      assert.equal((prompt.details as { lane: string }).lane, "write");
      return true;
    },
  }));
  for (const [index, name] of ["first.txt", "second.txt"].entries()) {
    const id = `call-write-${index}`;
    const args = { path: name, content: `value ${index}\n` };
    assert.equal(await broker.beforeToolCall(call("write_file", args, id)), undefined);
    await broker.execute({ toolCallId: id, toolName: "write_file", arguments: args });
    assert.equal(await readFile(path.join(workspace.folderPath!, name), "utf8"), args.content);
  }
  assert.equal(prompts, 1);
  workspace.updatedAt += 1;
  assert.equal((await broker.beforeToolCall(call("write_file", {
    path: "third.txt", content: "blocked\n",
  }, "call-write-third")))?.block, true);
  assert.equal(prompts, 1);
  await broker.shutdown();
});

test("implementer Full makes multiple edits without approval cards", async (t) => {
  if (process.platform !== "darwin") return;
  const workspace = await testWorkspace(t);
  workspace.permission = "full";
  await writeFile(path.join(workspace.folderPath!, "notes.txt"), "one\n");
  const broker = createSubagentWorkspaceWriteApprovalBrokerV2(brokerInput(workspace, {
    implementerRunGrant: true,
    parentPermission: "full",
    requestApproval: async () => { throw new Error("Full must not request approval"); },
  }));
  for (const [index, oldString, newString] of [
    [0, "one", "two"], [1, "two", "three"],
  ] as const) {
    const id = `call-edit-${index}`;
    const args = { path: "notes.txt", old_string: oldString, new_string: newString };
    assert.equal(await broker.beforeToolCall(call("edit_file", args, id)), undefined);
    await broker.execute({ toolCallId: id, toolName: "edit_file", arguments: args });
  }
  assert.equal(await readFile(path.join(workspace.folderPath!, "notes.txt"), "utf8"), "three\n");
  await broker.shutdown();
});

test("stored Full workspace still asks when the parent turn is Ask", async (t) => {
  if (process.platform !== "darwin") return;
  const workspace = await testWorkspace(t);
  workspace.permission = "full";
  let prompts = 0;
  const broker = createSubagentWorkspaceWriteApprovalBrokerV2(brokerInput(workspace, {
    implementerRunGrant: true,
    parentPermission: "ask",
    requestApproval: async () => { prompts += 1; return true; },
  }));
  const args = { path: "narrowed.txt", content: "authorized\n" };
  assert.equal(await broker.beforeToolCall(call("write_file", args)), undefined);
  await broker.execute({ toolCallId: "call-write", toolName: "write_file", arguments: args });
  assert.equal(prompts, 1);
  await broker.shutdown();
});

test("approval is bound to original arguments and a conflict preserves the external file", async (t) => {
  if (process.platform !== "darwin") return;
  const workspace = await testWorkspace(t);
  const target = path.join(workspace.folderPath!, "bounded.txt");
  await writeFile(target, "before\n");
  const broker = createSubagentWorkspaceWriteApprovalBrokerV2(brokerInput(workspace));
  const args = { path: "bounded.txt", old_string: "before", new_string: "after" };
  assert.equal(await broker.beforeToolCall(call("edit_file", args)), undefined);
  await assert.rejects(
    broker.execute({
      toolCallId: "call-write",
      toolName: "edit_file",
      arguments: { ...args, new_string: "different" },
    }),
    /changed and was preserved/u,
  );
  assert.equal(await readFile(target, "utf8"), "before\n");
  await broker.shutdown();
});

test("wrong execute tool name consumes approval and settles helper, ledger, and admission", async (t) => {
  if (process.platform !== "darwin") return;
  const workspace = await testWorkspace(t);
  const ledger = new SubagentApprovalLedgerV2(() => 1_000);
  const registry = new WorkspaceOperationRegistry();
  const broker = createSubagentWorkspaceWriteApprovalBrokerV2(
    brokerInput(workspace, { ledger, registry }),
  );
  const args = { path: "mismatch.txt", content: "approved\n" };
  assert.equal(await broker.beforeToolCall(call("write_file", args)), undefined);
  assert.equal(ledger.pendingCount, 1);
  await assert.rejects(
    broker.execute({
      toolCallId: "call-write",
      toolName: "edit_file",
      arguments: {
        path: "mismatch.txt",
        old_string: "approved",
        new_string: "changed",
      },
    }),
    /changed and was preserved/u,
  );
  assert.equal(ledger.pendingCount, 0);
  await registry.cancelAndSettle(workspace.id, { timeoutMs: 100 });
  await assert.rejects(readFile(path.join(workspace.folderPath!, "mismatch.txt"), "utf8"));
});

test("model schema and broker reject paths longer than the approval UI can show", async (t) => {
  if (process.platform !== "darwin") return;
  const workspace = await testWorkspace(t);
  const tooLongPath = `${"a".repeat(250)}/${"b".repeat(250)}/${"c".repeat(20)}`;
  assert.ok(tooLongPath.length > SUBAGENT_WORKSPACE_WRITE_PATH_LIMIT);
  const writeTool = createSubagentWorkspaceWriteTools().tools.find(
    ({ name }) => name === "write_file",
  );
  assert.ok(writeTool);
  const validate = new Ajv().compile(writeTool.parameters as object);
  assert.equal(validate({ path: tooLongPath, content: "value\n" }), false);
  let approvals = 0;
  const broker = createSubagentWorkspaceWriteApprovalBrokerV2(
    brokerInput(workspace, {
      requestApproval: async () => {
        approvals += 1;
        return true;
      },
    }),
  );
  const result = await broker.beforeToolCall(
    call("write_file", { path: tooLongPath, content: "value\n" }),
  );
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /invalid/u);
  assert.equal(approvals, 0);
  await broker.shutdown();
});

test("approval details safely escape and bound host-owned labels", async (t) => {
  if (process.platform !== "darwin") return;
  const base = await testWorkspace(t);
  const workspace: Workspace = {
    ...base,
    name: ` \u202e${"Workspace".repeat(30)} `,
    managedWorktree: {
      repositoryPath: base.folderPath!,
      worktreePath: base.folderPath!,
      branch: ` \u2066${"branch".repeat(40)} `,
      createdFromHead: "a".repeat(40),
    },
  };
  let details: SubagentWorkspaceWriteApprovalDetails | undefined;
  const broker = createSubagentWorkspaceWriteApprovalBrokerV2(
    brokerInput(workspace, {
      childLabel: " \u202eChild label ",
      requestApproval: async (prompt) => {
        details = prompt.details as SubagentWorkspaceWriteApprovalDetails;
        return false;
      },
    }),
  );
  const result = await broker.beforeToolCall(
    call("write_file", { path: "safe.txt", content: "value\n" }),
  );
  assert.equal(result?.block, true);
  assert.ok(details);
  assert.ok(details.childLabel.length <= SUBAGENT_WORKSPACE_WRITE_CHILD_LABEL_LIMIT);
  assert.ok(details.workspaceLabel.length <= SUBAGENT_WORKSPACE_WRITE_WORKSPACE_LABEL_LIMIT);
  assert.ok((details.worktreeLabel?.length ?? 0) <= SUBAGENT_WORKSPACE_WRITE_WORKTREE_LABEL_LIMIT);
  assert.match(details.childLabel, /\\u\{0020\}\\u\{202e\}/u);
  assert.match(details.workspaceLabel, /\\u\{0020\}\\u\{202e\}/u);
  assert.match(details.worktreeLabel ?? "", /\\u\{0020\}\\u\{2066\}/u);
  assert.equal(details.path, "safe.txt");
  await broker.shutdown();
});

test("concurrent duplicate preparation is blocked while the first approval is pending", async (t) => {
  if (process.platform !== "darwin") return;
  const workspace = await testWorkspace(t);
  let resolveApproval = (_allowed: boolean): void => {};
  const approval = new Promise<boolean>((resolve) => {
    resolveApproval = resolve;
  });
  let approvalStarted = (): void => {};
  const started = new Promise<void>((resolve) => {
    approvalStarted = resolve;
  });
  const broker = createSubagentWorkspaceWriteApprovalBrokerV2(
    brokerInput(workspace, {
      requestApproval: async () => {
        approvalStarted();
        return approval;
      },
    }),
  );
  const request = call("write_file", { path: "duplicate.txt", content: "one\n" });
  const first = broker.beforeToolCall(request);
  await started;
  const duplicate = await broker.beforeToolCall(request);
  assert.equal(duplicate?.block, true);
  assert.match(duplicate?.reason ?? "", /already prepared/u);
  resolveApproval(false);
  assert.equal((await first)?.block, true);
  await broker.shutdown();
});

test("workspace cancellation aborts a pending approval and drains its registry admission", async (t) => {
  if (process.platform !== "darwin") return;
  const workspace = await testWorkspace(t);
  const registry = new WorkspaceOperationRegistry();
  let approvalStarted = (): void => {};
  const started = new Promise<void>((resolve) => {
    approvalStarted = resolve;
  });
  const broker = createSubagentWorkspaceWriteApprovalBrokerV2(
    brokerInput(workspace, {
      registry,
      requestApproval: async (_prompt, signal) => {
        approvalStarted();
        if (signal?.aborted) return false;
        return new Promise<boolean>((resolve) =>
          signal?.addEventListener("abort", () => resolve(false), { once: true }),
        );
      },
    }),
  );
  const pending = broker.beforeToolCall(
    call("write_file", { path: "cancelled.txt", content: "never\n" }),
  );
  await started;
  await registry.cancelAndSettle(workspace.id, { timeoutMs: 2_000 });
  const result = await pending;
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /cancelled/u);
  await assert.rejects(readFile(path.join(workspace.folderPath!, "cancelled.txt"), "utf8"));
  await broker.shutdown();
});

test("live workspace revision is revalidated after approval and before commit", async (t) => {
  if (process.platform !== "darwin") return;
  const workspace = await testWorkspace(t);
  let current = workspace;
  const broker = createSubagentWorkspaceWriteApprovalBrokerV2(
    brokerInput(workspace, {
      currentWorkspace: async () => current,
    }),
  );
  const args = { path: "revision.txt", content: "approved\n" };
  assert.equal(await broker.beforeToolCall(call("write_file", args)), undefined);
  current = { ...workspace, updatedAt: workspace.updatedAt + 1 };
  await assert.rejects(
    broker.execute({
      toolCallId: "call-write",
      toolName: "write_file",
      arguments: args,
    }),
    /changed and was preserved/u,
  );
  await assert.rejects(readFile(path.join(workspace.folderPath!, "revision.txt"), "utf8"));
  await broker.shutdown();
});
