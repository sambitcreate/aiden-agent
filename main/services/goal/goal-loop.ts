/**
 * The keep-going loop for every chat's goal. Main wires it to the chat client,
 * the store and the reviewer in `goal-main.ts`; everything it touches is a
 * dependency, so the loop runs in tests with fakes.
 *
 * After an ordinary run in a chat settles, the loop waits 1.5 seconds and
 * checks the chat is still idle (a queued send from the person wins: their
 * run settles later and the loop looks again). Then the pre-checks (a restart,
 * Stop, a failed answer, a running helper), then the review (or a command
 * goal's check), then the verdict: done, needs you, paused, wait, or the next
 * round, started as an attended turn with a "Keep going · round N of 50" card.
 * Every system write is compare-and-set, so the person's pause or clear
 * always wins over a review that was still running.
 */
import { agentNotice, type AgentNoticeV1 } from "../../../renderer/shared/agent-notices.js";
import {
  GOAL_SETTLE_DELAY_MS,
  GOAL_WAIT_LIMIT_MS,
  goalRoundBucket,
  goalView,
  validateGoalCheck,
  type GoalCheck,
  type GoalRecordV1,
  type GoalRoundBucket,
  type GoalSource,
  type GoalView,
} from "../../../renderer/shared/goal.js";
import type { OwedTurnContext } from "../chat-owed-turn-start.js";
import {
  applyGoalCheck,
  applyGoalVerdict,
  compareAndSetGoal,
  createGoal,
  goalAfterSettle,
  goalPromptUnanswered,
  goalWaitExpired,
  goalWindowWanted,
  pauseGoal,
  restoreGoal,
  resumeGoal,
  type GoalRef,
  type GoalRoundActivity,
  type GoalStep,
} from "./goal-core.js";
import { goalContinuationNote, goalKickoffNote, goalReminder, goalRoundTitle } from "./goal-prompts.js";
import type { GoalReviewOutcome } from "./goal-reviewer.js";
import type { GoalRunSettled } from "./goal-turn-hooks.js";
import type { StartTurnResult } from "../follow-through/notice-delivery.js";
import type { GoalCheckResult } from "../follow-through/done-when.js";

export type GoalAnalyticsEvent =
  | { event: "goal_started"; properties: { source: GoalSource } }
  | { event: "goal_settled"; properties: { outcome: "done" | "needs_you" | "paused" | "cleared"; rounds: GoalRoundBucket } };

export type GoalRoundStart = "started" | "busy" | "unavailable";

export interface GoalLoopDependencies {
  enabled(): boolean;
  /** This Aiden process; a goal made active by another comes back paused. */
  boot: string;
  now(): number;
  newId(): string;
  /** Resolves after `ms`, or rejects once `signal` aborts. */
  delay(ms: number, signal: AbortSignal): Promise<void>;
  /** Runs `run` after `ms`; returns a cancel. */
  setTimer(run: () => void, ms: number): () => void;
  persist(goals: readonly GoalRecordV1[]): void;
  onChange(chatId: string, goal: GoalView | null): void;
  /** Why this chat cannot have a goal, or undefined when it can. */
  eligibility(chatId: string): Promise<string | undefined>;
  /** A turn holds the chat, or a notice is on its way into it. */
  isChatBusy(chatId: string): boolean;
  helperRunning(chatId: string): boolean;
  jobsRunning(chatId: string): boolean;
  /** What the round that just settled did: its tool calls and new answer text. */
  roundActivity(chatId: string): Promise<GoalRoundActivity>;
  /** What a round starts with when no run settled in this process yet (Keep going after a restart). */
  fallbackContext(chatId: string): Promise<OwedTurnContext | undefined>;
  review(goal: GoalRecordV1, input: { allowWait: boolean; signal: AbortSignal }): Promise<GoalReviewOutcome>;
  /** A command goal's check; without it, command goals are refused. */
  runCheck?(goal: GoalRecordV1, signal: AbortSignal): Promise<GoalCheckResult>;
  /** Throws why this chat can't run a command goal's check (folder access off, a replaced worktree). */
  prepareCheck?(chatId: string): Promise<void>;
  startRound(chatId: string, context: OwedTurnContext, round: { text: string; notice: AgentNoticeV1 }): Promise<GoalRoundStart>;
  /**
   * A round that answers a notice (a finished job, a pull request update):
   * with `notice` saved first, or answering the notice already saved.
   */
  startNoticeRound(chatId: string, context: OwedTurnContext, notice?: { text: string; notice: AgentNoticeV1 }): Promise<StartTurnResult>;
  report(event: GoalAnalyticsEvent): void;
  /** A goal settled on its own (done, needs you, or paused by the system). */
  settled?(goal: GoalRecordV1): void;
  log(message: string, error?: unknown): void;
}

