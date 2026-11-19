import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  MAX_SUBAGENT_LABEL_CHARS,
  MAX_SUBAGENT_REQUESTED_MCP_SERVERS,
  MAX_SUBAGENT_REQUESTED_MCP_TOOLS_PER_SERVER,
  MAX_SUBAGENT_REQUESTED_TURNS,
  MAX_SUBAGENT_TASK_CHARS,
  MAX_SUBAGENT_TASKS_PER_CALL,
  SUBAGENT_SAFE_LABEL_PATTERN,
} from "./contracts.js";
import type { SubagentRequestableMcpInventoryV2 } from "./request-capabilities-v2.js";
import type { SubagentSupervisor } from "./subagent-supervisor.js";
import { subagentModelKey, type SubagentModelToolOptions } from "./subagent-model-selection.js";
import { SUBAGENT_PARENT_SECURITY_GUIDANCE } from "./role-catalog.js";
import { GENERATION_THINKING_LEVELS } from "../../../renderer/shared/generation-thinking.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textResult(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null };
}

/**
 * One MCP scope shape for every inventory. The requestable servers and tools
 * are returned by the `list` action, never declared here, so connecting or
 * disconnecting a server leaves the cached tool list unchanged. The host
 * resolves every requested pair against its live inventory and lane before
 * any child launches (`resolveRequestedSubagentCapabilitiesV2`).
 */
function mcpScopeSchema(description: string) {
  return Type.Object(
    {
      serverId: Type.String({
        minLength: 1,
        description: 'Exact server ID from action "list".',
      }),
      tools: Type.Array(Type.String({ minLength: 1, description }), {
        minItems: 1,
        maxItems: MAX_SUBAGENT_REQUESTED_MCP_TOOLS_PER_SERVER,
      }),
    },
    { additionalProperties: false },
  );
}

