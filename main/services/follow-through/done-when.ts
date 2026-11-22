// "Done when" checks, now the check of a keep-going goal: `/until npm test`
// sets a goal whose check is that command (docs/keep-going-goals.md). The goal
// loop decides when a check runs (after each round, up to five checks); this
// file runs one check at a time per chat in the chat's workspace folder, turns
// its result into what the next round reads, and moves checks saved by older
// releases into goals.
//
// A check cut off by a quit is never rerun on launch: its goal comes back
// paused like every other goal.

import { fenceAsData, tailText } from "../../../renderer/shared/agent-notices.js";
import { MAX_DONE_WHEN_CHECKS, type DoneWhenCheckState } from "../../../renderer/shared/follow-through.js";
import { GOAL_VERSION, validateGoalCheck, type GoalRecordV1 } from "../../../renderer/shared/goal.js";

export const DONE_WHEN_TIMEOUT_MS = 10 * 60_000;
export const DONE_WHEN_OUTPUT_CHARS = 3_000;

/** A check saved by a release before `/until` became a goal. Read once, on launch, to migrate it. */
export interface DoneWhenRecord {
  version: 1;
  chatId: string;
  workspaceId: string;
  command: string;
  state: DoneWhenCheckState;
  checksRun: number;
  setAt: number;
  lastRunAt?: number;
  lastExitCode?: number | null;
  lastTimedOut?: boolean;
}

/** A process ownership or recovery issue interrupted the check, independently of its command. */
export class CheckInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckInterruptedError";
  }
}

export interface DoneWhenRunResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  output: string;
}

/** What one goal check came to, for the goal loop. */
export type GoalCheckResult =
  /** The command ran to an end. `summary` is one line; `details` is its fenced output for the next round. */
  | { kind: "finished"; passed: boolean; summary: string; details: string }
  /** It was stopped before it ended (the workspace changed, process recovery, access off). */
  | { kind: "stopped"; summary: string };

/** The check's own one line: its exit code, or the 10-minute limit. */
function outcomeLine(result: DoneWhenRunResult): string {
  if (result.timedOut) return "it ran for 10 minutes without finishing";
  return `exit code ${result.exitCode ?? "unknown"}`;
}

/** A run as the goal reads it: passed or not, one line, and the end of its output fenced as data. */
export function goalCheckResult(command: string, result: DoneWhenRunResult): GoalCheckResult {
  if (result.aborted) return { kind: "stopped", summary: `The check \`${command}\` was stopped before it finished` };
  const passed = result.exitCode === 0 && !result.timedOut;
  const { text: tail, truncated } = tailText(result.output.trimEnd(), DONE_WHEN_OUTPUT_CHARS);
  const details = tail.trim()
    ? fenceAsData(truncated ? "End of the check's output" : "The check's output", tail)
    : "The check printed nothing.";
  return {
    kind: "finished",
    passed,
    summary: passed ? `\`${command}\` passed` : `\`${command}\` failed (${outcomeLine(result)})`,
    details,
  };
}

export interface GoalCheckInput {
  chatId: string;
  workspaceId: string;
  command: string;
}

export interface GoalCheckRunnerDeps {
  /** Runs the command in the workspace folder; may throw `CheckInterruptedError`. */
  run(input: GoalCheckInput, signal: AbortSignal): Promise<DoneWhenRunResult>;
  onChange?(chatId: string): void;
}

interface RunningCheck {
  controller: AbortController;
  workspaceId: string;
  settled: Promise<void>;
}

/**
 * Runs goal checks, one per chat at a time. A new check stops the chat's
 * running one first. Workspace changes, a deleted chat and quitting stop
 * running checks; their goals then hear `stopped`.
 */
export class GoalCheckRunner {
  private closed = false;
  private readonly running = new Map<string, RunningCheck>();

  constructor(private readonly deps: GoalCheckRunnerDeps) {}

  /** Chats whose check command is running now (for keep-awake). */
  list(): Array<{ chatId: string; state: "running" }> {
    return [...this.running.keys()].map((chatId) => ({ chatId, state: "running" as const }));
  }

  isRunning(chatId: string): boolean {
    return this.running.has(chatId);
  }