export class GoalLoopError extends Error {}

export class GoalLoop {
  private readonly goals = new Map<string, GoalRecordV1>();
  private readonly contexts = new Map<string, OwedTurnContext>();
  /** Goals whose kickoff note has not followed the person's objective yet. */
  private readonly kickoffs = new Set<string>();
  private readonly reviews = new Map<string, AbortController>();
  private readonly watchdogs = new Map<string, () => void>();
  /** The app is quitting: runs that settle now are its own aborts, not the person's. */
  private stopped = false;

  constructor(private readonly deps: GoalLoopDependencies) {}

  restore(records: readonly GoalRecordV1[]): void {
    let changed = false;
    for (const record of records) {
      const restored = restoreGoal(record, { now: this.deps.now(), boot: this.deps.boot });
      if (restored !== record) changed = true;
      this.goals.set(restored.chatId, restored);
    }
    if (changed) this.persist();
  }

  get(chatId: string): GoalView | null {
    const goal = this.goals.get(chatId);
    return goal ? goalView(goal) : null;
  }

  /** Sets the chat's goal, replacing any earlier one. The person's objective message follows. */
  async set(chatId: string, input: { objective: string; source: GoalSource; check?: string }): Promise<GoalView> {
    if (!this.deps.enabled()) throw new GoalLoopError("Keep-going goals aren't available yet.");
    const refusal = await this.deps.eligibility(chatId);
    if (refusal) throw new GoalLoopError(refusal);
    let check: GoalCheck | undefined;
    if (input.check !== undefined) {
      if (!this.deps.runCheck) throw new GoalLoopError("Goals checked by a command aren't available yet.");
      check = validateGoalCheck(input.check);
      if (!check) throw new GoalLoopError("The check must be one command line of up to 1,000 characters.");
      await this.deps.prepareCheck?.(chatId);
    }
    const created = createGoal({
      id: this.deps.newId(),
      chatId,
      objective: input.objective,
      source: input.source,
      boot: this.deps.boot,
      now: this.deps.now(),
      ...(check ? { check } : {}),
    });
    if (!created.ok) throw new GoalLoopError(created.message);
    const previous = this.goals.get(chatId);
    this.stopReview(chatId);
    if (previous?.status === "active") this.reportSettled(previous, "cleared");
    // A command goal sends no objective message: its first check runs now if
    // the chat is idle, or when the current answer ends, and the round after
    // a failure says what the goal is.
    if (!check) this.kickoffs.add(created.goal.id);
    this.write(created.goal);
    this.deps.report({ event: "goal_started", properties: { source: input.source } });
    if (check && !this.deps.isChatBusy(chatId)) this.look(chatId);
    return goalView(created.goal);
  }

  /** The hidden note after the person's objective: given once, while the goal is active. */
  kickoff(chatId: string): string | undefined {
    const goal = this.goals.get(chatId);
    if (!goal || goal.status !== "active" || !this.kickoffs.delete(goal.id)) return undefined;
    return goalKickoffNote(goal);
  }

  reminder(chatId: string): string | undefined {
    const goal = this.goals.get(chatId);
    return goal?.status === "active" ? goalReminder(goal) : undefined;
  }

