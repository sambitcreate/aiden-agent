import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";
import { createSubagentTool } from "./subagent-tool.js";
import type { SubagentSupervisor } from "./subagent-supervisor.js";
import { subagentWorkspaceWriteAllowedForGeneration } from "./eligibility.js";

function tool(
  writeEnabled = false,
  mutationsEnabled = false,
  shellEnabled = false,
  delegationEnabled = false,
) {
  return createSubagentTool(
    {
      execute: async () => "done",
    } as unknown as SubagentSupervisor,
    [
      { serverId: "docs", tools: ["lookup", "search"] },
      { serverId: "calendar", tools: ["list_events"] },
    ],
    writeEnabled,
    mutationsEnabled ? [{ serverId: "docs", tools: ["publish"] }] : [],
    shellEnabled,
    delegationEnabled,
  );
}

function request(serverId: string, toolName: string) {
  return {
    capabilities: {
      workspaceRead: false,
      web: false,
      mcp: [{ serverId, tools: [toolName] }],
    },
    tasks: [{ role: "scout", label: "Inspect", task: "Inspect one source" }],
  };
}

test("model schema preserves exact server/tool pairings instead of cross-product enums", () => {
  const schema = tool().parameters as object;
  const validate = new Ajv().compile(schema);
  assert.equal(validate(request("docs", "lookup")), true);
  assert.equal(validate(request("calendar", "list_events")), true);
  assert.equal(validate(request("docs", "list_events")), false);
  assert.equal(validate(request("calendar", "lookup")), false);
});

test("two no-capability scouts need no model-supplied resource budget", () => {
  const delegated = tool();
  const validate = new Ajv().compile(delegated.parameters as object);
  const noCapabilityRhymes = {
    capabilities: { workspaceRead: false, web: false, mcp: [] },
    tasks: [
      { role: "scout", label: "Cat rhyme", task: "Write a four-line rhyme about a cat." },
      { role: "scout", label: "Moon rhyme", task: "Write a four-line rhyme about the moon." },
    ],
  };

  assert.equal(validate(noCapabilityRhymes), true);
  assert.equal(validate({ ...noCapabilityRhymes, deadlineMs: 60_000 }), false);
  assert.match(delegated.description, /resource limits, and run IDs are host-owned/u);
  assert.match(delegated.description, /never send execution, limits, deadline, or budget fields/u);
  assert.match(delegated.description, /infers only their exact union/u);
  assert.match(delegated.description, /capability-less siblings workspace-read-only/u);
});

test("Phase 5E exposes shell only after the complete positive production gate", async () => {
  const requestWithShell = {
    ...request("docs", "lookup"),
    capabilities: { ...request("docs", "lookup").capabilities, shell: true },
  };
  assert.equal(
    new Ajv().compile(tool(false, false, false).parameters as object)(
      requestWithShell,
    ),
    false,
  );
  const enabled = tool(false, false, true);
  assert.equal(
    new Ajv().compile(enabled.parameters as object)(requestWithShell),
    true,
  );
  assert.match(enabled.description, /full-host execution/u);
  assert.match(enabled.description, /not OS-sandboxed or rolled back/u);
  const [llm, assembly, runner] = await Promise.all([
    readFile(new URL("../llm-client.ts", import.meta.url), "utf8"),
    readFile(new URL("./subagent-tool-assembly.ts", import.meta.url), "utf8"),
    readFile(new URL("./subagent-child-runner.ts", import.meta.url), "utf8"),
  ]);
  assert.match(llm, /subagentChildShellEnabled/u);
  assert.match(llm, /await access\(subagentShellBinary\)/u);
  assert.match(assembly, /createSubagentShellTool/u);
  assert.match(runner, /prepareShellApproval/u);
});

