/**
 * The goal state machine. Pure: callers pass the time, the boot id and what
 * the last round did, and get the next record plus what to do next. Main
 * persists the record and runs rounds and reviews.
 *
 * - Every transition bumps `revision`. System writes (a review's verdict, a
 *   check's result, a pre-check pause) are compare-and-set on `{id, revision}`,
 *   so a stale review never overwrites the person's pause or clear, which
 *   apply to whatever goal is current.
 * - A reviewed goal runs up to `maxRounds` (50) rounds; a command goal
 *   (`check`) runs up to 5 checks and has no reviewer and no stalls. Keep going
 *   (resume) starts again at round 1 with stalls at 0 and the same limit.
 * - A stall is the reviewer repeating its last `continue` reason, or a round
 *   with no tool calls that wrote no substantial new text. Three in a row pause.
 */
import {
  GOAL_CHECK_MAX_ROUNDS,
  GOAL_MAX_ROUNDS,
  GOAL_MAX_STALLS,
  GOAL_MAX_UNUSABLE_REVIEWS,
  GOAL_SUBSTANTIAL_TEXT_CHARS,
  GOAL_VERSION,
  GOAL_WAIT_LIMIT_MS,
  validateGoalObjective,
  type GoalCause,
  type GoalCheck,
  type GoalRecordV1,
  type GoalSource,
} from "../../../renderer/shared/goal.js";
import type { GoalVerdict } from "./goal-verdict.js";

export interface GoalRef {
  id: string;
  revision: number;
}

export type GoalCreateResult = { ok: true; goal: GoalRecordV1 } | { ok: false; message: string };

export function createGoal(input: {
  id: string;
  chatId: string;
  objective: string;
  source: GoalSource;
  boot: string;
  now: number;
  check?: GoalCheck;
}): GoalCreateResult {
  const objective = validateGoalObjective(input.objective);
  if (objective.kind === "invalid") return { ok: false, message: objective.message };
  return {
    ok: true,
    goal: {
      version: GOAL_VERSION,
      id: input.id,
      chatId: input.chatId,
      objective: objective.objective,
      status: "active",
      rounds: 1,
      maxRounds: input.check ? GOAL_CHECK_MAX_ROUNDS : GOAL_MAX_ROUNDS,
      stalls: 0,
      source: input.source,
      setAt: input.now,
      updatedAt: input.now,
      revision: 1,
      boot: input.boot,
      ...(input.check ? { check: { command: input.check.command } } : {}),
      unusableReviews: 0,
    },
  };
}

/** What the goal bar and `/goal` say for each cause. */
export function goalCauseText(cause: GoalCause, goal: Pick<GoalRecordV1, "maxRounds" | "check">): string {
  switch (cause) {
    case "person":
      return "Paused";
    case "asked":
      return "You asked to stop";
    case "stopped":
      return "You pressed Stop";
    case "restart":
      return "Aiden restarted";
    case "failed":
      return "The last answer failed";
    case "round-limit":
      return goal.check
        ? `Check still failing after ${goal.maxRounds} checks`
        : `Reached the limit of ${goal.maxRounds} rounds`;
    case "stalled":
      return "Not making progress";
    case "reviewer":
      return "Couldn't tell whether the goal is done";
    case "wait-limit":
      return "Waited 30 minutes for background work";
    case "spending":
      return "Reached this chat's spending limit";
    case "access-changed":
      return "This chat's folder access changed";
    case "chat-closed":
      return "The chat was closed";
    case "done":
      return "Done";
    case "blocked":
      return "Needs you";
  }
}

function write(goal: GoalRecordV1, now: number, change: Partial<GoalRecordV1>): GoalRecordV1 {
  return { ...goal, ...change, updatedAt: now, revision: goal.revision + 1 };
}

function stop(
  goal: GoalRecordV1,
  now: number,
  status: "paused" | "needs-you" | "done",
  cause: GoalCause,
  reason?: string,
): GoalRecordV1 {
  const next = write(goal, now, { status, cause, reason: reason ?? goalCauseText(cause, goal) });
  delete next.waitingSince;
  return next;
}