  /** The person's Pause. */
  pause(chatId: string): GoalView | null {
    const goal = this.goals.get(chatId);
    if (!goal) return null;
    this.stopReview(chatId);
    const paused = pauseGoal(goal, { now: this.deps.now(), cause: "person" });
    if (paused !== goal) {
      this.write(paused);
      this.reportSettled(paused, "paused");
    }
    return goalView(paused);
  }

  /** Keep going / Resume: round 1 again, no stalls, and a round starts now if the chat is idle. */
  async resume(chatId: string): Promise<GoalView | null> {
    if (!this.deps.enabled()) throw new GoalLoopError("Keep-going goals aren't available yet.");
    const goal = this.goals.get(chatId);
    if (!goal) return null;
    const resumed = resumeGoal(goal, { now: this.deps.now(), boot: this.deps.boot });
    if (resumed === goal) return goalView(goal);
    this.write(resumed);
    if (!this.deps.isChatBusy(chatId) && !this.reviews.has(chatId)) await this.startRound(resumed);
    return this.get(chatId);
  }

  clear(chatId: string): void {
    const goal = this.goals.get(chatId);
    if (!goal) return;
    this.stopReview(chatId);
    this.cancelWatchdog(chatId);
    this.goals.delete(chatId);
    this.kickoffs.delete(goal.id);
    this.persist();
    this.deps.onChange(chatId, null);
    if (goal.status === "active") this.reportSettled(goal, "cleared");
  }

  runSettled(event: GoalRunSettled): void {
    if (this.stopped) return;
    this.contexts.set(event.chatId, event.context);
    this.look(event.chatId, event);
  }

  /** Runs the loop for the chat: after a run settled, or for a command goal's first check. */
  private look(chatId: string, event: Pick<GoalRunSettled, "stopped" | "failed"> = { stopped: false, failed: false }): void {
    const goal = this.goals.get(chatId);
    if (this.stopped || !goal || goal.status !== "active" || this.reviews.has(chatId)) return;
    const controller = new AbortController();
    this.reviews.set(chatId, controller);
    void this.afterSettle({ chatId, stopped: event.stopped, failed: event.failed }, controller)
      .catch((error: unknown) => this.deps.log("The keep-going goal could not continue.", error))
      .finally(() => {
        if (this.reviews.get(chatId) === controller) this.reviews.delete(chatId);
      });
  }

  /**
   * A notice would wake the chat. While the goal is active it is answered by
   * a goal round, which the person attends and which spends no wake budget;
   * its settling runs the loop as any round's does. Undefined with no active goal.
   */
  async noticeRound(chatId: string, notice?: { text: string; notice: AgentNoticeV1 }): Promise<StartTurnResult | undefined> {
    const goal = this.goals.get(chatId);
    if (this.stopped || goal?.status !== "active") return undefined;
    const context = this.contexts.get(chatId) ?? (await this.deps.fallbackContext(chatId));
    if (this.goals.get(chatId)?.status !== "active") return undefined;
    if (!context) return { kind: "unavailable", reason: "The chat has no model yet." };
    return this.deps.startNoticeRound(chatId, context, notice);
  }

  /** A round's approval or question expired unanswered: the goal waits for the person. */
  promptExpired(chatId: string): void {
    const goal = this.goals.get(chatId);
    if (goal?.status !== "active") return;
    this.stopReview(chatId);
    this.settle(goalPromptUnanswered(goal, this.deps.now()));
  }

  /**
   * The window that owned this round closed, reloaded or showed another chat:
   * the round stops (goal-main cancels it after this) and the goal pauses.
   */
  windowClosed(chatId: string): void {
    const goal = this.goals.get(chatId);
    if (goal?.status !== "active") return;
    this.stopReview(chatId);
    this.settle(pauseGoal(goal, { now: this.deps.now(), cause: "chat-closed" }));
  }