test("Phase 6A schema remains inert unless the Phase 6B gate is enabled", async () => {
  const requestWithDelegate = {
    ...request("docs", "lookup"),
    capabilities: { ...request("docs", "lookup").capabilities, delegate: true },
  };
  for (const delegated of [tool(), tool(true, true, true)]) {
    assert.equal(
      new Ajv().compile(delegated.parameters as object)(requestWithDelegate),
      false,
    );
    assert.doesNotMatch(JSON.stringify(delegated.parameters), /"delegate"/u);
  }
  const productionSources = await Promise.all(
    [
      "../llm-client.ts",
      "./subagent-tool.ts",
      "./subagent-tool-assembly.ts",
      "./subagent-child-runner.ts",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );
  for (const source of productionSources) {
    assert.doesNotMatch(source, /subagent-nesting-core/u);
  }
});

test("Phase 6B exposes delegate only behind its exact production schema gate", () => {
  const requestWithDelegate = {
    ...request("docs", "lookup"),
    capabilities: { ...request("docs", "lookup").capabilities, delegate: true },
  };
  assert.equal(
    new Ajv().compile(tool(false, false, false, false).parameters)(
      requestWithDelegate,
    ),
    false,
  );
  const enabled = tool(false, false, false, true);
  assert.equal(
    new Ajv().compile(enabled.parameters)(requestWithDelegate),
    true,
  );
  assert.match(enabled.description, /depth-1 child/u);
  assert.match(enabled.description, /fresh context by default/u);
  assert.match(enabled.description, /explicit immutable user-visible fork/u);
  assert.match(enabled.description, /depth-2 children cannot delegate/u);
});

test("model-facing MCP copy is truthful about server-declared read-only metadata", () => {
  const delegated = tool();
  assert.match(delegated.description, /server-declared read-only MCP/u);
  assert.match(
    delegated.description,
    /configured server controls the actual effect/u,
  );
  assert.doesNotMatch(
    delegated.description,
    /(?:^|\s)listed read-only MCP|Requestable read-only MCP/u,
  );
  assert.match(
    JSON.stringify(delegated.parameters),
    /server-declared read-only/u,
  );
});

test("task-label schema matches renderer-safe attended approval labels", () => {
  const validate = new Ajv().compile(tool(true).parameters as object);
  for (const label of [" Leading", "Trailing ", "Bi\u202edi", "Bad\nline"]) {
    assert.equal(
      validate({
        ...request("docs", "lookup"),
        tasks: [{ role: "scout", label, task: "Inspect one source" }],
      }),
      false,
    );
  }
  assert.equal(
    validate({
      ...request("docs", "lookup"),
      tasks: [
        { role: "scout", label: "Safe label", task: "Inspect one source" },
      ],
    }),
    true,
  );
});

test("workspace-write schema exposure is positive, rollbackable, and truthful about attended tools", () => {
  const disabled = tool();
  const disabledValidate = new Ajv().compile(disabled.parameters as object);
  assert.equal(
    disabledValidate({
      ...request("docs", "lookup"),
      capabilities: {
        ...request("docs", "lookup").capabilities,
        workspaceWrite: true,
      },
    }),
    false,
  );
  assert.doesNotMatch(disabled.description, /workspace-write/u);

  const enabled = tool(true);
  const enabledValidate = new Ajv().compile(enabled.parameters as object);
  assert.equal(
    enabledValidate({
      ...request("docs", "lookup"),
      capabilities: {
        ...request("docs", "lookup").capabilities,
        workspaceWrite: true,
      },
    }),
    true,
  );
  assert.match(enabled.description, /positive foreground authority request/u);
  assert.match(
    enabled.description,
    /only exact write_file\/edit_file calls are exposed/u,
  );
  assert.match(JSON.stringify(enabled.parameters), /one-shot owner approval/u);
});

test("read-only parent schema omits write requests over a full stored workspace", () => {
  const writeEnabled = subagentWorkspaceWriteAllowedForGeneration({
    subagentsAllowed: true,
    childWriteRollout: true,
    v2StoreSelected: true,
    workspacePermission: "full",
    generationPermission: "read-only",
  });
  assert.equal(writeEnabled, false);
  const delegated = tool(writeEnabled);
  assert.doesNotMatch(JSON.stringify(delegated.parameters), /workspaceWrite/u);
  assert.doesNotMatch(delegated.description, /workspace-write/u);
});

test("Phase 5C exposes only exact rollback-gated mutation requests", async () => {
  const disabled = new Ajv().compile(tool(true).parameters as object);
  const mutationRequest = {
    ...request("docs", "lookup"),
    capabilities: {
      ...request("docs", "lookup").capabilities,
      mcpMutations: [{ serverId: "docs", tools: ["publish"] }],
    },
  };
  assert.equal(disabled(mutationRequest), false);
  assert.doesNotMatch(JSON.stringify(tool(true).parameters), /mcpMutations/u);

  const validate = new Ajv().compile(tool(true, true).parameters as object);
  assert.equal(validate(mutationRequest), true);
  assert.equal(
    validate({
      ...mutationRequest,
      capabilities: {
        ...mutationRequest.capabilities,
        mcpMutations: [{ serverId: "docs", tools: ["lookup"] }],
      },
    }),
    false,
  );
  assert.match(JSON.stringify(tool(true, true).parameters), /mcpMutations/u);
  assert.match(tool(true, true).description, /never retries automatically/u);
  assert.match(tool(true, true).description, /rollback is unavailable/u);

  const [llm, assembly, schema, mutationApproval, mutationBroker] =
    await Promise.all([
      readFile(new URL("../llm-client.ts", import.meta.url), "utf8"),
      readFile(new URL("./subagent-tool-assembly.ts", import.meta.url), "utf8"),
      readFile(new URL("./subagent-tool.ts", import.meta.url), "utf8"),
      readFile(
        new URL("./subagent-mcp-mutation-approval.ts", import.meta.url),
        "utf8",
      ),
      readFile(new URL("./subagent-mcp-mutation.ts", import.meta.url), "utf8"),
    ]);
  assert.match(llm, /subagentChildMcpMutationsEnabled/u);
  assert.match(llm, /projectRequestableSubagentMcpMutationInventoryV2/u);
  assert.match(assembly, /createSubagentMcpMutationToolsV2/u);
  assert.match(schema, /mcpMutations/u);
  assert.doesNotMatch(
    mutationApproval,
    /callTool\(|createReadOnlySubagentMcpTools/u,
  );
  assert.match(mutationBroker, /dispatchRaw/u);
  assert.match(mutationBroker, /markEffectDispatchStarted/u);
});

test("llm-client resolves write rollout before schema and authority exposure", async () => {
  const source = await readFile(
    new URL("../llm-client.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const childWriteRollout = subagentChildWriteEnabled\(\)/u,
  );
  assert.match(source, /subagentWorkspaceWriteAllowedForGeneration/u);
  assert.match(source, /generationPermission: permission/u);
  assert.match(source, /subagentRunStore\.selection === "v2"/u);
  assert.match(source, /writeEnabled: subagentWriteEnabled/u);
  assert.match(
    source,
    /projectRequestableSubagentMcpInventoryV2\(subagentMcpInventory\),\s+subagentWriteEnabled,\s+childMcpMutationsRollout/u,
  );
});
