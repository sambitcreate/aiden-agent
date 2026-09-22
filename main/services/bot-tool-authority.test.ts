import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { RegisteredSkill, SkillRegistrySnapshot } from "./skill-registry.js";
import type { BotRuntimeEffectiveAuthority } from "./bot-runtime-authority.js";
import {
  assertBotSkillInvocationAllowed,
  botToolCapabilityAllowed,
  exactBotMcpToolNames,
  exactBotSkillToolNames,
  filterExactBotSubagentMcpInventory,
  filterBotAgentTools,
  filterBotSkillSnapshot,
  type BotToolAdmissionPort,
  type BotToolCandidate,
  type BotToolCapability,
} from "./bot-tool-authority.js";
import { botCapabilityFactsFingerprint } from "./bot-capability-catalog-core.js";
import {
  resolveBotMcpConnectionIdentities,
  resolveBotMcpInventory,
} from "./bot-mcp-inventory.js";
import { inspectSubagentMcpServer } from "./subagents/subagent-mcp-read.js";
import type { McpServer } from "./types.js";
import { createHash } from "node:crypto";

const fingerprint = (value: string) => value.padEnd(64, value[0] ?? "0").slice(0, 64);

function result(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null };
}

function tool(name: string, effect: (signal?: AbortSignal) => void = () => {}): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      effect(signal);
      return result(name);
    },
  };
}

const documents = {
  sourceId: "documents",
  scopeFingerprint: fingerprint("d"),
  exactFingerprint: fingerprint("D"),
};
const fullMac = {
  sourceId: "full-mac",
  scopeFingerprint: fingerprint("f"),
  exactFingerprint: fingerprint("F"),
};
const mcpTool = {
  toolId: fingerprint("t"),
  name: "calendar_events",
  inputSchemaFingerprint: fingerprint("i"),
  outputSchemaFingerprint: fingerprint("o"),
  effect: "mutating" as const,
  effectFingerprint: fingerprint("e"),
  exactFingerprint: fingerprint("t"),
};
const connection = {
  sourceId: "calendar",
  connectionFingerprint: fingerprint("c"),
  toolsetFingerprint: fingerprint("a"),
  exactFingerprint: fingerprint("C"),
  tools: [mcpTool],
};
const skill = {
  sourceId: "skill-research",
  identityFingerprint: fingerprint("s"),
  contentFingerprint: fingerprint("k"),
  exactFingerprint: fingerprint("S"),
};
const web = {
  kind: "web" as const,
  capabilityFingerprint: fingerprint("w"),
  exactFingerprint: fingerprint("W"),
};

const customAuthority: BotRuntimeEffectiveAuthority = {
  audienceId: "local",
  botId: "bot",
  chatId: "chat",
  accessMode: "custom",
  botPolicy: { revision: "bot-revision", epoch: "bot-epoch" },
  chatPolicy: { mode: "inherit", revision: "chat-revision", epoch: "chat-epoch" },
  catalogRevision: "catalog-revision",
  provider: {
    sourceProviderId: "provider",
    sourceModelId: "model",
    connectionFingerprint: fingerprint("p"),
    providerExactFingerprint: fingerprint("P"),
    modelFingerprint: fingerprint("m"),
    modelExactFingerprint: fingerprint("M"),
  },
  files: {
    mode: "scoped",
    botHome: true,
    approvedLocations: [documents],
  },
  shell: {
    enabled: true,
    shellFingerprint: fingerprint("x"),
    exactFingerprint: fingerprint("X"),
  },
  connections: [connection],
  skills: [skill],
  otherCapabilities: [web],
  managedHome: {
    botId: "bot",
    workspaceId: "managed-workspace",
    createdAt: 1,
    incarnation: { device: "1", inode: "2" },
  },
  workingDirectory: "/private/bot-home",
};