  /**
   * A round without a window had a call refused that needs the chat on screen.
   * The goal bar then offers Continue here. Rounds of an inactive goal don't count.
   */
  windowWanted(chatId: string): void {
    const goal = this.goals.get(chatId);
    if (goal?.status !== "active") return;
    const next = goalWindowWanted(goal, true, this.deps.now());
    if (next !== goal) this.write(next);
  }

  /** A round started in a window that shows the chat: it has every tool, so nothing is wanted. */
  windowRoundStarted(chatId: string): void {
    const goal = this.goals.get(chatId);
    if (!goal) return;
    const next = goalWindowWanted(goal, false, this.deps.now());
    if (next !== goal) this.write(next);
  }

  deleteChat(chatId: string): void {
    this.contexts.delete(chatId);
    if (!this.goals.has(chatId)) return;
    this.stopReview(chatId);
    this.cancelWatchdog(chatId);
    const goal = this.goals.get(chatId)!;
    this.kickoffs.delete(goal.id);
    this.goals.delete(chatId);
    this.persist();
  }

  accessChanged(chatIds: readonly string[]): void {
    for (const chatId of chatIds) {
      const goal = this.goals.get(chatId);
      if (goal?.status !== "active") continue;
      this.stopReview(chatId);
      this.settle(pauseGoal(goal, { now: this.deps.now(), cause: "access-changed" }));
    }
  }

  moveRefusal(chatId: string): string | undefined {
    return this.goals.get(chatId)?.status === "active"
      ? "Pause or clear this chat's goal before changing workspaces."
      : undefined;
  }

  shutdown(): void {
    this.stopped = true;
    for (const chatId of [...this.reviews.keys()]) this.stopReview(chatId);
    for (const chatId of [...this.watchdogs.keys()]) this.cancelWatchdog(chatId);
  }

  // ── The loop ─────────────────────────────────────────────────────────────