function capabilitySchema(
  writeEnabled: boolean,
  mutationsDeclared: boolean,
  shellEnabled: boolean,
  delegationEnabled: boolean,
) {
  const mcpScope = mcpScopeSchema(
    'Exact server-declared read-only tool name listed for this server by action "list".',
  );
  const mutationScope = mcpScopeSchema(
    'Exact mutating tool name listed for this server by action "list". Every call requires attended one-shot approval.',
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
                  "Request foreground workspace-write authority. Implementer uses one run-scoped grant in Ask or implicit Full access; other roles require exact one-shot approval. Changed targets are refused.",
              }),
            ),
          }
        : {}),
      ...(shellEnabled
        ? {
            shell: Type.Optional(
              Type.Boolean({
                description:
                  "Request full-host command execution. Implementer uses one run-scoped grant in Ask or implicit Full access; other roles require exact Allow once. Commands are not OS-sandboxed or rolled back.",
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
        maxItems: MAX_SUBAGENT_REQUESTED_MCP_SERVERS,
      }),
      ...(mutationsDeclared
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

/** Which optional request fields the declaration carries; settings, not inventories. */
export interface SubagentToolDeclarationOptions {
  /** Declare `mcpMutations`. Defaults to whether any mutating tool is requestable. */
  mcpMutationsDeclared?: boolean;
  /** Declare per-task `model` and `effort`. Defaults to whether a model choice exists. */
  modelChoiceDeclared?: boolean;
}

/** What the `list` action returns: the live inventories the description no longer carries. */
export function subagentToolInventory(
  mcpInventory: readonly SubagentRequestableMcpInventoryV2[],
  mcpMutationInventory: readonly SubagentRequestableMcpInventoryV2[],
  modelOptions: SubagentModelToolOptions | undefined,
) {
  const models = modelOptions?.models ?? [];
  return {
    status: "listed" as const,
    mcp: mcpInventory.map(({ serverId, tools }) => ({ serverId, tools: [...tools] })),
    mcpMutations: mcpMutationInventory.map(({ serverId, tools }) => ({ serverId, tools: [...tools] })),
    ...(models.length > 0 ? { currentModel: subagentModelKey(models[0]!) } : {}),
    models: models.map((model) => ({
      model: subagentModelKey(model),
      label: model.modelLabel,
      provider: model.providerLabel,
    })),
    efforts: modelOptions ? [...modelOptions.efforts] : [],
  };
}

export function createSubagentTool(
  supervisor: Pick<SubagentSupervisor, "execute">,
  mcpInventory: readonly SubagentRequestableMcpInventoryV2[] = [],
  writeEnabled = false,
  mcpMutationInventory: readonly SubagentRequestableMcpInventoryV2[] = [],
  shellEnabled = false,
  delegationEnabled = false,
  modelOptions?: SubagentModelToolOptions,
  declaration: SubagentToolDeclarationOptions = {},
): AgentTool {
  const mutationsDeclared = declaration.mcpMutationsDeclared ?? mcpMutationInventory.length > 0;
  const modelChoiceDeclared = declaration.modelChoiceDeclared ?? modelOptions !== undefined;
  const capabilities = capabilitySchema(
    writeEnabled,
    mutationsDeclared,
    shellEnabled,
    delegationEnabled,
  );
  const writeDescription = writeEnabled
    ? "Workspace-write is a positive foreground authority request; implementer uses a run grant while other roles require exact one-shot owner approval. Only write_file/edit_file calls are exposed. "
    : "";
  const shellDescription = shellEnabled
    ? "Shell is a positive full-host execution request: implementer uses a run grant while other roles require exact Allow once. Commands use only a minimal environment, are not OS-sandboxed or rolled back, may use arbitrary network access, and deliberately detached processes may survive cancellation. "
    : "";
  // Implementer exists only to write or run commands. When neither lane can
  // be requested (flags off, read-only turn, or V1 rollback), do not advertise
  // a coding role whose child would silently receive read tools only.
  const implementerAvailable = writeEnabled || shellEnabled;
  const roles = implementerAvailable
    ? ["scout", "planner", "reviewer", "implementer"]
    : ["scout", "planner", "reviewer"];
  const roleDescription = implementerAvailable
    ? "Delegate 1–4 bounded tasks to scout, planner, reviewer, or implementer agents. Omitted task capabilities use role defaults: scout/planner/reviewer read-only; implementer requests workspace writes and shell, with no web, MCP, or nesting. When the batch root is omitted, Aiden infers only their exact union. Full workspace permission authorizes implementer writes and shell for the run; Ask requests one separate grant per lane on first use. All requests remain within parent authority and rollout flags."
    : "Delegate 1–4 bounded tasks to scout, planner, or reviewer agents. Omitted task capabilities use read-only role defaults. When the batch root is omitted, Aiden infers only their exact union. The implementer role is unavailable for this response because neither workspace writes nor shell can be requested.";
  const delegationDescription = delegationEnabled
    ? "Delegation is a positive foreground request. A permitted depth-1 child may launch one bounded depth-2 batch with fresh context by default or an explicit immutable user-visible fork; depth-2 children cannot delegate. "
    : "";
  const modelDescription = modelChoiceDeclared
    ? 'Omit model and effort unless the user asks for a specific model or reasoning effort; children inherit the current model by default. Action "list" returns the requestable models and efforts; when it lists none, omit both. A different model starts at its own default effort. An unsupported model or effort fails the batch. Model choice never changes a child\'s permissions or approvals. '
    : "";
  const taskFields = modelChoiceDeclared
    ? "role, label, task, optional maxTurns, optional narrower capabilities, optional model, and optional effort"
    : "role, label, task, optional maxTurns, and optional narrower capabilities";
  return {
    name: "subagent",
    label: "Delegate to Subagents",
    description: `${roleDescription} ${writeDescription}${shellDescription}${delegationDescription}Web and server-declared read-only MCP capabilities are requests, not grants; each exact egress call pauses for owner approval, and the configured server controls the actual effect. Mutating MCP is a separate positive request: every exact call pauses for one-shot owner approval, the configured server controls the effect, rollback is unavailable, and Aiden never retries automatically. When supplied, task capabilities may only narrow their matching root lane. Call with action "list" to see the requestable read-only and mutating MCP tools before requesting any. Context is fresh by default; request a bounded conversation fork only when persisted user-visible decisions or attachments are required. Timing, deadlines, and run IDs are host-owned. A read-only task may request maxTurns up to 128; omission keeps 24 turns. Never send execution, deadline, or other budget fields. Each task contains ${taskFields}. ${modelDescription}Use for parallel evidence gathering, comparison, planning, implementation, or fresh review. You must reconcile their ordered results and write the final synthesis. ${SUBAGENT_PARENT_SECURITY_GUIDANCE}`,
    parameters: Type.Object(
      {
        action: Type.Optional(
          Type.String({
            enum: ["run", "list"],
            description:
              '"list" returns the requestable MCP tools, models and efforts and launches nothing; "run" (the default) launches the tasks.',
          }),
        ),
        context: Type.Optional(
          Type.String({
            enum: ["fresh", "fork"],
            description:
              "Use fresh by default. Use fork only when the task depends on decisions or user-visible attachments in this persisted conversation.",
          }),
        ),
        capabilities: Type.Optional(capabilities),
        tasks: Type.Optional(Type.Array(
          Type.Object(
            {
              // A flat enum is more reliably followed by OpenAI-compatible
              // providers than TypeBox's equivalent `anyOf` + `const` union.
              // `parseSubagentToolRequest` still independently enforces the
              // exact role allowlist before any child can launch.
              role: Type.String({
                enum: roles,
                description: `Exactly one of: ${roles.join(", ")}.`,
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
              maxTurns: Type.Optional(Type.Integer({
                minimum: 1,
                maximum: MAX_SUBAGENT_REQUESTED_TURNS,
                description: "Read-only investigation turn budget; default 24. Other host limits still apply.",
              })),
              capabilities: Type.Optional(capabilities),
              // Free strings: the requestable models and the effort ceiling
              // come from action "list". `parseSubagentToolRequest` checks
              // the shape and the child model resolver refuses any model or
              // effort outside the live policy before a child launches.
              ...(modelChoiceDeclared
                ? {
                    model: Type.Optional(Type.String({
                      minLength: 1,
                      description: 'Only when the user asks for a specific model: a model value from action "list". Omit to inherit the current model.',
                    })),
                    effort: Type.Optional(Type.String({
                      enum: [...GENERATION_THINKING_LEVELS],
                      description: 'Only when the user asks for a reasoning effort, within the efforts action "list" returns. Omit to use the chosen model\'s default.',
                    })),
                  }
                : {}),
            },
            { additionalProperties: false },
          ),
          {
            minItems: 1,
            maxItems: MAX_SUBAGENT_TASKS_PER_CALL,
            description: "Required to delegate; omit with action \"list\".",
          },
        )),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      if (isRecord(params) && params.action === "list") {
        // Reads host inventories only; nothing launches.
        return textResult(
          JSON.stringify(subagentToolInventory(mcpInventory, mcpMutationInventory, modelOptions)),
        );
      }
      return textResult(await supervisor.execute(params, signal));
    },
  };
}