function capabilityCandidates(): BotToolCandidate[] {
  return [
    {
      tool: tool("read_file"),
      available: true,
      capability: {
        kind: "file",
        operation: "read",
        scope: { kind: "bot_home", workspaceId: "managed-workspace" },
      },
    },
    {
      tool: tool("write_documents"),
      available: true,
      capability: {
        kind: "file",
        operation: "write",
        scope: { kind: "approved_location", ...documents },
      },
    },
    {
      tool: tool("read_downloads"),
      available: true,
      capability: {
        kind: "file",
        operation: "read",
        scope: {
          kind: "approved_location",
          sourceId: "downloads",
          scopeFingerprint: fingerprint("l"),
          exactFingerprint: fingerprint("L"),
        },
      },
    },
    {
      tool: tool("run_command"),
      available: true,
      capability: {
        kind: "shell",
        workingDirectory: customAuthority.workingDirectory,
        shellFingerprint: fingerprint("x"),
        shellExactFingerprint: fingerprint("X"),
      },
    },
    {
      tool: tool("calendar__events"),
      available: true,
      capability: {
        kind: "mcp",
        connectionSourceId: connection.sourceId,
        connectionFingerprint: connection.connectionFingerprint,
        connectionExactFingerprint: connection.exactFingerprint,
        ...mcpTool,
      },
    },
    {
      tool: tool("calendar__new_tool"),
      available: true,
      capability: {
        kind: "mcp",
        connectionSourceId: connection.sourceId,
        connectionFingerprint: connection.connectionFingerprint,
        connectionExactFingerprint: connection.exactFingerprint,
        ...mcpTool,
        name: "new_tool",
        toolId: fingerprint("n"),
        exactFingerprint: fingerprint("n"),
      },
    },
    {
      tool: tool("skill_research"),
      available: true,
      capability: { kind: "skill", ...skill },
    },
    {
      tool: tool("skill_changed"),
      available: true,
      capability: {
        kind: "skill",
        ...skill,
        contentFingerprint: fingerprint("q"),
      },
    },
    {
      tool: tool("web_search"),
      available: true,
      capability: {
        kind: "other",
        ordinaryKind: "web",
        capabilityFingerprint: web.capabilityFingerprint,
        exactFingerprint: web.exactFingerprint,
      },
    },
    {
      tool: tool("computer_use"),
      available: true,
      capability: {
        kind: "other",
        ordinaryKind: "computer_use",
        capabilityFingerprint: fingerprint("u"),
        exactFingerprint: fingerprint("U"),
      },
    },
  ];
}

function admission(
  authority: BotRuntimeEffectiveAuthority = customAuthority,
  revalidateBeforeEffect: () => Promise<void> = async () => {},
): BotToolAdmissionPort {
  return {
    authority,
    signal: new AbortController().signal,
    revalidateBeforeEffect,
    release() {},
  };
}

test("ordinary chats retain their existing assembled tool set", () => {
  const candidates = capabilityCandidates();
  candidates[0]!.available = false;
  assert.deepEqual(
    filterBotAgentTools(candidates).map(({ name }) => name),
    candidates.map(({ tool }) => tool.name),
  );
  assert.equal(filterBotAgentTools(candidates)[0], candidates[0]!.tool);
});

test("Full Access mirrors only currently available ordinary inventory", () => {
  const candidates = capabilityCandidates();
  candidates[2]!.available = false;
  const fullAuthority: BotRuntimeEffectiveAuthority = {
    ...customAuthority,
    accessMode: "full",
  };
  assert.deepEqual(
    filterBotAgentTools(candidates, admission(fullAuthority)).map(({ name }) => name),
    candidates.filter(({ available }) => available).map(({ tool }) => tool.name),
  );
});

test("Full Access does not infer Web Search from general availability", () => {
  const webCandidate = capabilityCandidates().find(({ tool }) => tool.name === "web_search")!;
  const fullAuthority: BotRuntimeEffectiveAuthority = {
    ...customAuthority,
    accessMode: "full",
    otherCapabilities: [],
  };
  assert.equal(botToolCapabilityAllowed(fullAuthority, webCandidate.capability), false);
});

