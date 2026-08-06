import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  MAX_SUBAGENT_LABEL_CHARS,
  MAX_SUBAGENT_REQUESTED_MCP_SERVERS,
  MAX_SUBAGENT_REQUESTED_MCP_TOOLS_PER_SERVER,
  MAX_SUBAGENT_TASK_CHARS,
  MAX_SUBAGENT_TASKS_PER_CALL,
  SUBAGENT_SAFE_LABEL_PATTERN,
} from "./contracts.js";
import type { SubagentRequestableMcpInventoryV2 } from "./request-capabilities-v2.js";
import type { SubagentSupervisor } from "./subagent-supervisor.js";
import { SUBAGENT_PARENT_SECURITY_GUIDANCE } from "./role-catalog.js";

function textResult(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null };
}

function capabilitySchema(
  inventory: readonly SubagentRequestableMcpInventoryV2[],
  writeEnabled: boolean,
  mutationInventory: readonly SubagentRequestableMcpInventoryV2[],
  shellEnabled: boolean,
  delegationEnabled: boolean,
) {
  const laneScope = (
    laneInventory: readonly SubagentRequestableMcpInventoryV2[],
    description: string,
  ) =>
    laneInventory.length === 0
      ? Type.Unknown()
      : Type.Union(
          laneInventory.map(({ serverId, tools }) =>
            Type.Object(
              {
                serverId: Type.String({
                  enum: [serverId],
                  description:
                    "Exact server ID from the host-generated inventory.",
                }),
                tools: Type.Array(
                  Type.String({
                    enum: tools,
                    description,
                  }),
                  {
                    minItems: 1,
                    maxItems: MAX_SUBAGENT_REQUESTED_MCP_TOOLS_PER_SERVER,
                  },
                ),
              },
              { additionalProperties: false },
            ),
          ),
        );
  const mcpScope = laneScope(
    inventory,
    "Exact server-declared read-only tool name listed for this server.",
  );
  const mutationScope = laneScope(
    mutationInventory,
    "Exact mutating tool name listed for this server. Every call requires attended one-shot approval.",
  );
  return Type.Object(
    {
      workspaceRead: Type.Boolean({
        description:
          "Request bounded read-only access to the selected workspace.",
      }),
      ...(writeEnabled
        ? {
            workspaceWrite: Type.Optional(
              Type.Boolean({
                description:
                  "Request foreground workspace-write authority. Exact write_file/edit_file calls require separate one-shot owner approval and refuse changed targets.",
              }),
            ),
          }
        : {}),
      ...(shellEnabled
        ? {
            shell: Type.Optional(
              Type.Boolean({
                description:
                  "Request attended full-host command execution. Every exact run_command call requires Allow once; it is not OS-sandboxed or rolled back.",
              }),
            ),
          }
        : {}),
      ...(delegationEnabled
        ? {
            delegate: Type.Optional(
              Type.Boolean({
                description:
                  "Request one bounded foreground nesting level. Only a depth-1 child may receive a child-safe delegation tool; depth-2 children cannot delegate.",
              }),
            ),
          }
        : {}),
      web: Type.Boolean({
        description:
          "Request host-proxied web search. Every exact call still needs approval.",
      }),
      mcp: Type.Array(mcpScope, {
        maxItems:
          inventory.length === 0 ? 0 : MAX_SUBAGENT_REQUESTED_MCP_SERVERS,
      }),
      ...(mutationInventory.length > 0
        ? {
            mcpMutations: Type.Optional(
              Type.Array(mutationScope, {
                maxItems: MAX_SUBAGENT_REQUESTED_MCP_SERVERS,
                description:
                  "Request exact foreground mutating MCP tools. Calls are never retried automatically and have no rollback.",
              }),
            ),
          }
        : {}),
    },
    { additionalProperties: false },
  );
}

