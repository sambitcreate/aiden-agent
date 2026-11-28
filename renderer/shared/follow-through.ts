// Follow-through contract shared by main and the renderer: what a chat has
// going on after a reply ends. Background jobs keep running, a pull request is
// followed until its checks pass, and a "done when" check reruns after each
// answer, and a check-back the agent promised waits for its minute. Main owns
// all four; the renderer lists them and can stop or cancel each one.

import { isRecord } from "../../main/shared/guards.js";
import type { BackgroundJobView } from "./background-jobs.js";
import { parseCheckBackView, type CheckBackView } from "./check-backs.js";

export const FOLLOW_THROUGH_VERSION = 1;

/**
 * Updates in a row that bring only comments before a follow stops, so a bot
 * that answers every reply can't keep the agent busy forever. News about
 * checks, a conflict or a new commit starts the count again.
 */
export const MAX_COMMENT_ONLY_FOLLOW_UPDATES = 10;
/** Pull requests one chat may follow at once. */
export const MAX_PULL_REQUEST_FOLLOWS_PER_CHAT = 3;
/** Times a "done when" check runs before Aiden stops asking the agent to keep going. */
export const MAX_DONE_WHEN_CHECKS = 5;
export const MAX_DONE_WHEN_COMMAND_CHARS = 1_000;

export type PullRequestFollowEndReason =
  | "merged"
  | "closed"
  /** Nothing new for two weeks. */
  | "quiet"
  /** Saved by older versions: checks kept failing for an hour after the agent heard about them. */
  | "failing"
  /** Saved by older versions: the follow sent its tenth update. */
  | "notice-limit"
  /** Ten updates in a row brought only comments. */
  | "comment-limit"
  | "person"
  | "agent"
  | "access-changed"
  | "unavailable";

export interface PullRequestFollowView {
  host: string;
  /** `owner/name`, lowercase. */
  repository: string;
  number: number;
  url: string;
  title?: string;
  startedAt: number;
  startedBy: "agent" | "person";
  state: "following" | "ended";
  /** One plain line about where the pull request stands, e.g. "2 checks failing". */
  status?: string;
  noticesSent: number;
  endedAt?: number;
  endedReason?: PullRequestFollowEndReason;
  lastCheckedAt?: number;
  /** Why the last GitHub read failed, if it did. */
  problem?: string;
}

/** The states of a `/until` check saved by releases before it became a goal (read only to migrate it). */
export type DoneWhenCheckState =
  /** Runs after the next answer. */
  | "waiting"
  | "running"
  | "passed"
  /** Still failing after the last allowed check. */
  | "gave-up";

export interface ChatFollowThroughV1 {
  version: 1;
  chatId: string;
  jobs: BackgroundJobView[];
  pullRequests: PullRequestFollowView[];
  /** Check-backs still waiting for their minute, soonest first. */
  checkBacks: CheckBackView[];
}

export function emptyChatFollowThrough(chatId: string): ChatFollowThroughV1 {
  return { version: 1, chatId, jobs: [], pullRequests: [], checkBacks: [] };
}

/** True when anything is running, followed or due to check back, so the composer shows chips. */
export function hasActiveFollowThrough(state: ChatFollowThroughV1 | null | undefined): boolean {
  if (!state) return false;
  return (
    state.jobs.some((job) => job.state === "running") ||
    state.pullRequests.some((follow) => follow.state === "following") ||
    state.checkBacks.length > 0
  );
}

/** Shape check for the IPC answer; main builds it, so this guards drift, not attacks. */
export function parseChatFollowThrough(value: unknown): ChatFollowThroughV1 | null {
  if (!isRecord(value) || value.version !== FOLLOW_THROUGH_VERSION || typeof value.chatId !== "string") return null;
  if (!Array.isArray(value.jobs) || !Array.isArray(value.pullRequests)) return null;
  const jobs = value.jobs.filter(
    (job): job is BackgroundJobView =>
      isRecord(job) && typeof job.id === "string" && typeof job.command === "string" && typeof job.state === "string",
  );
  const pullRequests = value.pullRequests.filter(
    (follow): follow is PullRequestFollowView =>
      isRecord(follow) &&
      typeof follow.repository === "string" &&
      typeof follow.number === "number" &&
      typeof follow.url === "string" &&
      (follow.state === "following" || follow.state === "ended"),
  );
  const checkBacks = Array.isArray(value.checkBacks)
    ? value.checkBacks.flatMap((entry) => parseCheckBackView(entry) ?? [])
    : [];
  return { version: 1, chatId: value.chatId, jobs, pullRequests, checkBacks };
}

/** The "done when" command from `/until <command>`; empty when none was given. */
export function parseUntilCommand(text: string): string {
  return text.replace(/^\s*\/until\b/u, "").trim();
}