test("Custom publishes only exact Files, shell, MCP tools, skills, and other abilities", () => {
  assert.deepEqual(
    filterBotAgentTools(capabilityCandidates(), admission()).map(({ name }) => name),
    [
      "read_file",
      "write_documents",
      "run_command",
      "calendar__events",
      "skill_research",
      "web_search",
    ],
  );
});

test("new or changed resources never widen Custom authority", () => {
  const changedSchema: BotToolCapability = {
    kind: "mcp",
    connectionSourceId: connection.sourceId,
    connectionFingerprint: connection.connectionFingerprint,
    connectionExactFingerprint: connection.exactFingerprint,
    ...mcpTool,
    inputSchemaFingerprint: fingerprint("z"),
  };
  const changedHome: BotToolCapability = {
    kind: "file",
    operation: "read",
    scope: {
      kind: "approved_location",
      ...documents,
      exactFingerprint: fingerprint("r"),
    },
  };
  assert.equal(botToolCapabilityAllowed(customAuthority, changedSchema), false);
  assert.equal(botToolCapabilityAllowed(customAuthority, changedHome), false);
});

test("web, browser, Computer Use, schedules, and subagents require exact selected grants", () => {
  for (const [index, ordinaryKind] of (
    ["web", "browser", "computer_use", "schedules", "subagents"] as const
  ).entries()) {
    const grant = {
      kind: ordinaryKind,
      capabilityFingerprint: fingerprint(String(index + 1)),
      exactFingerprint: fingerprint(String(index + 6)),
    };
    const authority: BotRuntimeEffectiveAuthority = {
      ...customAuthority,
      otherCapabilities: [grant],
    };
    const capability: Extract<BotToolCapability, { kind: "other" }> = {
      kind: "other",
      ordinaryKind,
      capabilityFingerprint: grant.capabilityFingerprint,
      exactFingerprint: grant.exactFingerprint,
    };
    assert.equal(botToolCapabilityAllowed(authority, capability), true, ordinaryKind);
    assert.equal(
      botToolCapabilityAllowed(authority, {
        ...capability,
        exactFingerprint: fingerprint("z"),
      }),
      false,
      `${ordinaryKind} changed`,
    );
  }
});

test("Custom shell follows its exact independent grant", () => {
  const noShell: BotRuntimeEffectiveAuthority = {
    ...customAuthority,
    shell: { enabled: false },
  };
  const onlyShell = capabilityCandidates().filter(({ tool }) => tool.name === "run_command");
  assert.deepEqual(filterBotAgentTools(onlyShell, admission(noShell)), []);

  const filesOff: BotRuntimeEffectiveAuthority = {
    ...customAuthority,
    files: { mode: "off", botHome: false, approvedLocations: [] },
  };
  assert.deepEqual(
    filterBotAgentTools(onlyShell, admission(filesOff)).map(({ name }) => name),
    ["run_command"],
  );

  const fullMacAuthority: BotRuntimeEffectiveAuthority = {
    ...customAuthority,
    files: { mode: "full_mac", botHome: false, fullMac, approvedLocations: [] },
  };
  assert.deepEqual(
    filterBotAgentTools(onlyShell, admission(fullMacAuthority)).map(({ name }) => name),
    ["run_command"],
  );
});

test("execution awaits the resource check and fresh admission check immediately before effect", async () => {
  const events: string[] = [];
  const candidate: BotToolCandidate = {
    tool: tool("read_file", (signal) => {
      events.push("effect");
      assert.equal(signal?.aborted, false);
    }),
    available: true,
    capability: {
      kind: "file",
      operation: "read",
      scope: { kind: "bot_home", workspaceId: "managed-workspace" },
    },
    revalidateResource: async () => {
      events.push("resource");
    },
  };
  const [filtered] = filterBotAgentTools(
    [candidate],
    admission(customAuthority, async () => {
      events.push("admission");
    }),
  );
  await filtered!.execute("call", {}, new AbortController().signal);
  assert.deepEqual(events, ["resource", "admission", "effect"]);
});

