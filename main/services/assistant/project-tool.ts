import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Workspace } from "../types.js";

export const LIST_PROJECTS_TOOL_NAME = "list_projects";

export interface AssistantProjectToolDependencies {
  listWorkspaces(): Promise<Workspace[]>;
}

const defaultDependencies: AssistantProjectToolDependencies = {
  listWorkspaces: async () => (await import("../config-store.js")).configStore.listWorkspaces(),
};

function result(value: unknown): AgentToolResult<null> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: null,
  };
}

/**
 * Lists only project identities that can back a scheduled automation. Folder
 * paths and repository state stay private; Aiden needs only a trusted name/id
 * pair to bind the user's approval.
 */
export function createAssistantProjectTool(
  dependencies: AssistantProjectToolDependencies = defaultDependencies,
): AgentTool {
  return {
    name: LIST_PROJECTS_TOOL_NAME,
    label: "Projects",
    description:
      "List folder-backed projects that are eligible for an Aiden automation. Use the exact returned project ID with schedule_task or edit_automation. This does not read project files or status.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, rawParams, signal): Promise<AgentToolResult<null>> => {
      if (
        rawParams &&
        typeof rawParams === "object" &&
        !Array.isArray(rawParams) &&
        Object.keys(rawParams as Record<string, unknown>).length > 0
      ) {
        throw new Error("list_projects does not accept arguments.");
      }
      if (signal?.aborted) throw new Error("Project listing was cancelled.");
      const projects = (await dependencies.listWorkspaces())
        .filter((workspace) => workspace.folderPath && workspace.permission !== "none")
        .map((workspace) => ({ id: workspace.id, name: workspace.name }));
      if (signal?.aborted) throw new Error("Project listing was cancelled.");
      return result({ projects });
    },
  };
}
