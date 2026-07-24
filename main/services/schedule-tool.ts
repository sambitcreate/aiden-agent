import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { assertSafeScheduledPrompt, recommendedScheduledPermission } from "./schedule-guard.js";
import type {
  ScheduledRun,
  ScheduledTask,
  ScheduledTaskInput,
  Workspace,
} from "./types.js";

export const SCHEDULE_TOOL_NAME = "schedule_task";

type ScheduleToolAction = "create" | "list" | "pause" | "resume" | "remove" | "run_now";

interface ScheduleToolParams {
  action: ScheduleToolAction;
  id?: string;
  name?: string;
  cron?: string;
  timezone?: string;
  mode?: "llm" | "script";
  prompt?: string;
  script?: string;
  workspaceId?: string;
  permission?: "read-only" | "full";
  notify?: boolean;
}

export interface ScheduleToolDependencies {
  list(): Promise<ScheduledTask[]>;
  save(input: ScheduledTaskInput): Promise<ScheduledTask>;
  pause(id: string): Promise<ScheduledTask>;
  resume(id: string): Promise<ScheduledTask>;
  remove(id: string): Promise<void>;
  runNow(id: string): Promise<ScheduledRun>;
  getWorkspace(id: string): Promise<Workspace | undefined>;
  validateScript(input: { script: string; workspaceRoot?: string }): Promise<string>;
}

const defaultDependencies: ScheduleToolDependencies = {
  list: async () => (await import("./schedule-store.js")).scheduleStore.list(),
  save: async (input) => (await import("./schedule-service.js")).scheduleService.save(input),
  pause: async (id) => (await import("./schedule-service.js")).scheduleService.pause(id),
  resume: async (id) => (await import("./schedule-service.js")).scheduleService.resume(id),
  remove: async (id) => (await import("./schedule-service.js")).scheduleService.remove(id),
  runNow: async (id) => (await import("./schedule-service.js")).scheduleService.runNow(id),
  getWorkspace: async (id) => (await import("./config-store.js")).configStore.getWorkspace(id),
  validateScript: async (input) =>
    (await import("./schedule-script.js")).resolveScheduledScript(input),
};

function result(value: unknown): AgentToolResult<null> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: null,
  };
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required for this action.`);
  return normalized;
}

function taskSummary(task: ScheduledTask) {
  return {
    id: task.id,
    name: task.name,
    enabled: task.enabled,
    mode: task.mode,
    cron: task.cron,
    timezone: task.timezone,
    workspaceId: task.workspaceId,
    permission: task.permission,
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    lastResult: task.lastResult,
  };
}

async function workspaceFor(
  workspaceId: string | undefined,
  dependencies: ScheduleToolDependencies,
): Promise<Workspace | undefined> {
  if (!workspaceId) return undefined;
  const workspace = await dependencies.getWorkspace(workspaceId);
  if (!workspace) throw new Error(`Workspace ${workspaceId} was not found.`);
  if (workspace.permission === "none") {
    throw new Error(`Workspace ${workspaceId} has No Access.`);
  }
  return workspace;
}

export function createScheduleTaskTool(
  context: { workspaceId?: string } = {},
  dependencies: ScheduleToolDependencies = defaultDependencies,
): AgentTool {
  return {
    name: SCHEDULE_TOOL_NAME,
    label: "Scheduled Tasks",
    description:
      "Manage Aiden scheduled tasks. Actions: create, list, pause, resume, remove, run_now. List tasks before mutating when an ID is uncertain. Create requires name and cron plus prompt for llm mode or script for script mode. Tasks default to read-only; use full only when the task clearly needs unattended writes or commands. Scheduled runs cannot call this tool.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("list"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("remove"),
        Type.Literal("run_now"),
      ]),
      id: Type.Optional(Type.String({ description: "Exact task ID for pause, resume, remove, or run_now." })),
      name: Type.Optional(Type.String({ description: "Task name. Required for create." })),
      cron: Type.Optional(Type.String({ description: "Five- or six-part cron expression. Required for create." })),
      timezone: Type.Optional(Type.String({ description: "IANA timezone. Defaults to the device timezone." })),
      mode: Type.Optional(
        Type.Union([Type.Literal("llm"), Type.Literal("script")], {
          description: "Execution mode. Defaults to llm.",
        }),
      ),
      prompt: Type.Optional(Type.String({ description: "LLM instruction. Required for llm mode." })),
      script: Type.Optional(
        Type.String({ description: "File name from the workspace or global .aiden/scripts folder." }),
      ),
      workspaceId: Type.Optional(
        Type.String({ description: "Workspace ID. Defaults to the current chat workspace." }),
      ),
      permission: Type.Optional(
        Type.Union([Type.Literal("read-only"), Type.Literal("full")], {
          description: "LLM task permission. Defaults to read-only.",
        }),
      ),
      notify: Type.Optional(Type.Boolean({ description: "Show a macOS notification after non-silent runs." })),
    }),
    execute: async (_toolCallId, rawParams): Promise<AgentToolResult<null>> => {
      const params = rawParams as ScheduleToolParams;
      if (params.action === "list") {
        return result({ tasks: (await dependencies.list()).map(taskSummary) });
      }

      if (params.action === "create") {
        const mode = params.mode ?? "llm";
        const workspaceId = params.workspaceId?.trim() || context.workspaceId;
        const workspace = await workspaceFor(workspaceId, dependencies);
        let prompt: string | undefined;
        let script: string | undefined;
        let recommendation: "read-only" | "full" = "read-only";
        if (mode === "llm") {
          prompt = required(params.prompt, "prompt");
          assertSafeScheduledPrompt(prompt);
          recommendation = recommendedScheduledPermission(prompt);
        } else {
          script = required(params.script, "script");
          await dependencies.validateScript({ script, workspaceRoot: workspace?.folderPath });
        }
        const task = await dependencies.save({
          name: required(params.name, "name"),
          cron: required(params.cron, "cron"),
          timezone: params.timezone,
          mode,
          prompt,
          script,
          workspaceId,
          permission: params.permission ?? "read-only",
          notify: params.notify,
          enabled: true,
        });
        return result({
          task: taskSummary(task),
          permissionRecommendation:
            mode === "llm" && !params.permission && recommendation === "full"
              ? "This prompt appears to need writes or commands. The task remains read-only; ask the user before changing it to full."
              : undefined,
        });
      }

      const id = required(params.id, "id");
      if (params.action === "pause") return result({ task: taskSummary(await dependencies.pause(id)) });
      if (params.action === "resume") return result({ task: taskSummary(await dependencies.resume(id)) });
      if (params.action === "remove") {
        await dependencies.remove(id);
        return result({ removed: id });
      }
      if (params.action === "run_now") return result({ run: await dependencies.runNow(id) });
      throw new Error(`Unsupported schedule action: ${String(params.action)}.`);
    },
  };
}

export function scheduleTaskToolsForContext(context: {
  workspaceId?: string;
  allowScheduling?: boolean;
}): AgentTool[] {
  return context.allowScheduling === false
    ? []
    : [createScheduleTaskTool({ workspaceId: context.workspaceId })];
}
