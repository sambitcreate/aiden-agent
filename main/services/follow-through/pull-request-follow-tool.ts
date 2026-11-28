// The `follow_pull_request` tool: after the agent opens or updates a pull
// request it can follow it, and the chat hears about failed checks (with the
// end of each log), merge conflicts, comments from people who can write to
// the repository and from review bots, and checks passing, until the pull
// request is merged or closed.

import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  MAX_COMMENT_ONLY_FOLLOW_UPDATES,
  type PullRequestFollowView,
} from "../../../renderer/shared/follow-through.js";
import { declarePiRuntimeReplay } from "../pi-runtime-tool.js";
import type { StartFollowInput } from "./pull-request-follows.js";

export const FOLLOW_PULL_REQUEST_TOOL_NAME = "follow_pull_request";

export interface PullRequestFollowToolOptions {
  chatId: string;
  /** A pull request link, or the chat's current pull request when undefined. */
  resolve(
    url: string | undefined,
  ): Promise<{ host: string; repository: string; number: number; url: string; title?: string }>;
  follows: {
    follow(input: StartFollowInput): PullRequestFollowView;
    stop(
      chatId: string,
      key: { host: string; repository: string; number: number },
      reason: "agent",
    ): boolean;
    list(chatId: string): PullRequestFollowView[];
  };
}

function textResult(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null };
}

function describe(follow: PullRequestFollowView): string {
  const state =
    follow.state === "following"
      ? `following${follow.status ? ` · ${follow.status}` : ""} · ${follow.noticesSent} ${follow.noticesSent === 1 ? "update" : "updates"} sent`
      : `stopped${follow.endedReason ? ` (${follow.endedReason})` : ""}`;
  return `#${follow.number} in ${follow.repository} · ${state} · ${follow.url}`;
}

export function createPullRequestFollowTool(options: PullRequestFollowToolOptions): AgentTool {
  const tool: AgentTool = {
    name: FOLLOW_PULL_REQUEST_TOOL_NAME,
    label: "Follow Pull Request",
    description:
      "Follow a GitHub pull request after you open or update it, so you hear about it without checking. " +
      "This chat then gets a message when checks fail (with the end of each failed log), when the branch has a merge conflict, when someone who can write to the repository or a review bot comments or reviews, and once when every check passes; it also notes when the pull request is merged or closed. " +
      `Following ends when it is merged or closed, after two weeks with nothing new, or after ${MAX_COMMENT_ONLY_FOLLOW_UPDATES} updates in a row that bring only comments. ` +
      "When you are seeing work through: follow the pull request after you open or push to it, then end your answer. On each update, check every finding against the code, fix the real ones and push to the same branch, explain the wrong ones instead of changing code for them, and stay brief when nothing is new. You are done once checks pass on the latest commit and no finding is left open; never merge in an answer the person is not watching. " +
      'action "follow" starts (url optional: the chat\'s current pull request), "stop" ends it, "list" shows what this chat follows. Do not poll GitHub yourself while following.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal("follow"), Type.Literal("stop"), Type.Literal("list")]),
      url: Type.Optional(
        Type.String({
          description:
            "The pull request link, e.g. https://github.com/owner/repo/pull/12. Omit for this chat's current pull request.",
        }),
      ),
    }),
    execute: async (_id, params, signal): Promise<AgentToolResult<null>> => {
      signal?.throwIfAborted();
      const { action, url } = params as { action: "follow" | "stop" | "list"; url?: string };
      if (action === "list") {
        const follows = options.follows.list(options.chatId);
        return textResult(
          follows.length
            ? follows.map((follow) => `- ${describe(follow)}`).join("\n")
            : "This chat follows no pull requests.",
        );
      }
      const target = await options.resolve(url?.trim() || undefined);
      signal?.throwIfAborted();
      if (action === "stop") {
        const stopped = options.follows.stop(options.chatId, target, "agent");
        return textResult(
          stopped
            ? `Stopped following #${target.number} in ${target.repository}.`
            : `This chat was not following #${target.number} in ${target.repository}.`,
        );
      }
      const follow = options.follows.follow({
        chatId: options.chatId,
        ...target,
        startedBy: "agent",
      });
      return textResult(
        `Following ${describe(follow)}. You will get a message in this chat when there is something to act on; end your answer when your current work is done.`,
      );
    },
  };
  // Following starts polling and later wakes; never replay it after a crash.
  return declarePiRuntimeReplay(tool, "never");
}