test("failed fresh admission prevents the effect", async () => {
  let effects = 0;
  const [filtered] = filterBotAgentTools(
    [
      {
        tool: tool("read_file", () => {
          effects += 1;
        }),
        available: true,
        capability: {
          kind: "file",
          operation: "read",
          scope: { kind: "bot_home", workspaceId: "managed-workspace" },
        },
      },
    ],
    admission(customAuthority, async () => {
      throw new Error("authority changed");
    }),
  );
  await assert.rejects(
    filtered!.execute("call", {}, new AbortController().signal),
    /authority changed/u,
  );
  assert.equal(effects, 0);
});

function registeredSkill(
  invocationId: string,
  toolKey: string,
  available = true,
): RegisteredSkill {
  return {
    stableId: invocationId,
    invocationId,
    toolKey,
    name: invocationId,
    description: "",
    instructions: `${invocationId} instructions`,
    source: "configured",
    enabled: true,
    available,
  };
}

function skillSnapshot(): SkillRegistrySnapshot {
  const allowed = registeredSkill("allowed", "skill_allowed");
  const denied = registeredSkill("denied", "skill_denied");
  return {
    workspaceId: "workspace",
    workspacePermission: "full",
    revision: "revision",
    fingerprint: "fingerprint",
    catalog: [
      { invocationId: "allowed", name: "allowed", description: "", source: "configured", available: true },
      { invocationId: "denied", name: "denied", description: "", source: "configured", available: true },
    ],
    skills: [allowed, denied],
    available: [allowed, denied],
  };
}

test("skill prompt/resources and explicit invocation share the filtered schema set", () => {
  const allowed = new Set(["skill_allowed"]);
  const filtered = filterBotSkillSnapshot(skillSnapshot(), allowed, admission());
  assert.deepEqual(filtered.skills.map(({ toolKey }) => toolKey), ["skill_allowed"]);
  assert.deepEqual(filtered.available.map(({ toolKey }) => toolKey), ["skill_allowed"]);
  assert.deepEqual(filtered.catalog.map(({ invocationId }) => invocationId), ["allowed"]);
  assert.doesNotThrow(() => assertBotSkillInvocationAllowed("skill_allowed", allowed, admission()));
  assert.throws(
    () => assertBotSkillInvocationAllowed("skill_denied", allowed, admission()),
    /not enabled/u,
  );
});

test("ordinary skill snapshots and invocations are unchanged", () => {
  const snapshot = skillSnapshot();
  assert.equal(filterBotSkillSnapshot(snapshot, new Set()), snapshot);
  assert.doesNotThrow(() => assertBotSkillInvocationAllowed("skill_denied", new Set()));
});

test("main MCP publication requires an exact fresh connection and tool join", () => {
  const currentConnection = {
    option: { id: "opaque", label: "Calendar", available: true },
    sourceId: connection.sourceId,
    connectionFingerprint: connection.connectionFingerprint,
    toolsetFingerprint: connection.toolsetFingerprint,
    exactFingerprint: connection.exactFingerprint,
    tools: [{ ...mcpTool }],
  };
  const exact = exactBotMcpToolNames(
    customAuthority,
    [currentConnection],
    (sourceId, name) => `${sourceId}__${name}`,
  );
  assert.equal(exact.get("calendar__calendar_events")?.exactFingerprint, mcpTool.exactFingerprint);
  assert.throws(
    () => exactBotMcpToolNames(
      customAuthority,
      [{
        ...currentConnection,
        tools: [{ ...mcpTool, outputSchemaFingerprint: fingerprint("changed") }],
      }],
      (sourceId, name) => `${sourceId}__${name}`,
    ),
    /connection tool changed/u,
  );
});