  private async afterSettle(event: Pick<GoalRunSettled, "chatId" | "stopped" | "failed">, controller: AbortController): Promise<void> {
    const { signal } = controller;
    try {
      await this.deps.delay(GOAL_SETTLE_DELAY_MS, signal);
    } catch {
      return;
    }
    // The person's queued send wins: their run settles later and the loop looks again.
    if (signal.aborted || this.deps.isChatBusy(event.chatId)) return;
    const goal = this.goals.get(event.chatId);
    if (!goal) return;
    const step = goalAfterSettle(goal, {
      now: this.deps.now(),
      boot: this.deps.boot,
      stopped: event.stopped,
      lastRunFailed: event.failed,
      helperRunning: this.deps.helperRunning(event.chatId),
    });
    if (step.kind === "idle") return;
    if (step.kind === "paused") {
      this.settle(step.goal);
      return;
    }
    if (step.kind === "skip") {
      if (step.goal !== goal) this.write(step.goal);
      this.armWatchdog(step.goal);
      return;
    }
    const ref: GoalRef = { id: goal.id, revision: goal.revision };
    const activity = await this.deps.roundActivity(event.chatId);
    if (signal.aborted) return;
    let next: GoalStep | undefined;
    let reason: string | undefined;
    let details: string | undefined;
    if (step.kind === "check") {
      const result = await this.deps.runCheck!(goal, signal);
      if (signal.aborted) return;
      if (result.kind === "stopped") {
        next = { goal: pauseGoal(goal, { now: this.deps.now(), cause: "failed", reason: result.summary }), next: "settled" };
      } else {
        next = applyGoalCheck(goal, result, this.deps.now());
        reason = result.summary;
        details = result.details;
      }
    } else {
      let current = goal;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const outcome = await this.deps.review(current, { allowWait: this.deps.jobsRunning(event.chatId), signal });
        if (outcome.kind === "cancelled" || signal.aborted) return;
        if (outcome.kind === "refused") {
          next = { goal: pauseGoal(current, { now: this.deps.now(), cause: "spending" }), next: "settled" };
          break;
        }
        const verdict = outcome.kind === "verdict" ? outcome.verdict : undefined;
        next = applyGoalVerdict(current, verdict, activity, this.deps.now());
        reason = verdict?.reason;
        if (next.next !== "retry-review") break;
        current = next.goal;
      }
    }
    if (!next) return;
    // Applied only if the goal is still the one reviewed: a pause, clear or
    // new goal from the person in the meantime wins.
    const written = compareAndSetGoal(this.goals.get(event.chatId), ref, () => next.goal);
    if (!written.ok) return;
    if (next.goal.status !== "active") {
      this.settle(next.goal);
      return;
    }
    this.write(next.goal);
    if (next.next === "wait") this.armWatchdog(next.goal);
    if (next.next === "round") {
      this.cancelWatchdog(event.chatId);
      // A send from the person during the review is this round's work.
      if (!this.deps.isChatBusy(event.chatId)) await this.startRound(next.goal, reason, details);
    }
  }

  private async startRound(goal: GoalRecordV1, reason?: string, details?: string): Promise<void> {
    const context = this.contexts.get(goal.chatId) ?? (await this.deps.fallbackContext(goal.chatId));
    const current = this.goals.get(goal.chatId);
    if (this.stopped || current?.id !== goal.id || current.revision !== goal.revision) return;
    if (!context) {
      this.settle(pauseGoal(goal, { now: this.deps.now(), cause: "failed", reason: "The next round could not start" }));
      return;
    }
    const started = await this.deps.startRound(goal.chatId, context, {
      text: goalContinuationNote(goal, reason, details),
      notice: agentNotice({ source: "goal", tone: "info", title: goalRoundTitle(goal), summary: reason ?? goal.objective }),
    });
    if (started === "unavailable") {
      const latest = this.goals.get(goal.chatId);
      if (latest?.id === goal.id && latest.revision === goal.revision) {
        this.settle(pauseGoal(latest, { now: this.deps.now(), cause: "failed", reason: "The next round could not start" }));
      }
    }
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  /** A system transition out of active: saved, reported and announced. */
  private settle(goal: GoalRecordV1): void {
    this.write(goal);
    this.cancelWatchdog(goal.chatId);
    if (goal.status === "active") return;
    this.reportSettled(goal, goal.status === "done" ? "done" : goal.status === "needs-you" ? "needs_you" : "paused");
    this.deps.settled?.(goal);
  }

  private write(goal: GoalRecordV1): void {
    this.goals.set(goal.chatId, goal);
    if (goal.status !== "active") this.cancelWatchdog(goal.chatId);
    this.persist();
    this.deps.onChange(goal.chatId, goalView(goal));
  }

  private persist(): void {
    this.deps.persist([...this.goals.values()]);
  }

  private reportSettled(goal: GoalRecordV1, outcome: "done" | "needs_you" | "paused" | "cleared"): void {
    this.deps.report({ event: "goal_settled", properties: { outcome, rounds: goalRoundBucket(goal.rounds) } });
  }

  private stopReview(chatId: string): void {
    this.reviews.get(chatId)?.abort();
    this.reviews.delete(chatId);
  }

  /** The 30-minute limit on a `wait` or a running helper. */
  private armWatchdog(goal: GoalRecordV1): void {
    if (goal.waitingSince === undefined) return;
    this.cancelWatchdog(goal.chatId);
    const remaining = Math.max(0, goal.waitingSince + GOAL_WAIT_LIMIT_MS - this.deps.now());
    const cancel = this.deps.setTimer(() => {
      this.watchdogs.delete(goal.chatId);
      const current = this.goals.get(goal.chatId);
      const expired = current ? goalWaitExpired(current, this.deps.now()) : undefined;
      if (expired) {
        this.stopReview(goal.chatId);
        this.settle(expired);
      }
    }, remaining);
    this.watchdogs.set(goal.chatId, cancel);
  }

  private cancelWatchdog(chatId: string): void {
    this.watchdogs.get(chatId)?.();
    this.watchdogs.delete(chatId);
  }
}
