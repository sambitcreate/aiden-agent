import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { PiAgentRuntimeExtension } from "../pi-agent-runtime-harness.js";
import type { PiRuntimeEventEnvelope } from "../pi-runtime-events.js";
import { declarePiRuntimeReplay } from "../pi-runtime-tool.js";
import {
  MAX_TODO_DESCRIPTION_BYTES,
  MAX_TODO_LABEL_CODE_POINTS,
  MAX_TODO_SUBJECT_CODE_POINTS,
  MAX_TODO_TASKS,
  TODO_EXTENSION_ID,
  TODO_TOOL_NAME,
  cloneTodoState,
  type TodoParams,
  type TodoState,
  type TodoToolDetailsV1,
} from "./contract.js";
import { applyTodo } from "./reducer.js";

export interface TodoExtensionScope {
  usageSource?: string;
  interactionSurface?: string;
  assistantMode: boolean;
  botBound: boolean;
  rendererOwner: boolean;
  excluded: boolean;
}

export function shouldEnableTodoExtension(scope: TodoExtensionScope): boolean {
  return (
    scope.usageSource === "chat" &&
    scope.interactionSurface !== "telegram" &&
    !scope.assistantMode &&
    !scope.botBound &&
    scope.rendererOwner &&
    !scope.excluded
  );
}

const ActionSchema = Type.Union([
  Type.Literal("create"),
  Type.Literal("update"),
  Type.Literal("list"),
  Type.Literal("get"),
  Type.Literal("delete"),
  Type.Literal("clear"),
]);
const StatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
  Type.Literal("deleted"),
]);
const DependencySchema = Type.Array(Type.Integer({ minimum: 1 }), {
  maxItems: MAX_TODO_TASKS,
  uniqueItems: true,
});

const SYSTEM_PROMPT = [
  "Use the todo tool to track genuinely multi-step work, explicit user checklists, or work whose progress benefits from a durable plan. Skip it for trivial or purely conversational requests.",
  "Keep at most one task in_progress. Mark it in_progress immediately before beginning and completed immediately after verified completion. Never mark partial or failing work completed.",
  "Use blockedBy for dependencies. Create starts pending; completed tasks cannot be reopened; deleted is a tombstone. Use list or get to inspect state after uncertainty.",
].join("\n");

export interface TodoExtensionRuntime {
  extension: PiAgentRuntimeExtension;
  snapshot(): TodoState;
}

export function createTodoExtensionRuntime(
  initialState: TodoState,
  options: { onDurableSnapshot?: (state: TodoState) => void | Promise<void> } = {},
): TodoExtensionRuntime {
  let state = cloneTodoState(initialState);
  const tool: AgentTool = declarePiRuntimeReplay(
    {
      name: TODO_TOOL_NAME,
      label: "Todo",
      description:
        "Manage the durable task list for this chat. Actions: create, update, list, get, delete (tombstone), and clear. Use status pending, in_progress, completed, or deleted; use blockedBy dependencies to sequence work.",
      parameters: Type.Object(
        {
          action: ActionSchema,
          subject: Type.Optional(
            Type.String({ minLength: 1, maxLength: MAX_TODO_SUBJECT_CODE_POINTS * 2 }),
          ),
          description: Type.Optional(Type.String({ maxLength: MAX_TODO_DESCRIPTION_BYTES })),
          activeForm: Type.Optional(Type.String({ maxLength: MAX_TODO_LABEL_CODE_POINTS * 2 })),
          status: Type.Optional(StatusSchema),
          blockedBy: Type.Optional(DependencySchema),
          addBlockedBy: Type.Optional(DependencySchema),
          removeBlockedBy: Type.Optional(DependencySchema),
          owner: Type.Optional(Type.String({ maxLength: MAX_TODO_LABEL_CODE_POINTS * 2 })),
          metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          id: Type.Optional(Type.Integer({ minimum: 1 })),
          includeDeleted: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      execute: async (
        _toolCallId,
        parameters,
        signal,
      ): Promise<AgentToolResult<TodoToolDetailsV1>> => {
        if (signal?.aborted) throw new Error("Todo operation was cancelled.");
        const result = applyTodo(state, parameters as TodoParams);
        state = result.state;
        return { content: [{ type: "text", text: result.content }], details: result.details };
      },
    },
    // State exists only inside this generation until the result is journaled.
    // Re-executing after a crash is therefore safe and cannot duplicate a
    // durable id or overwrite a later durable state.
    "safe",
  );
  const onRuntimeEvent = options.onDurableSnapshot
    ? async (event: PiRuntimeEventEnvelope): Promise<void> => {
        const payload = event.payload;
        if (
          payload.type === "agent_event" &&
          payload.durable &&
          payload.event.type === "message_end" &&
          payload.event.messageRole === "toolResult"
        ) {
          await options.onDurableSnapshot?.(cloneTodoState(state));
        }
      }
    : undefined;
  return {
    extension: {
      id: TODO_EXTENSION_ID,
      systemPrompt: SYSTEM_PROMPT,
      tools: [tool],
      ...(onRuntimeEvent ? { onRuntimeEvent } : {}),
    },
    snapshot: () => cloneTodoState(state),
  };
}

export function createTodoExtension(
  initialState: TodoState,
  options: { onDurableSnapshot?: (state: TodoState) => void | Promise<void> } = {},
): PiAgentRuntimeExtension {
  return createTodoExtensionRuntime(initialState, options).extension;
}
