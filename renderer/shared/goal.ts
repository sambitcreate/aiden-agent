// Keep-going goals, shared by main and the renderer: a chat keeps working,
// round after round, until its own model judges the objective done, the person
// is needed, or a limit pauses it. Main owns the record and the loop; the
// renderer shows the goal bar and sends the person's actions.

import { MAX_DONE_WHEN_CHECKS, MAX_DONE_WHEN_COMMAND_CHARS } from "./follow-through.js";

export const GOAL_VERSION = 1;
export const MAX_GOAL_OBJECTIVE_CHARS = 2_000;
/** Rounds a reviewed goal runs before it pauses. Keep going starts again at round 1. */
export const GOAL_MAX_ROUNDS = 50;
/** Checks a command goal (`/until`) runs before it pauses: each is a full round plus the command. */
export const GOAL_CHECK_MAX_ROUNDS = MAX_DONE_WHEN_CHECKS;
/** Rounds in a row without progress before a goal pauses. */
export const GOAL_MAX_STALLS = 3;
/** Unusable reviewer answers in a row before a goal pauses. */
export const GOAL_MAX_UNUSABLE_REVIEWS = 2;
/** The longest a `wait` verdict (or a running helper) holds a goal before it pauses. */
export const GOAL_WAIT_LIMIT_MS = 30 * 60_000;
/** How long the chat must stay idle after a run settles before a review starts. */
export const GOAL_SETTLE_DELAY_MS = 1_500;
/**
 * New answer text, in characters, that counts as progress in a round with no
 * tool calls, so writing goals (a plan, a report) are not paused as stalls.
 */
export const GOAL_SUBSTANTIAL_TEXT_CHARS = 600;
/** The longest reviewer reason kept on the goal. */
export const GOAL_REASON_MAX_CHARS = 300;

export type GoalStatus = "active" | "paused" | "needs-you" | "done";

export type GoalSource = "slash" | "menu" | "proposal" | "phone" | "until";

/** Why a goal last stopped being active, when the system (or the person) stopped it. */
export type GoalCause =
  /** The person pressed Pause, or `/goal pause`. */
  | "person"
  /** The reviewer read the person's latest message as asking to stop. */
  | "asked"
  /** The person pressed Stop in the chat. */
  | "stopped"
  /** Aiden restarted while the goal was active. */
  | "restart"
  /** The last answer failed. */
  | "failed"
  | "round-limit"
  | "stalled"
  /** The reviewer gave no usable verdict twice in a row. */
  | "reviewer"
  | "wait-limit"
  | "spending"
  /** The chat's folder access changed. */
  | "access-changed"
  | "chat-closed"
  /** The reviewer judged the objective done, or the check command passed. */
  | "done"
  /** The reviewer said the person is needed. */
  | "blocked";

export interface GoalCheck {
  /** A shell command; exit code 0 means done. No reviewer runs. */
  command: string;
}

export interface GoalRecordV1 {
  version: typeof GOAL_VERSION;
  id: string;
  chatId: string;
  objective: string;
  status: GoalStatus;
  /** The round in progress, from 1. */
  rounds: number;
  maxRounds: number;
  /** Rounds in a row without progress. */
  stalls: number;
  /** The latest reason shown to the person: the reviewer's, or why the goal paused. */
  reason?: string;
  cause?: GoalCause;
  source: GoalSource;
  setAt: number;
  updatedAt: number;
  /** Bumped by every write, for compare-and-set. */
  revision: number;
  /** The Aiden process that last made the goal active. */
  boot: string;
  check?: GoalCheck;
  /** The reviewer's reason on its last `continue`, which a stall repeats. */
  lastContinueReason?: string;
  /** Unusable reviewer answers in a row. */
  unusableReviews: number;
  /** Since when a `wait` verdict or a running helper has held the goal. */
  waitingSince?: number;
}

export type GoalCommand =
  | { kind: "set"; objective: string }
  | { kind: "show" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "invalid"; message: string };

/**
 * Reads a composer message as a `/goal` command, or undefined when it is not
 * one. `/goal pause|resume|clear` are actions; any other text is an objective.
 */
export function parseGoalCommand(text: string): GoalCommand | undefined {
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match) return undefined;
  const rest = (match[1] ?? "").trim();
  if (!rest) return { kind: "show" };
  const action = rest.toLowerCase();
  if (action === "pause" || action === "resume" || action === "clear") return { kind: action };
  return validateGoalObjective(rest);
}

export function validateGoalObjective(value: string): { kind: "set"; objective: string } | { kind: "invalid"; message: string } {
  const objective = value.trim();
  if (!objective) return { kind: "invalid", message: "Say what the goal is." };
  if ([...objective].length > MAX_GOAL_OBJECTIVE_CHARS) {
    return { kind: "invalid", message: `A goal can be up to ${MAX_GOAL_OBJECTIVE_CHARS.toLocaleString("en-US")} characters.` };
  }
  return { kind: "set", objective };
}

export function validateGoalCheck(command: string): GoalCheck | undefined {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > MAX_DONE_WHEN_COMMAND_CHARS || /[\r\n\0]/u.test(trimmed)) return undefined;
  return { command: trimmed };
}

/** The goal bar's progress line for an active goal, e.g. "round 3 of 50". */
export function goalRoundLabel(goal: Pick<GoalRecordV1, "rounds" | "maxRounds" | "check">): string {
  return goal.check ? `check ${goal.rounds} of ${goal.maxRounds}` : `round ${goal.rounds} of ${goal.maxRounds}`;
}