export function createSubagentTool(
  supervisor: SubagentSupervisor,
  mcpInventory: readonly SubagentRequestableMcpInventoryV2[] = [],
  writeEnabled = false,
  mcpMutationInventory: readonly SubagentRequestableMcpInventoryV2[] = [],
  shellEnabled = false,
  delegationEnabled = false,
): AgentTool {
  const inventoryDescription =
    mcpInventory.length === 0
      ? "No server-declared read-only MCP tools are requestable for this response."
      : `Requestable server-declared read-only MCP tools: ${mcpInventory
          .map(({ serverId, tools }) => `${serverId}=[${tools.join(", ")}]`)
          .join("; ")}.`;
  const mutationInventoryDescription =
    mcpMutationInventory.length === 0
      ? "No mutating MCP tools are requestable for this response."
      : `Requestable mutating MCP tools: ${mcpMutationInventory
          .map(({ serverId, tools }) => `${serverId}=[${tools.join(", ")}]`)
          .join("; ")}.`;
  const capabilities = capabilitySchema(
    mcpInventory,
    writeEnabled,
    mcpMutationInventory,
    shellEnabled,
    delegationEnabled,
  );
  const writeDescription = writeEnabled
    ? "Workspace-write is a positive foreground authority request, not an ambient grant; only exact write_file/edit_file calls are exposed, and each call still requires one-shot owner approval. "
    : "";
  const shellDescription = shellEnabled
    ? "Shell is a positive full-host execution request: every exact run_command pauses for Allow once, uses only a minimal environment, is not OS-sandboxed or rolled back, may use arbitrary network access, and deliberately detached processes may survive cancellation. "
    : "";
  const delegationDescription = delegationEnabled
    ? "Delegation is a positive foreground request. A permitted depth-1 child may launch one bounded depth-2 batch with fresh context by default or an explicit immutable user-visible fork; depth-2 children cannot delegate. "
    : "";
  return {
    name: "subagent",
    label: "Delegate to Subagents",
    description: `Delegate 1–4 independent, bounded investigations to scout, planner, or reviewer agents. Omitted capabilities preserve workspace-read-only behavior. ${writeDescription}${shellDescription}${delegationDescription}Web and listed server-declared read-only MCP capabilities are requests, not grants; each exact egress call pauses for owner approval, and the configured server controls the actual effect. Mutating MCP is a separate positive request: every exact call pauses for one-shot owner approval, the configured server controls the effect, rollback is unavailable, and Aiden never retries automatically. Task capabilities may only narrow their matching root lane. ${inventoryDescription} ${mutationInventoryDescription} Context is fresh by default; request a bounded conversation fork only when persisted user-visible decisions or attachments are required. Timing, resource limits, and run IDs are host-owned: never send execution, limits, deadline, or budget fields. Each task contains only role, label, task, and optional narrower capabilities. Use for parallel evidence gathering, comparison, planning, or fresh review—not trivial work. You must reconcile their ordered results and write the final synthesis. ${SUBAGENT_PARENT_SECURITY_GUIDANCE}`,
    parameters: Type.Object(
      {
        context: Type.Optional(
          Type.String({
            enum: ["fresh", "fork"],
            description:
              "Use fresh by default. Use fork only when the task depends on decisions or user-visible attachments in this persisted conversation.",
          }),
        ),
        capabilities: Type.Optional(capabilities),
        tasks: Type.Array(
          Type.Object(
            {
              // A flat enum is more reliably followed by OpenAI-compatible
              // providers than TypeBox's equivalent `anyOf` + `const` union.
              // `parseSubagentToolRequest` still independently enforces the
              // exact role allowlist before any child can launch.
              role: Type.String({
                enum: ["scout", "planner", "reviewer"],
                description: "Exactly one of: scout, planner, reviewer.",
              }),
              label: Type.String({
                minLength: 1,
                maxLength: MAX_SUBAGENT_LABEL_CHARS,
                pattern: SUBAGENT_SAFE_LABEL_PATTERN,
                description: "Short user-facing label for this delegated task.",
              }),
              task: Type.String({
                minLength: 1,
                maxLength: MAX_SUBAGENT_TASK_CHARS,
                description: "One self-contained investigation for the child.",
              }),
              capabilities: Type.Optional(capabilities),
            },
            { additionalProperties: false },
          ),
          {
            minItems: 1,
            maxItems: MAX_SUBAGENT_TASKS_PER_CALL,
          },
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) =>
      textResult(await supervisor.execute(params, signal)),
  };
}
