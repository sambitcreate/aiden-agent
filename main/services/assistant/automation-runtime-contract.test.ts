import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { parseParams } from "../../handlers/chat-params.js";
import {
  assembleAgentTools,
  type AgentToolSources,
  type ToolContext,
} from "../agent-tool-assembly.js";
import { scheduledGenerationSurface } from "../conversation-surface-generation.js";
import {
  assertScheduledGenerationProvider,
  scheduledProviderFingerprint,
} from "../schedule-provider-binding.js";
import { scheduledGenerationToolPolicy } from "../scheduled-generation-policy.js";
import { ToolApprovalCoordinator, toolApprovalBlockReason } from "../tool-approval.js";
import type { ScheduledTask, StoredProvider } from "../types.js";

// The exact folder-scoped allowlist an approved project automation may use.
const PROJECT_AUTOMATION_TOOLS = [
  "edit_file",
  "glob",
  "grep",
  "list_dir",
  "read_file",
  "run_command",
  "write_file",
];
const READ_ONLY_PROJECT_TOOLS = ["glob", "grep", "list_dir", "read_file"];

const MODEL_SELECTION = {
  providerId: "local-provider",
  providerName: "Local",
  model: "model-1",
  modelName: "Model 1",
  providerFingerprint: "a".repeat(64),
};

function fakeTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `Fake ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: name }], details: null }),
  } as unknown as AgentTool;
}

/**
 * Ambient sources that would each contribute a tool if consulted. The calls
 * record which ones the assembly actually reached for.
 */
function ambientSources() {
  const calls = { mcp: [] as ToolContext[], webSearch: 0, skillsEnabled: 0, skillSnapshot: 0 };
  const sources: AgentToolSources = {
    configuredMcpTools: async (ctx) => {
      calls.mcp.push(ctx);
      return [fakeTool("mcp__gmail__send_email")];
    },
    webSearchToolForGeneration: async () => {
      calls.webSearch += 1;
      return fakeTool("web_search");
    },
    skillsEnabled: async () => {
      calls.skillsEnabled += 1;
      return true;
    },
    skillSnapshot: async () => {
      calls.skillSnapshot += 1;
      return undefined;
    },
  };
  return { sources, calls };
}

function names(tools: readonly AgentTool[]): string[] {
  return tools.map((tool) => tool.name).sort();
}

async function withProject<T>(run: (root: string, outside: string) => Promise<T>): Promise<T> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiden-automation-")));
  const root = path.join(base, "project");
  const outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  try {
    return await run(root, outside);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

/** Runs a real tool call and reports whether it was refused (thrown or error result). */
async function refusal(tool: AgentTool, args: Record<string, unknown>): Promise<string | undefined> {
  try {
    const result = (await tool.execute("call", args as never)) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    if (result.isError === true) {
      return result.content?.map((part) => part.text ?? "").join("\n") ?? "error";
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function scheduledTask(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "task-1",
    name: "Nightly check",
    enabled: true,
    mode: "llm",
    cron: "0 9 * * *",
    timezone: "UTC",
    prompt: "Check the project.",
    permission: "full",
    notify: true,
    ...overrides,
  } as ScheduledTask;
}

const WEB_SEARCH_READY = async () => ({ ready: true });

// --- Unattended project automation -------------------------------------------

test("a project automation is offered exactly the folder-scoped coding tools", async () => {
  await withProject(async (root) => {
    const { sources, calls } = ambientSources();
    const tools = await assembleAgentTools(
      {
        mode: "assistant-automation",
        workspaceId: "workspace-1",
        workspaceRoot: root,
        permission: "full",
        allowScheduling: false,
      },
      sources,
    );
    assert.deepEqual(names(tools), PROJECT_AUTOMATION_TOOLS);
    // Scheduling, project/MCP identity, web search, skills and connector
    // sources are never consulted, so none of their tools can appear.
    assert.deepEqual(calls, { mcp: [], webSearch: 0, skillsEnabled: 0, skillSnapshot: 0 });
  });
});

test("a project automation without an accessible folder is offered no tools", async () => {
  await withProject(async (root) => {
    const { sources } = ambientSources();
    assert.deepEqual(
      await assembleAgentTools({ mode: "assistant-automation", permission: "full" }, sources),
      [],
    );
    assert.deepEqual(
      await assembleAgentTools(
        { mode: "assistant-automation", workspaceRoot: root, permission: "none" },
        sources,
      ),
      [],
    );
  });
});

test("a project automation rejects any MCP connector scope", async () => {
  await withProject(async (root) => {
    const { sources, calls } = ambientSources();
    for (const scope of [{ allowMcpTools: true }, { mcpServerIds: ["gmail"] }]) {
      await assert.rejects(
        assembleAgentTools(
          { mode: "assistant-automation", workspaceRoot: root, permission: "full", ...scope },
          sources,
        ),
        /cannot use MCP connectors/u,
      );
    }
    assert.equal(calls.mcp.length, 0);
  });
});

test("a project automation's file tools refuse paths outside the approved project", async () => {
  await withProject(async (root, outside) => {
    await fs.writeFile(path.join(root, "notes.txt"), "inside\n");
    await fs.writeFile(path.join(outside, "secret.txt"), "outside\n");
    const { sources } = ambientSources();
    const tools = await assembleAgentTools(
      { mode: "assistant-automation", workspaceRoot: root, permission: "full" },
      sources,
    );
    const tool = (name: string) => {
      const found = tools.find((candidate) => candidate.name === name);
      assert.ok(found, `missing ${name}`);
      return found;
    };

    assert.equal(await refusal(tool("read_file"), { path: "notes.txt" }), undefined);
    for (const target of [path.join(outside, "secret.txt"), "../outside/secret.txt"]) {
      assert.match(
        (await refusal(tool("read_file"), { path: target })) ?? "",
        /outside the workspace folder/u,
      );
    }
    const escapedWrite = path.join(outside, "planted.txt");
    assert.match(
      (await refusal(tool("write_file"), { path: escapedWrite, content: "x" })) ?? "",
      /outside the workspace folder/u,
    );
    await assert.rejects(fs.stat(escapedWrite), { code: "ENOENT" });
  });
});

test("a read-only scheduled project automation is left with only non-mutating tools", async () => {
  await withProject(async (root) => {
    const task = scheduledTask({
      workspaceId: "workspace-1",
      executionProfile: "assistant",
      permission: "read-only",
      mcpServerIds: [],
    });
    const policy = await scheduledGenerationToolPolicy(task, WEB_SEARCH_READY);
    const { sources } = ambientSources();
    const offered = (
      await assembleAgentTools(
        {
          mode: "assistant-automation",
          workspaceRoot: root,
          // Main maps a read-only task to Full tool permission and withholds
          // the mutating tools through the policy's exclusions instead.
          permission: "full",
          allowMcpTools: policy.allowMcpTools,
          mcpServerIds: policy.mcpServerIds,
        },
        sources,
      )
    ).filter((tool) => !policy.excludeToolNames.has(tool.name));
    assert.deepEqual(names(offered), READ_ONLY_PROJECT_TOOLS);
  });
});

// --- Scheduled run policy ------------------------------------------------------

test("scheduled runs never re-offer scheduling and fail closed on web search", async () => {
  const granted = scheduledTask({ webSearchEnabled: true, mcpServerIds: [] });
  const ready = await scheduledGenerationToolPolicy(granted, WEB_SEARCH_READY);
  assert.equal(ready.excludeToolNames.has("schedule_task"), true);
  assert.equal(ready.excludeToolNames.has("web_search"), false);

  const notReady = await scheduledGenerationToolPolicy(granted, async () => ({ ready: false }));
  assert.equal(notReady.excludeToolNames.has("web_search"), true);

  const failing = await scheduledGenerationToolPolicy(granted, async () => {
    throw new Error("settings unreadable");
  });
  assert.equal(failing.excludeToolNames.has("web_search"), true);

  let availabilityReads = 0;
  const countReads = async () => {
    availabilityReads += 1;
    return { ready: true };
  };
  for (const task of [
    scheduledTask({ webSearchEnabled: false }),
    // Assistant-approved automations never carry a web search grant.
    scheduledTask({ webSearchEnabled: true, executionProfile: "assistant", mcpServerIds: [] }),
  ]) {
    const policy = await scheduledGenerationToolPolicy(task, countReads);
    assert.equal(policy.excludeToolNames.has("web_search"), true);
    assert.equal(policy.excludeToolNames.has("schedule_task"), true);
  }
  assert.equal(availabilityReads, 0);
});

test("scheduled MCP scope is exactly the approved servers and requires Full permission", async () => {
  const bindings = [{ id: "gmail", fingerprint: "b".repeat(64) }];
  const approved = await scheduledGenerationToolPolicy(
    scheduledTask({
      executionProfile: "assistant",
      mcpServerIds: ["gmail"],
      mcpServerBindings: bindings,
      providerFingerprint: MODEL_SELECTION.providerFingerprint,
    }),
    WEB_SEARCH_READY,
  );
  assert.equal(approved.allowMcpTools, true);
  assert.deepEqual(approved.mcpServerIds, ["gmail"]);
  assert.deepEqual(approved.mcpServerBindings, bindings);
  assert.equal(approved.providerFingerprint, MODEL_SELECTION.providerFingerprint);

  const readOnly = await scheduledGenerationToolPolicy(
    scheduledTask({ permission: "read-only", mcpServerIds: ["gmail"] }),
    WEB_SEARCH_READY,
  );
  assert.equal(readOnly.allowMcpTools, false);

  // An Assistant automation with no approved server reaches none, even at Full.
  const none = await scheduledGenerationToolPolicy(
    scheduledTask({ executionProfile: "assistant" }),
    WEB_SEARCH_READY,
  );
  assert.equal(none.allowMcpTools, false);
  assert.deepEqual(none.mcpServerIds, []);

  // Only legacy, non-Assistant Full tasks keep the historical all-servers scope.
  const legacy = await scheduledGenerationToolPolicy(scheduledTask({}), WEB_SEARCH_READY);
  assert.equal(legacy.allowMcpTools, true);
  assert.equal(legacy.mcpServerIds, undefined);
});

test("the scheduled generation surface disables Computer Use and subagents and carries the approval", async () => {
  const policy = await scheduledGenerationToolPolicy(
    scheduledTask({
      executionProfile: "assistant",
      mcpServerIds: ["gmail"],
      providerFingerprint: MODEL_SELECTION.providerFingerprint,
    }),
    WEB_SEARCH_READY,
  );
  const surface = scheduledGenerationSurface({
    chatId: "chat-1",
    streamId: "stream-1",
    ownerId: "scheduled:stream-1",
    providerId: "local-provider",
    model: "model-1",
    mode: "assistant-unattended",
    prompt: "Summarize inbox changes.",
    permission: "full",
    ...policy,
  });
  assert.equal(surface.options.allowComputerUse, false);
  assert.equal(surface.options.allowSubagents, false);
  assert.equal(surface.options.allowMcpTools, true);
  assert.deepEqual(surface.options.mcpServerIds, ["gmail"]);
  assert.equal(surface.options.providerFingerprint, MODEL_SELECTION.providerFingerprint);
  assert.equal(surface.options.excludeToolNames.has("schedule_task"), true);
});

test("unattended Assistant generations run only on the approved provider connection", () => {
  const provider = {
    id: "custom:provider",
    kind: "openai",
    label: "Local",
    baseUrl: "http://127.0.0.1:1234/v1",
    models: ["model-1"],
    needsKey: false,
    deployment: "local",
  } as StoredProvider;
  const approved = scheduledProviderFingerprint(provider);
  const replaced = { ...provider, baseUrl: "https://hosted.example/v1" } as StoredProvider;
  for (const mode of ["assistant-automation", "assistant-unattended"] as const) {
    assert.doesNotThrow(() => assertScheduledGenerationProvider(mode, provider, approved));
    assert.throws(
      () => assertScheduledGenerationProvider(mode, replaced, approved),
      /approved provider connection changed/u,
    );
    assert.throws(
      () => assertScheduledGenerationProvider(mode, provider, undefined),
      /approved provider connection changed/u,
    );
  }
  // Attended and ordinary chats are not bound to an approval fingerprint.
  for (const mode of ["assistant", undefined] as const) {
    assert.doesNotThrow(() => assertScheduledGenerationProvider(mode, replaced, undefined));
  }
});

// --- Attended and global Assistant ---------------------------------------------

test("attended Assistant sees project and MCP identities but never ambient tools", async () => {
  await withProject(async (root) => {
    const { sources, calls } = ambientSources();
    const tools = await assembleAgentTools(
      {
        mode: "assistant",
        workspaceId: "workspace-1",
        workspaceRoot: root,
        permission: "full",
        assistantModelSelection: MODEL_SELECTION,
      },
      sources,
    );
    assert.deepEqual(names(tools), [
      "edit_automation",
      "list_mcp_servers",
      "list_projects",
      "list_scheduled_tasks",
      "schedule_task",
    ]);
    assert.deepEqual(calls, { mcp: [], webSearch: 0, skillsEnabled: 0, skillSnapshot: 0 });
  });
});

test("Assistant reaches connector tools only for an explicit, exact MCP grant", async () => {
  const { sources, calls } = ambientSources();
  // A global unattended run: no scheduling, only the approved server.
  const unattended = await assembleAgentTools(
    {
      mode: "assistant",
      permission: "full",
      allowScheduling: false,
      allowMcpTools: true,
      mcpServerIds: ["gmail"],
    },
    sources,
  );
  assert.deepEqual(names(unattended), ["mcp__gmail__send_email"]);
  assert.deepEqual(calls.mcp.map((ctx) => ctx.mcpServerIds), [["gmail"]]);
  assert.equal(calls.webSearch, 0);

  assert.deepEqual(
    await assembleAgentTools(
      { mode: "assistant", permission: "full", allowScheduling: false },
      sources,
    ),
    [],
  );
  assert.equal(calls.mcp.length, 1);
});

// --- Ordinary chats ------------------------------------------------------------

test("ordinary chats can inspect project and MCP identities before scheduling external work", async () => {
  const { sources } = ambientSources();
  const tools = names(
    await assembleAgentTools({ workspaceId: "workspace-1", permission: "full" }, sources),
  );
  for (const name of ["list_projects", "list_mcp_servers", "schedule_task"]) {
    assert.ok(tools.includes(name), `missing ${name}`);
  }

  const background = names(
    await assembleAgentTools(
      { workspaceId: "workspace-1", permission: "full", allowScheduling: false },
      sources,
    ),
  );
  for (const name of ["list_projects", "list_mcp_servers", "schedule_task"]) {
    assert.equal(background.includes(name), false, `${name} offered to a background run`);
  }
});

// --- Renderer boundary -----------------------------------------------------------

test("the renderer cannot request the internal unattended Assistant modes", () => {
  const base = { chatId: "chat-1", providerId: "local-provider", model: "model-1" };
  assert.equal(parseParams({ ...base, mode: "assistant" }).mode, "assistant");
  assert.equal(parseParams(base).mode, undefined);
  for (const mode of ["assistant-automation", "assistant-unattended", "subagent"]) {
    assert.throws(() => parseParams({ ...base, mode }), /Invalid chat mode/u);
  }
});

// --- Declined proposals ----------------------------------------------------------

test("declining an attended automation proposal tells the model to stop and hand back", async () => {
  const prompts: Array<{ approvalId: string }> = [];
  const approvals = new ToolApprovalCoordinator((prompt) => prompts.push(prompt));
  const pending = approvals.request({
    streamId: "stream-1",
    toolCallId: "call-1",
    toolName: "schedule_task",
    summary: "Create automation",
  });
  approvals.decide(prompts[0]!.approvalId, false);
  const outcome = await pending;
  assert.equal(outcome, "denied");

  const declined = toolApprovalBlockReason(outcome, true);
  assert.match(declined, /declined this automation/u);
  assert.match(declined, /Do not retry/u);
  assert.match(declined, /what else should we do\?/u);

  // Other denials and non-decisions do not claim an automation was declined.
  for (const other of ["cancelled", "detached", "unavailable"] as const) {
    assert.doesNotMatch(toolApprovalBlockReason(other, true), /declined this automation/u);
  }
  assert.doesNotMatch(toolApprovalBlockReason("denied", false), /declined this automation/u);
});
