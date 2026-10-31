// Follow-through contract shared by main and the renderer: what a chat has
// going on after a reply ends. Background jobs keep running, a pull request is
// followed until its checks pass, and a "done when" check reruns after each
// answer. Main owns all three; the renderer lists them and can stop each one.

import type { BackgroundJobView } from "./background-jobs.js";

export const FOLLOW_THROUGH_VERSION = 1;

/** Updates one followed pull request may send to the chat. */
export const MAX_PULL_REQUEST_FOLLOW_NOTICES = 10;
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
  /** Checks kept failing for an hour after the agent heard about them. */
  | "failing"
  | "notice-limit"
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

export type DoneWhenCheckState =
  /** Runs after the next answer. */
  | "waiting"
  | "running"
  | "passed"
  /** Still failing after the last allowed check. */
  | "gave-up";

export interface DoneWhenCheckView {
  command: string;
  state: DoneWhenCheckState;
  checksRun: number;
  setAt: number;
  lastRunAt?: number;
  lastExitCode?: number | null;
  /** The last run hit its 10-minute limit. */
  lastTimedOut?: boolean;
}

export interface ChatFollowThroughV1 {
  version: 1;
  chatId: string;
  jobs: BackgroundJobView[];
  pullRequests: PullRequestFollowView[];
  check: DoneWhenCheckView | null;
}

export function emptyChatFollowThrough(chatId: string): ChatFollowThroughV1 {
  return { version: 1, chatId, jobs: [], pullRequests: [], check: null };
}

/** True when anything is running, followed or checked, so the composer shows chips. */
export function hasActiveFollowThrough(state: ChatFollowThroughV1 | null | undefined): boolean {
  if (!state) return false;
  return (
    state.jobs.some((job) => job.state === "running") ||
    state.pullRequests.some((follow) => follow.state === "following") ||
    Boolean(state.check && (state.check.state === "waiting" || state.check.state === "running"))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const check =
    isRecord(value.check) && typeof value.check.command === "string" && typeof value.check.state === "string"
      ? (value.check as unknown as DoneWhenCheckView)
      : null;
  return { version: 1, chatId: value.chatId, jobs, pullRequests, check };
}

/** The "done when" command from `/until <command>`; empty when none was given. */
export function parseUntilCommand(text: string): string {
  return text.replace(/^\s*\/until\b/u, "").trim();
}