  async run(input: GoalCheckInput, signal: AbortSignal): Promise<GoalCheckResult> {
    if (this.closed) return { kind: "stopped", summary: "Aiden is closing" };
    const previous = this.running.get(input.chatId);
    if (previous) {
      previous.controller.abort();
      await previous.settled;
    }
    const controller = new AbortController();
    const forward = () => controller.abort(signal.reason);
    if (signal.aborted) forward();
    else signal.addEventListener("abort", forward, { once: true });
    let resolve!: () => void;
    const settled = new Promise<void>((done) => {
      resolve = done;
    });
    const entry: RunningCheck = { controller, workspaceId: input.workspaceId, settled };
    this.running.set(input.chatId, entry);
    this.deps.onChange?.(input.chatId);
    try {
      const result = await this.deps.run(input, controller.signal);
      return goalCheckResult(input.command, controller.signal.aborted ? { ...result, aborted: true } : result);
    } catch (error) {
      if (error instanceof CheckInterruptedError) return { kind: "stopped", summary: error.message };
      if (controller.signal.aborted) return goalCheckResult(input.command, { exitCode: null, timedOut: false, aborted: true, output: "" });
      return { kind: "stopped", summary: error instanceof Error ? error.message : String(error) };
    } finally {
      signal.removeEventListener("abort", forward);
      if (this.running.get(input.chatId) === entry) this.running.delete(input.chatId);
      resolve();
      this.deps.onChange?.(input.chatId);
    }
  }

  /** Stops the chat's running check and waits for it. */
  async stopChat(chatId: string): Promise<void> {
    const run = this.running.get(chatId);
    if (!run) return;
    run.controller.abort();
    await run.settled;
  }

  /** Stops every check running in the workspace folder and waits for them. */
  async interruptWorkspace(workspaceId: string): Promise<void> {
    const runs = [...this.running.values()].filter((run) => run.workspaceId === workspaceId);
    for (const run of runs) run.controller.abort();
    await Promise.all(runs.map((run) => run.settled));
  }

  /** Stops every running check, for quit. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const runs = [...this.running.values()];
    for (const run of runs) run.controller.abort();
    await Promise.all(runs.map((run) => run.settled));
  }
}

/** The objective of a goal set with `/until <command>`. */
export function untilGoalObjective(command: string): string {
  return `Keep going until ${command} passes`;
}

/**
 * Checks saved by a release before `/until` became a goal, as goals. A check
 * still waiting or running becomes a paused goal (nothing restarts by itself
 * after an update), keeping the checks it had used. Passed and given-up
 * checks are finished and are dropped, as is a check whose chat already has
 * a goal, a command a new `/until` would refuse, and a chat that can't have a
 * goal (`eligible` false). A check whose chat couldn't be read (`eligible`
 * undefined) is kept as it was, in `kept`, for the next launch to try again.
 */
export function migrateDoneWhenRecords(
  records: readonly unknown[],
  goals: readonly GoalRecordV1[],
  make: { now: number; newId: () => string; eligible: (chatId: string) => boolean | undefined },
): { goals: GoalRecordV1[]; kept: unknown[] } {
  const taken = new Set(goals.map((goal) => goal.chatId));
  const migrated: GoalRecordV1[] = [];
  const kept: unknown[] = [];
  for (const entry of records) {
    const record = entry as Partial<DoneWhenRecord> | null;
    if (record?.version !== 1 || typeof record.chatId !== "string" || typeof record.command !== "string") continue;
    if (record.state !== "waiting" && record.state !== "running") continue;
    const command = validateGoalCheck(record.command)?.command;
    if (!command || taken.has(record.chatId)) continue;
    const eligible = make.eligible(record.chatId);
    if (eligible === undefined) {
      kept.push(entry);
      continue;
    }
    if (!eligible) continue;
    taken.add(record.chatId);
    const used = typeof record.checksRun === "number" && Number.isSafeInteger(record.checksRun) ? record.checksRun : 0;
    // A check cut off while running had not used its attempt.
    const checksUsed = Math.max(0, record.state === "running" ? used - 1 : used);
    const setAt = typeof record.setAt === "number" && Number.isFinite(record.setAt) ? record.setAt : make.now;
    migrated.push({
      version: GOAL_VERSION,
      id: make.newId(),
      chatId: record.chatId,
      objective: untilGoalObjective(command),
      status: "paused",
      rounds: Math.min(MAX_DONE_WHEN_CHECKS, checksUsed + 1),
      maxRounds: MAX_DONE_WHEN_CHECKS,
      stalls: 0,
      reason: "Aiden updated; press Keep going to run the check again",
      cause: "restart",
      source: "until",
      setAt,
      updatedAt: make.now,
      revision: 1,
      boot: "migrated",
      check: { command },
      unusableReviews: 0,
    });
  }
  return { goals: migrated, kept };
}
