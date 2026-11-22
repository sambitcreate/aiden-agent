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
  | "blocked"
  /** A round's approval or question waited 30 minutes with no answer. */
  | "unanswered";

/** Every cause a saved or sent goal may carry; anything else is dropped when read. */
const GOAL_CAUSE_NAMES: Record<GoalCause, true> = {
  person: true,
  asked: true,
  stopped: true,
  restart: true,
  failed: true,
  "round-limit": true,
  stalled: true,
  reviewer: true,
  "wait-limit": true,
  spending: true,
  "access-changed": true,
  "chat-closed": true,
  done: true,
  blocked: true,
  unanswered: true,
};

function isGoalCause(value: unknown): value is GoalCause {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(GOAL_CAUSE_NAMES, value);
}

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
  /**
   * A round without a window had a call refused that needs the chat on screen
   * (the browser, Computer Use, an approval only the window can give). The
   * goal bar offers Continue here; a round started in a window clears it.
   */
  windowWanted?: boolean;
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

/**
 * Whether the keep-going goal loop is switched on. Main refuses to set or
 * resume goals while it is off; kept as the one place to switch it off again.
 */
export function goalLoopEnabled(): boolean {
  return true;
}

/** How many rounds a goal ran when it settled, for analytics: shows how often goals reach 50. */
export const GOAL_ROUND_BUCKETS = ["1", "2-5", "6-10", "11-20", "21-49", "50"] as const;
export type GoalRoundBucket = (typeof GOAL_ROUND_BUCKETS)[number];

export function goalRoundBucket(rounds: number): GoalRoundBucket {
  if (rounds >= 50) return "50";
  if (rounds >= 21) return "21-49";
  if (rounds >= 11) return "11-20";
  if (rounds >= 6) return "6-10";
  if (rounds >= 2) return "2-5";
  return "1";
}

/** What the renderer is told about a chat's goal: the record without its loop bookkeeping. */
export type GoalView = Pick<
  GoalRecordV1,
  "id" | "chatId" | "objective" | "status" | "rounds" | "maxRounds" | "stalls" | "reason" | "cause" | "source" | "setAt" | "updatedAt" | "revision" | "check" | "windowWanted"
>;

export function goalView(goal: GoalRecordV1): GoalView {
  return {
    id: goal.id,
    chatId: goal.chatId,
    objective: goal.objective,
    status: goal.status,
    rounds: goal.rounds,
    maxRounds: goal.maxRounds,
    stalls: goal.stalls,
    ...(goal.reason !== undefined ? { reason: goal.reason } : {}),
    ...(goal.cause !== undefined ? { cause: goal.cause } : {}),
    source: goal.source,
    setAt: goal.setAt,
    updatedAt: goal.updatedAt,
    revision: goal.revision,
    ...(goal.check ? { check: { command: goal.check.command } } : {}),
    ...(goal.windowWanted === true ? { windowWanted: true } : {}),
  };
}

const GOAL_STATUSES: readonly GoalStatus[] = ["active", "paused", "needs-you", "done"];
const GOAL_SOURCES: readonly GoalSource[] = ["slash", "menu", "proposal", "phone", "until"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Reads a goal view from IPC, or null for none; anything malformed is null too. */
export function parseGoalView(value: unknown): GoalView | null {
  if (!isRecord(value)) return null;
  const { id, chatId, objective, status, rounds, maxRounds, stalls, reason, cause, source, setAt, updatedAt, revision, check, windowWanted } = value;
  if (typeof id !== "string" || typeof chatId !== "string" || typeof objective !== "string") return null;
  if (!GOAL_STATUSES.includes(status as GoalStatus) || !GOAL_SOURCES.includes(source as GoalSource)) return null;
  if (![rounds, maxRounds, stalls, setAt, updatedAt, revision].every(count)) return null;
  if (reason !== undefined && typeof reason !== "string") return null;
  if (cause !== undefined && !isGoalCause(cause)) return null;
  // A saved check goes into the round's prompt: it is held to the same rule as a new one.
  let goalCheck: GoalCheck | undefined;
  if (check !== undefined) {
    goalCheck = isRecord(check) && typeof check.command === "string" ? validateGoalCheck(check.command) : undefined;
    if (!goalCheck) return null;
  }
  // The round limit is never above the limit a new goal gets, and at least 1.
  const roundLimit = Math.min(Math.max(maxRounds as number, 1), goalCheck ? GOAL_CHECK_MAX_ROUNDS : GOAL_MAX_ROUNDS);
  return {
    id,
    chatId,
    objective,
    status: status as GoalStatus,
    rounds: rounds as number,
    maxRounds: roundLimit,
    stalls: stalls as number,
    ...(typeof reason === "string" ? { reason } : {}),
    ...(cause !== undefined ? { cause } : {}),
    source: source as GoalSource,
    setAt: setAt as number,
    updatedAt: updatedAt as number,
    revision: revision as number,
    ...(goalCheck ? { check: goalCheck } : {}),
    ...(windowWanted === true ? { windowWanted: true } : {}),
  };
}

/** Restores saved goals; malformed entries are dropped, and a chat keeps only its latest goal. */
export function parseGoalRecords(value: unknown): GoalRecordV1[] {
  if (!Array.isArray(value)) return [];
  const byChat = new Map<string, GoalRecordV1>();
  for (const goal of value.flatMap(parseGoalRecord)) {
    const kept = byChat.get(goal.chatId);
    if (!kept || goal.updatedAt >= kept.updatedAt) byChat.set(goal.chatId, goal);
  }
  return [...byChat.values()];
}

function parseGoalRecord(entry: unknown): GoalRecordV1[] {
  const view = parseGoalView(entry);
  if (!view || !isRecord(entry) || entry.version !== GOAL_VERSION || typeof entry.boot !== "string" || !count(entry.unusableReviews)) return [];
  return [
    {
      ...view,
      version: GOAL_VERSION,
      boot: entry.boot,
      unusableReviews: entry.unusableReviews,
      ...(typeof entry.lastContinueReason === "string" ? { lastContinueReason: entry.lastContinueReason } : {}),
      ...(count(entry.waitingSince) ? { waitingSince: entry.waitingSince } : {}),
    },
  ];
}

/** The agent's tool that suggests a goal: a card with Start and Not now; only the person's Start sets it. */
export const PROPOSE_GOAL_TOOL_NAME = "propose_goal";

/** A goal the agent suggested in the chat, waiting for the person's Start or Not now. */
export interface GoalProposalView {
  chatId: string;
  objective: string;
  proposedAt: number;
}

/** Reads a proposal from IPC, or null for none; anything malformed is null too. */
export function parseGoalProposal(value: unknown): GoalProposalView | null {
  if (!isRecord(value)) return null;
  const { chatId, objective, proposedAt } = value;
  if (typeof chatId !== "string" || !chatId || typeof objective !== "string" || !objective || !count(proposedAt)) return null;
  return { chatId, objective, proposedAt };
}
