// Builds a generation's follow-through tools: `background_job` and
// `follow_pull_request`, bound to the chat and its workspace folder.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { agentShellCommandEnvironment } from "../agent-command-environment.js";
import { chatPullRequestService } from "../chat-pull-request-service-main.js";
import { runCommandEnv } from "../coding-tools.js";
import { configStore } from "../config-store.js";
import type { WorkspacePermission } from "../types.js";
import { createBackgroundJobTool } from "./background-job-tool.js";
import { backgroundJobs, pullRequestFollows, resolvePullRequestTarget } from "./follow-through-main.js";
import { createPullRequestFollowTool } from "./pull-request-follow-tool.js";

export interface FollowThroughToolContext {
  chatId: string;
  workspaceId: string;
  folderPath: string;
  permission: WorkspacePermission;
  /** Directory prepended to PATH, read per start (the pinned simulator shim). */
  pathPrefix?: string | (() => string | null | undefined);
  /** Whether this generation is still the chat's current one. */
  isCurrent: () => boolean;
  excludeToolNames?: ReadonlySet<string>;
}

export function createFollowThroughTools(context: FollowThroughToolContext): AgentTool[] {
  const tools: AgentTool[] = [
    createBackgroundJobTool({
      chatId: context.chatId,
      workspaceId: context.workspaceId,
      workspaceRoot: context.folderPath,
      jobs: backgroundJobs,
      env: () => runCommandEnv(context.pathPrefix ? { pathPrefix: context.pathPrefix } : {}, agentShellCommandEnvironment()),
      revalidate: async (signal) => {
        if (!context.isCurrent()) throw new Error("This answer is no longer current.");
        const current = await configStore.getWorkspace(context.workspaceId);
        signal?.throwIfAborted();
        if (
          !current ||
          current.permission === "none" ||
          current.permission !== context.permission ||
          current.folderPath !== context.folderPath
        ) {
          throw new Error("Folder access changed. Start a new answer to run background jobs.");
        }
      },
    }),
    createPullRequestFollowTool({
      chatId: context.chatId,
      resolve: (url) => resolvePullRequestTarget(context.chatId, url, (chatId) => chatPullRequestService.current(chatId)),
      follows: pullRequestFollows,
    }),
  ];
  return tools.filter(({ name }) => !context.excludeToolNames?.has(name));
}