test("subagent MCP projection joins connection, combined schema, output, effect, and exact facts", () => {
  const digest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
  const schemaHash = fingerprint("h");
  const outputSchemaFingerprint = digest({ outputSchema: "not_declared" });
  const effectFingerprint = digest({ effect: "read" });
  const exactFingerprint = botCapabilityFactsFingerprint({
    name: "lookup",
    inputSchemaFingerprint: schemaHash,
    outputSchemaFingerprint,
    effect: "read",
    effectFingerprint,
  });
  const exactAuthority: BotRuntimeEffectiveAuthority = {
    ...customAuthority,
    connections: [{
      ...connection,
      tools: [{
        toolId: exactFingerprint,
        name: "lookup",
        inputSchemaFingerprint: schemaHash,
        outputSchemaFingerprint,
        effect: "read",
        effectFingerprint,
        exactFingerprint,
      }],
    }],
  };
  const inventory = [{
    serverId: connection.sourceId,
    // Child authority deliberately uses a process-owned credential domain.
    connectionFingerprint: fingerprint("child-process"),
    tools: [{ toolName: "lookup", schemaHash, effect: "read" as const }],
  }];
  const identities = [{
    serverId: connection.sourceId,
    connectionFingerprint: connection.connectionFingerprint,
  }];
  assert.equal(
    filterExactBotSubagentMcpInventory(exactAuthority, inventory, identities)[0]?.tools.length,
    1,
  );
  assert.deepEqual(
    filterExactBotSubagentMcpInventory(exactAuthority, inventory, [{
      ...identities[0]!,
      connectionFingerprint: fingerprint("wrong"),
    }]),
    [],
  );
  assert.deepEqual(
    filterExactBotSubagentMcpInventory(
      {
        ...exactAuthority,
        connections: [{
          ...exactAuthority.connections[0]!,
          tools: [{
            ...exactAuthority.connections[0]!.tools[0]!,
            outputSchemaFingerprint: fingerprint("wrong"),
          }],
        }],
      },
      inventory,
      identities,
    ),
    [],
  );
});

