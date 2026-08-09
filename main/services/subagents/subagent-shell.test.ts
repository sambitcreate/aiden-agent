import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { isSubagentShellApprovalDetails } from "../../../renderer/shared/assistant.js";
import type { Workspace } from "../types.js";
import { WorkspaceOperationRegistry } from "../workspace-operation-registry.js";
import { SubagentApprovalLedgerV2 } from "./approval-v2.js";
import { createSubagentAuthorityV2, type SubagentAuthorityV2 } from "./authority-v2.js";
import {
  createSubagentShellBrokerV2,
  createSubagentShellTool,
  type SubagentShellBrokerV2Input,
} from "./subagent-shell.js";
import { subagentWorkspaceRevisionV2 } from "./subagent-workspace-write.js";

async function fixture(t: test.TestContext): Promise<Workspace> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-shell-broker-"));
  const folderPath = await realpath(temporary);
  t.after(() => rm(folderPath, { recursive: true, force: true }));
  return {
    id: "workspace-shell",
    name: "Shell Workspace",
    folderPath,
    permission: "ask",
    createdAt: 1,
    updatedAt: 2,
  };
}

function authority(workspace: Workspace): SubagentAuthorityV2 {
  return createSubagentAuthorityV2({
    grantId: "grant-shell",
    treeRootId: "tree-shell",
    runId: "run-shell",
    depth: 1,
    authorityRevision: 1,
    generationId: "generation-shell",
    chatId: "chat-shell",
    workspaceId: workspace.id,
    workspaceRevision: subagentWorkspaceRevisionV2(workspace),
    ownerDocumentId: "document-shell",
    providerFingerprint: "provider-shell",
    modelFingerprint: "model-shell",
    contextRevision: "context-shell",
    execution: "foreground",
    context: "fresh",
    thinkingLevel: "medium",
    capabilities: {
      workspaceRead: true,
      workspaceWrite: false,
      shell: true,
      web: false,
      delegation: false,
      mcp: [],
    },
    budgets: {
      deadlineMs: 60_000,
      maxTurns: 4,
      maxToolCalls: 4,
      maxOutputChars: 40_000,
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

function call(command: string, id = "call-shell"): BeforeToolCallContext {
  return {
    toolCall: { type: "toolCall", id, name: "run_command", arguments: { command } },
    args: { command },
  } as unknown as BeforeToolCallContext;
}

function harness(
  workspace: Workspace,
  options: {
    allow?: boolean;
    outcome?: "exited" | "cleanup_unconfirmed";
    longOutput?: boolean;
    waitForAbort?: boolean;
  } = {},
) {
  const granted = authority(workspace);
  const transitions: string[] = [];
  const prompts: unknown[] = [];
  let rawCalls = 0;
  let current: SubagentAuthorityV2 | undefined = granted;
  const input: SubagentShellBrokerV2Input = {
    authority: granted,
    childId: "child-shell",
    childLabel: "Host command",
    workspace,
    workspaceRoot: workspace.folderPath!,
    ledger: new SubagentApprovalLedgerV2(
      () => 1_000,
      () => "approval-shell",
    ),
    journal: {
      prepareEffect: async () => transitions.push("prepared"),
      authorizeEffect: async () => transitions.push("authorized"),
      markEffectDispatchStarted: async () => transitions.push("dispatch_started"),
      cancelEffectBeforeDispatch: async () => transitions.push("cancelled_before_dispatch"),
      finishEffect: async ({ state }) => transitions.push(state),
    },
    currentAuthority: () => current,
    currentWorkspace: async () => workspace,
    validateWorkspace: async () => {},
    requestApproval: async (prompt) => {
      prompts.push(prompt.details);
      return options.allow !== false;
    },
    runShell: async ({ command, workspaceRoot, signal }) => {
      rawCalls += 1;
      assert.equal(command, "printf 'one'\nprintf 'two'");
      assert.equal(workspaceRoot.path, workspace.folderPath);
      if (options.waitForAbort) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          outcome: "cancelled",
          cleanupConfirmed: true,
          stdout: "",
          stderr: "",
        };
      }
      return options.outcome === "cleanup_unconfirmed"
        ? {
            outcome: "cleanup_unconfirmed",
            cleanupConfirmed: false,
            stdout: "partial",
            stderr: "",
          }
        : {
            outcome: "exited",
            exitCode: 0,
            cleanupConfirmed: true,
            stdout: options.longOutput ? `HEAD${"x".repeat(30_000)}TAIL` : "one two",
            stderr: "warning",
          };
    },
    registry: new WorkspaceOperationRegistry(),
    now: () => 1_000,
    randomUUID: () => "shell-effect",
  };
  return {
    gate: createSubagentShellBrokerV2(input),
    transitions,
    prompts,
    rawCalls: () => rawCalls,
    revoke: () => {
      current = undefined;
    },
  };
}

test("shell tool is exact and inert until the main-owned broker wraps it", () => {
  const created = createSubagentShellTool();
  assert.equal(created.tool.name, "run_command");
  assert.deepEqual(created.binding, { toolName: "run_command" });
  assert.match(created.tool.description, /full macOS-user host authority/u);
});

test("exact multiline approval is durable before one helper dispatch", async (t) => {
  const workspace = await fixture(t);
  const run = harness(workspace);
  const command = "printf 'one'\nprintf 'two'";
  assert.equal(await run.gate.beforeToolCall(call(command)), undefined);
  assert.equal(run.rawCalls(), 0);
  assert.equal(isSubagentShellApprovalDetails(run.prompts[0]), true);
  const result = await run.gate.execute({
    toolCallId: "call-shell",
    toolName: "run_command",
    arguments: { command },
  });
  assert.equal(run.rawCalls(), 1);
  assert.match(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    /Untrusted stdout/u,
  );
  assert.deepEqual(run.transitions, ["prepared", "authorized", "dispatch_started", "completed"]);
});

test("denial, hostile controls, authority drift, and replay never spawn", async (t) => {
  const workspace = await fixture(t);
  const denied = harness(workspace, { allow: false });
  assert.deepEqual(await denied.gate.beforeToolCall(call("printf 'one'\nprintf 'two'")), {
    block: true,
    reason: "The user denied this shell call.",
  });
  assert.equal(denied.rawCalls(), 0);
  for (const command of ["", "echo\0bad", "echo\rbad", "echo\u001bbad", "echo\u202ebad"]) {
    const hostile = harness(workspace);
    assert.equal((await hostile.gate.beforeToolCall(call(command)))?.block, true);
    assert.equal(hostile.rawCalls(), 0);
  }
  const drift = harness(workspace);
  assert.equal(await drift.gate.beforeToolCall(call("printf 'one'\nprintf 'two'")), undefined);
  drift.revoke();
  await assert.rejects(
    drift.gate.execute({
      toolCallId: "call-shell",
      toolName: "run_command",
      arguments: { command: "printf 'one'\nprintf 'two'" },
    }),
  );
  assert.equal(drift.rawCalls(), 0);
});

test("cleanup-unconfirmed is durable unknown and never retries", async (t) => {
  const workspace = await fixture(t);
  const run = harness(workspace, { outcome: "cleanup_unconfirmed" });
  const command = "printf 'one'\nprintf 'two'";
  await run.gate.beforeToolCall(call(command));
  const result = await run.gate.execute({
    toolCallId: "call-shell",
    toolName: "run_command",
    arguments: { command },
  });
  assert.match(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    /Cleanup confirmed: no/u,
  );
  assert.equal(run.rawCalls(), 1);
  assert.equal(run.transitions[run.transitions.length - 1], "unknown");
  await assert.rejects(
    run.gate.execute({
      toolCallId: "call-shell",
      toolName: "run_command",
      arguments: { command },
    }),
    /no live one-shot/u,
  );
  assert.equal(run.rawCalls(), 1);
});

test("workspace drift blocks dispatch and bounded output preserves head and tail", async (t) => {
  const workspace = await fixture(t);
  const drift = harness(workspace);
  const command = "printf 'one'\nprintf 'two'";
  await drift.gate.beforeToolCall(call(command));
  workspace.updatedAt += 1;
  await assert.rejects(
    drift.gate.execute({
      toolCallId: "call-shell",
      toolName: "run_command",
      arguments: { command },
    }),
  );
  assert.equal(drift.rawCalls(), 0);

  const stableWorkspace = await fixture(t);
  const bounded = harness(stableWorkspace, { longOutput: true });
  await bounded.gate.beforeToolCall(call(command));
  const result = await bounded.gate.execute({
    toolCallId: "call-shell",
    toolName: "run_command",
    arguments: { command },
  });
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.ok(text.length <= 20_000);
  assert.match(text, /HEAD/u);
  assert.match(text, /TAIL/u);
  assert.match(text, /output truncated/u);
});

test("in-flight cancellation stops the helper path and throws the original abort", async (t) => {
  const workspace = await fixture(t);
  const run = harness(workspace, { waitForAbort: true });
  const command = "printf 'one'\nprintf 'two'";
  await run.gate.beforeToolCall(call(command));
  const controller = new AbortController();
  const reason = new Error("original caller abort");
  const pending = run.gate.execute({
    toolCallId: "call-shell",
    toolName: "run_command",
    arguments: { command },
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(reason), 5);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(run.rawCalls(), 1);
  assert.equal(run.transitions[run.transitions.length - 1], "remote_error");
});