/** Pauses an active goal. Anything else is returned unchanged. */
export function pauseGoal(goal: GoalRecordV1, input: { now: number; cause: GoalCause; reason?: string }): GoalRecordV1 {
  if (goal.status !== "active") return goal;
  return stop(goal, input.now, "paused", input.cause, input.reason);
}

/**
 * Keep going / Resume: back to active at round 1 with no stalls, the same
 * limit, and this process's boot id. An active goal is returned unchanged.
 */
export function resumeGoal(goal: GoalRecordV1, input: { now: number; boot: string }): GoalRecordV1 {
  if (goal.status === "active") return goal;
  const next = write(goal, input.now, {
    status: "active",
    rounds: 1,
    stalls: 0,
    unusableReviews: 0,
    boot: input.boot,
  });
  delete next.cause;
  delete next.reason;
  delete next.lastContinueReason;
  delete next.waitingSince;
  return next;
}

/** On load: a goal left active by another Aiden process comes back paused. */
export function restoreGoal(goal: GoalRecordV1, input: { now: number; boot: string }): GoalRecordV1 {
  if (goal.status !== "active" || goal.boot === input.boot) return goal;
  return stop(goal, input.now, "paused", "restart");
}

/** Applies a system write only if the goal is still the one it read. */
export function compareAndSetGoal(
  current: GoalRecordV1 | undefined,
  expected: GoalRef,
  update: (goal: GoalRecordV1) => GoalRecordV1,
): { ok: true; goal: GoalRecordV1 } | { ok: false } {
  if (!current || current.id !== expected.id || current.revision !== expected.revision) return { ok: false };
  return { ok: true, goal: update(current) };
}

export interface GoalSettleInput {
  now: number;
  boot: string;
  /** The person pressed Stop during the run. */
  stopped: boolean;
  /** The run that settled ended in an error. */
  lastRunFailed: boolean;
  /** The chat's own helper is still running: its report wakes the chat later. */
  helperRunning: boolean;
}

export type GoalSettleStep =
  /** Not active: nothing to do. */
  | { kind: "idle" }
  | { kind: "paused"; goal: GoalRecordV1 }
  /** Skip this review; a later settle runs the loop again. */
  | { kind: "skip"; goal: GoalRecordV1 }
  | { kind: "review" }
  /** A command goal: run its check instead of a review. */
  | { kind: "check"; command: string };

/** The checks before a review, after a run settles with nothing owed. */
export function goalAfterSettle(goal: GoalRecordV1, input: GoalSettleInput): GoalSettleStep {
  if (goal.status !== "active") return { kind: "idle" };
  if (goal.boot !== input.boot) return { kind: "paused", goal: stop(goal, input.now, "paused", "restart") };
  if (input.stopped) return { kind: "paused", goal: stop(goal, input.now, "paused", "stopped") };
  if (input.lastRunFailed) return { kind: "paused", goal: stop(goal, input.now, "paused", "failed") };
  if (goal.rounds > goal.maxRounds) return { kind: "paused", goal: stop(goal, input.now, "paused", "round-limit") };
  if (input.helperRunning) {
    if (goal.waitingSince === undefined) return { kind: "skip", goal: write(goal, input.now, { waitingSince: input.now }) };
    if (input.now - goal.waitingSince >= GOAL_WAIT_LIMIT_MS) {
      return { kind: "paused", goal: stop(goal, input.now, "paused", "wait-limit") };
    }
    return { kind: "skip", goal };
  }
  return goal.check ? { kind: "check", command: goal.check.command } : { kind: "review" };
}

/** Pauses a goal whose `wait` (or running helper) has held it for 30 minutes. */
export function goalWaitExpired(goal: GoalRecordV1, now: number): GoalRecordV1 | undefined {
  if (goal.status !== "active" || goal.waitingSince === undefined) return undefined;
  return now - goal.waitingSince >= GOAL_WAIT_LIMIT_MS ? stop(goal, now, "paused", "wait-limit") : undefined;
}