test("subagent MCP projection joins real durable Bot and process-owned child identities", async () => {
  const server: McpServer = {
    id: "research",
    name: "Research",
    transport: "http",
    url: "https://mcp.example.invalid",
    enabled: true,
  };
  const remoteTools = [{
    name: "lookup",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
  }];
  const credentialSignature = createHash("sha256").update("durable-credential").digest("hex");
  const credentialRevision = createHash("sha256").update("process-credential").digest("hex");
  let credentialIncarnation = "credential-incarnation".padEnd(43, "c");
  const incarnations = {
    reconcileNamespace: async (_namespace: "mcp", resources: readonly { sourceId: string }[]) =>
      resources.map(({ sourceId }) => ({
        sourceId,
        resourceIncarnation: "resource-incarnation".padEnd(43, "r"),
        credentialIncarnation,
      })),
  };
  const dependencies = {
    listServers: async () => [server],
    credentialSignature: async () => credentialSignature,
    inspectTools: async () => remoteTools,
    incarnations,
  };
  const [botInventory, identities, childInventory] = await Promise.all([
    resolveBotMcpInventory(new AbortController().signal, dependencies),
    resolveBotMcpConnectionIdentities(new AbortController().signal, dependencies),
    inspectSubagentMcpServer({
      server,
      signal: new AbortController().signal,
      withClient: async (_current, _signal, operation) => operation({
        credentialRevision,
        credentialRevisionIsCurrent: async () => true,
        redactCredentialText: (text) => text,
        listTools: async () => remoteTools,
        callTool: async () => ({ content: [] }),
      }),
    }),
  ]);
  const botScope = botInventory[0]!;
  const botTool = botScope.tools[0]!;
  assert.notEqual(botScope.connectionFingerprint, childInventory.connectionFingerprint);
  assert.equal(identities[0]?.connectionFingerprint, botScope.connectionFingerprint);

  const outputSchemaFingerprint = createHash("sha256")
    .update(JSON.stringify({ outputSchema: "not_declared" }), "utf8")
    .digest("hex");
  const effectFingerprint = createHash("sha256")
    .update(JSON.stringify({ effect: "read" }), "utf8")
    .digest("hex");
  const exactFingerprint = botCapabilityFactsFingerprint({
    name: botTool.toolName,
    inputSchemaFingerprint: botTool.schemaHash,
    outputSchemaFingerprint,
    effect: botTool.effect,
    effectFingerprint,
  });
  const exactAuthority: BotRuntimeEffectiveAuthority = {
    ...customAuthority,
    connections: [{
      sourceId: botScope.serverId,
      connectionFingerprint: botScope.connectionFingerprint,
      toolsetFingerprint: botCapabilityFactsFingerprint([{
        name: botTool.toolName,
        exactFingerprint,
      }]),
      exactFingerprint: botCapabilityFactsFingerprint({
        connectionFingerprint: botScope.connectionFingerprint,
        toolsetFingerprint: botCapabilityFactsFingerprint([{
          name: botTool.toolName,
          exactFingerprint,
        }]),
      }),
      tools: [{
        toolId: exactFingerprint,
        name: botTool.toolName,
        inputSchemaFingerprint: botTool.schemaHash,
        outputSchemaFingerprint,
        effect: botTool.effect,
        effectFingerprint,
        exactFingerprint,
      }],
    }],
  };

  assert.equal(
    filterExactBotSubagentMcpInventory(
      exactAuthority,
      [{ ...childInventory, tools: [...childInventory.tools] }],
      identities,
    )[0]?.tools[0]?.toolName,
    "lookup",
  );
  credentialIncarnation = "rotated-credential-incarnation".padEnd(43, "x");
  const rotatedIdentities = await resolveBotMcpConnectionIdentities(
    new AbortController().signal,
    dependencies,
  );
  assert.notEqual(
    rotatedIdentities[0]?.connectionFingerprint,
    identities[0]?.connectionFingerprint,
  );
  assert.deepEqual(
    filterExactBotSubagentMcpInventory(
      exactAuthority,
      [{ ...childInventory, tools: [...childInventory.tools] }],
      rotatedIdentities,
    ),
    [],
  );
});

test("skill publication joins the exact fresh catalog resource and runtime content", () => {
  const snapshot = skillSnapshot();
  const selected = snapshot.available[0]!;
  const exactAuthority: BotRuntimeEffectiveAuthority = {
    ...customAuthority,
    skills: [skill],
  };
  const current = [{
    option: { id: "opaque", label: selected.name, available: true },
    sourceId: skill.sourceId,
    identityFingerprint: skill.identityFingerprint,
    contentFingerprint: skill.contentFingerprint,
    exactFingerprint: skill.exactFingerprint,
  }];
  const runtime = [{
    sourceId: skill.sourceId,
    runtimeStableId: selected.stableId,
    label: selected.name,
    description: selected.description,
    instructions: selected.instructions,
    available: true,
    incarnationPartition: "global",
  }];
  assert.deepEqual(
    [...exactBotSkillToolNames(exactAuthority, current, runtime, snapshot)],
    [selected.toolKey],
  );
  assert.throws(
    () => exactBotSkillToolNames(
      exactAuthority,
      [{ ...current[0]!, contentFingerprint: fingerprint("wrong") }],
      runtime,
      snapshot,
    ),
    /skill changed or is unavailable/u,
  );
  assert.throws(
    () => exactBotSkillToolNames(
      exactAuthority,
      current,
      [{ ...runtime[0]!, instructions: "changed" }],
      snapshot,
    ),
    /skill changed while this response was starting/u,
  );
});