export interface GoalRoundActivity {
  /** Tool calls the round made. */
  toolCalls: number;
  /** Characters of new answer text the round wrote. */
  newTextChars: number;
}

export type GoalNext =
  /** Start the next round (its number is `goal.rounds`). */
  | "round"
  /** The answer was unusable: ask the reviewer once more. */
  | "retry-review"
  /** Stay active until the background jobs report. */
  | "wait"
  /** Done, Needs you or paused. */
  | "settled";

export interface GoalStep {
  goal: GoalRecordV1;
  next: GoalNext;
}

/**
 * Applies the reviewer's verdict, or `undefined` for an unusable answer (prose,
 * a tool call, a timeout, `wait` with nothing running).
 */
export function applyGoalVerdict(
  goal: GoalRecordV1,
  verdict: GoalVerdict | undefined,
  round: GoalRoundActivity,
  now: number,
): GoalStep {
  if (goal.status !== "active") return { goal, next: "settled" };
  if (!verdict) {
    const unusableReviews = goal.unusableReviews + 1;
    if (unusableReviews >= GOAL_MAX_UNUSABLE_REVIEWS) {
      return { goal: stop({ ...goal, unusableReviews }, now, "paused", "reviewer"), next: "settled" };
    }
    return { goal: write(goal, now, { unusableReviews }), next: "retry-review" };
  }
  const reviewed = { ...goal, unusableReviews: 0 };
  switch (verdict.verdict) {
    case "done":
      return { goal: stop(reviewed, now, "done", "done", verdict.reason), next: "settled" };
    case "blocked":
      return { goal: stop(reviewed, now, "needs-you", "blocked", verdict.reason), next: "settled" };
    case "paused":
      return { goal: stop(reviewed, now, "paused", "asked", verdict.reason), next: "settled" };
    case "wait": {
      const waitingSince = goal.waitingSince ?? now;
      if (now - waitingSince >= GOAL_WAIT_LIMIT_MS) {
        return { goal: stop(reviewed, now, "paused", "wait-limit"), next: "settled" };
      }
      return { goal: write(reviewed, now, { waitingSince, reason: verdict.reason }), next: "wait" };
    }
    case "continue":
      return continueGoal(reviewed, verdict.reason, round, now);
  }
}

function continueGoal(goal: GoalRecordV1, reason: string, round: GoalRoundActivity, now: number): GoalStep {
  const repeated = goal.lastContinueReason !== undefined && sameReason(goal.lastContinueReason, reason);
  const quiet = round.toolCalls === 0 && round.newTextChars < GOAL_SUBSTANTIAL_TEXT_CHARS;
  const stalls = repeated || quiet ? goal.stalls + 1 : 0;
  const base = { ...goal, stalls, lastContinueReason: reason };
  if (stalls >= GOAL_MAX_STALLS) return { goal: stop(base, now, "paused", "stalled"), next: "settled" };
  if (goal.rounds >= goal.maxRounds) return { goal: stop(base, now, "paused", "round-limit"), next: "settled" };
  const next = write(base, now, { rounds: goal.rounds + 1, reason });
  delete next.waitingSince;
  return { goal: next, next: "round" };
}

/** A command goal's check result: exit code 0 is done; otherwise the next round, up to the limit. */
export function applyGoalCheck(goal: GoalRecordV1, result: { passed: boolean; summary: string }, now: number): GoalStep {
  if (goal.status !== "active" || !goal.check) return { goal, next: "settled" };
  if (result.passed) return { goal: stop(goal, now, "done", "done", result.summary), next: "settled" };
  if (goal.rounds >= goal.maxRounds) return { goal: stop(goal, now, "paused", "round-limit"), next: "settled" };
  return { goal: write(goal, now, { rounds: goal.rounds + 1, reason: result.summary }), next: "round" };
}

function sameReason(left: string, right: string): boolean {
  return normalizeReason(left) === normalizeReason(right);
}

function normalizeReason(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s.!,;:]+/gu, " ")
    .trim();
}
