// Where a scheduled task's run lands. A task made in a chat posts each run
// into that chat: its prompt arrives as a "Scheduled task" notice and the
// reply follows in the same conversation. Every task run goes through
// `deliverTaskRunToChat`, whatever started it, so the chat's hourly task-run
// share, the bounded wait for the chat to go quiet and the fallback to the
// task's own chat hold for schedules and (later) triggers alike.

import {
  agentNotice,
  fenceAsData,
  tailText,
  type AgentNoticeTone,
  type AgentNoticeV1,
} from "../../renderer/shared/agent-notices.js";
import type { AgentNoticeOutcome, AgentNoticePost } from "./follow-through/notice-delivery.js";
import type { ScheduledRunTrigger } from "./schedule-service-core.js";
import type { ScheduledRun, ScheduledTask } from "./types.js";

/** Task runs one chat may take in an hour, shared by schedules and triggers. */
export const MAX_TASK_RUNS_PER_CHAT_PER_HOUR = 6;
/** How long a run waits for its chat to go quiet before it is skipped. */
export const TASK_RUN_CHAT_IDLE_WAIT_MS = 10 * 60 * 1000;
const TASK_RUN_WINDOW_MS = 60 * 60 * 1000;
/** Script output shown to the agent: the end, where results and errors are. */
const SCRIPT_OUTPUT_NOTICE_CHARS = 8_000;
/** Outside text a trigger saw, shown to the agent as data. */
const EVENT_TEXT_CHARS = 8_000;

export interface TaskRunExecution {
  result: ScheduledRun["result"];
  output: string;
  error?: string;
}

/** A model turn for the task, admitted in the chat. */
export type AdmittedTaskTurn =
  | { kind: "busy" }
  | { kind: "admitted"; finish(): Promise<TaskRunExecution> };

export type TaskRunOutcome =
  | ({ kind: "ran"; chatId: string } & TaskRunExecution)
  /** Ran in the task's own chat: no binding, or the chat it posts into can't take it. */
  | ({ kind: "fell_back"; chatId: string } & TaskRunExecution)
  /**
   * Nothing ran. A trigger run keeps its held batch of calls or changes for
   * its next allowed run, so nothing is silently lost.
   */
  | { kind: "skipped"; reason: "chat_busy" | "chat_budget"; chatId: string; output: string };

export interface TaskRunDeliveryOptions {
  trigger?: ScheduledRunTrigger;
  /** Outside text a trigger brought (a webhook body, a watch diff). Always fenced as data. */
  eventText?: string;
  signal: AbortSignal;
}

/** The chat a task posts into, as far as delivery needs to know it. */
export interface TaskRunChat {
  id: string;
  workspaceId?: string;
  botId?: string;
  /** Feature-owned conversations run their own way. */
  owner?: unknown;
}

export interface TaskRunChatDeliveryDeps {
  getChat(chatId: string): Promise<TaskRunChat | undefined>;
  /** The chat it posted into is gone: later runs use the task's own chat. */
  releaseOriginChat(taskId: string, chatId: string): Promise<void>;
  /** The task's own chat, created on first use. */
  ensureOwnChat(task: ScheduledTask): Promise<string>;
  /** Today's run in the task's own chat. Throws when the run could not happen. */
  runInOwnChat(task: ScheduledTask, chatId: string, signal: AbortSignal): Promise<TaskRunExecution>;
  /** Say in the task's own chat that the run failed. */
  reportOwnChatFailure(task: ScheduledTask, chatId: string, message: string): Promise<void>;
  /** Run the task's script without holding any chat; `output` is what it printed. Throws when it could not start. */
  runScript(task: ScheduledTask, signal: AbortSignal): Promise<TaskRunExecution>;
  /**
   * Prepare and admit the task's model turn in the chat: the notice is saved
   * as the turn's prompt. `busy` when another turn holds the chat right now.
   */
  admitTurn(task: ScheduledTask, chatId: string, post: AgentNoticePost, signal: AbortSignal): Promise<AdmittedTaskTurn>;
  /** True once nothing runs in the chat; false when `timeoutMs` passed first. */
  waitForIdle(chatId: string, timeoutMs: number): Promise<boolean>;
  /** Post a notice through the chat's ordered notice delivery. */
  postNotice(post: AgentNoticePost): Promise<AgentNoticeOutcome>;
  /** Run after any earlier notice for the chat, so runs and notices keep one order. */
  inChatOrder<T>(chatId: string, work: () => Promise<T>): Promise<T>;
  /** "Every day at 9:00 AM": the notice's summary line. */
  cadence(task: ScheduledTask): string;
  now(): number;
  onError?(error: unknown): void;
}

/** In-memory hourly task-run counter per chat. A restart resets it; nothing restarts by itself after a quit. */
export class TaskRunBudget {
  private readonly runs = new Map<string, number[]>();
  private readonly skipNotices = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  left(chatId: string): number {
    return MAX_TASK_RUNS_PER_CHAT_PER_HOUR - this.recent(chatId).length;
  }

  take(chatId: string): void {
    this.runs.set(chatId, [...this.recent(chatId), this.now()]);
  }

  /** One "over the limit" notice per chat per hour. */
  takeSkipNotice(chatId: string): boolean {
    const last = this.skipNotices.get(chatId);
    if (last !== undefined && this.now() - last < TASK_RUN_WINDOW_MS) return false;
    this.skipNotices.set(chatId, this.now());
    return true;
  }

  private recent(chatId: string): number[] {
    const since = this.now() - TASK_RUN_WINDOW_MS;
    const recent = (this.runs.get(chatId) ?? []).filter((at) => at > since);
    if (recent.length > 0) this.runs.set(chatId, recent);
    else this.runs.delete(chatId);
    return recent;
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}

function taskNotice(task: ScheduledTask, tone: AgentNoticeTone, summary: string): AgentNoticeV1 {
  return agentNotice({ source: "schedule", tone, title: `Scheduled task: ${task.name}`, summary });
}

/** The model-facing prompt: the person's instructions, plus any outside text fenced as data. */
export function scheduledTaskNoticeText(task: ScheduledTask, cadence: string, eventText?: string): string {
  const lines = [
    `Your scheduled task "${task.name}" is running now (${cadence}). Its instructions, written by the person:`,
    "",
    task.prompt?.trim() ?? "",
  ];
  if (eventText?.trim()) {
    lines.push("", fenceAsData("What happened", tailText(eventText, EVENT_TEXT_CHARS).text));
  }
  return lines.join("\n");
}

const CHAT_BUSY_OUTPUT = "Skipped: the chat stayed busy for 10 minutes.";

export function createTaskRunChatDelivery(deps: TaskRunChatDeliveryDeps) {
  const budget = new TaskRunBudget(deps.now);

  /** The chat a bound task posts into, or undefined to use its own chat. */
  async function originChat(task: ScheduledTask): Promise<string | undefined> {
    const chatId = task.originChatId;
    if (!chatId || task.botId !== undefined) return undefined;
    const chat = await deps.getChat(chatId);
    if (!chat) {
      await deps.releaseOriginChat(task.id, chatId).catch((error: unknown) => deps.onError?.(error));
      return undefined;
    }
    if (chat.botId !== undefined || chat.owner !== undefined) return undefined;
    if (!task.workspaceId || chat.workspaceId !== task.workspaceId) return undefined;
    return chat.id;
  }

  async function inOwnChat(task: ScheduledTask, signal: AbortSignal): Promise<TaskRunOutcome> {
    const chatId = await deps.ensureOwnChat(task);
    try {
      return { kind: "fell_back", chatId, ...(await deps.runInOwnChat(task, chatId, signal)) };
    } catch (cause) {
      const error = errorText(cause);
      await deps
        .reportOwnChatFailure(task, chatId, `Scheduled task failed: ${error}`)
        .catch((reportError: unknown) => deps.onError?.(reportError));
      return { kind: "fell_back", chatId, result: signal.aborted ? "blocked" : "error", output: "", error };
    }
  }

  /** A record-only card in the chat; never wakes it. */
  async function record(chatId: string, notice: AgentNoticeV1, text: string): Promise<void> {
    const outcome = await deps.postNotice({ chatId, notice, text, wake: false });
    if (outcome.kind === "dropped") deps.onError?.(new Error(outcome.reason));
  }

  async function overBudget(task: ScheduledTask, chatId: string): Promise<TaskRunOutcome> {
    const output = `Skipped: this chat already ran ${MAX_TASK_RUNS_PER_CHAT_PER_HOUR} scheduled tasks in the last hour.`;
    if (budget.takeSkipNotice(chatId)) {
      await record(
        chatId,
        taskNotice(task, "info", `Skipped: ${MAX_TASK_RUNS_PER_CHAT_PER_HOUR} task runs this hour already`),
        `${output} Scheduled tasks that post into this chat wait for the next hour; the person can still run one by hand.`,
      );
    }
    return { kind: "skipped", reason: "chat_budget", chatId, output };
  }

  async function chatBusy(task: ScheduledTask, chatId: string): Promise<TaskRunOutcome> {
    await record(
      chatId,
      taskNotice(task, "info", "Skipped: the chat stayed busy"),
      `${CHAT_BUSY_OUTPUT} The task runs again at its next time.`,
    );
    return { kind: "skipped", reason: "chat_busy", chatId, output: CHAT_BUSY_OUTPUT };
  }

  async function runScriptInChat(task: ScheduledTask, chatId: string, signal: AbortSignal): Promise<TaskRunOutcome> {
    const execution = await deps.runScript(task, signal);
    const printed = execution.output.trim() ? tailText(execution.output, SCRIPT_OUTPUT_NOTICE_CHARS) : undefined;
    const fenced = printed
      ? fenceAsData(printed.truncated ? "Script output (end)" : "Script output", printed.text)
      : undefined;
    if (execution.result === "error" || execution.result === "blocked") {
      const reason = execution.error ?? "The script failed.";
      await record(
        chatId,
        taskNotice(task, "failure", reason),
        [`Scheduled task "${task.name}" failed: ${reason}`, ...(fenced ? ["", fenced] : [])].join("\n"),
      );
    } else if (fenced) {
      await record(chatId, taskNotice(task, "info", deps.cadence(task)), `Scheduled task "${task.name}" ran its script.\n\n${fenced}`);
    }
    return { kind: "ran", chatId, ...execution };
  }

  async function runModelInChat(
    task: ScheduledTask,
    chatId: string,
    options: TaskRunDeliveryOptions,
    countsAgainstBudget: boolean,
  ): Promise<TaskRunOutcome> {
    const { signal } = options;
    const cadence = deps.cadence(task);
    const post: AgentNoticePost = {
      chatId,
      notice: taskNotice(task, "info", cadence),
      text: scheduledTaskNoticeText(task, cadence, options.eventText),
      wake: true,
    };
    const deadline = deps.now() + TASK_RUN_CHAT_IDLE_WAIT_MS;
    for (;;) {
      if (signal.aborted) throw new Error("Scheduled task was cancelled.");
      const idle = await deps.waitForIdle(chatId, Math.max(0, deadline - deps.now()));
      if (signal.aborted) throw new Error("Scheduled task was cancelled.");
      if (!idle) return chatBusy(task, chatId);
      const admission = await deps.inChatOrder(chatId, async () => {
        if (countsAgainstBudget && budget.left(chatId) <= 0) return { kind: "budget" as const };
        const admitted = await deps.admitTurn(task, chatId, post, signal);
        if (admitted.kind === "admitted" && countsAgainstBudget) budget.take(chatId);
        return admitted;
      });
      if (admission.kind === "budget") return overBudget(task, chatId);
      if (admission.kind === "admitted") return { kind: "ran", chatId, ...(await admission.finish()) };
      // Another turn took the chat between the wait and the admission.
      if (deps.now() >= deadline) return chatBusy(task, chatId);
    }
  }

  /**
   * Run a task where it belongs. Returns `ran` (in the chat it posts into),
   * `fell_back` (in its own chat), or `skipped` with `chat_busy` or
   * `chat_budget`. A run the person started by hand doesn't count against
   * the chat's hourly share. Only a failure to reach any chat throws.
   */
  async function deliverTaskRunToChat(task: ScheduledTask, options: TaskRunDeliveryOptions): Promise<TaskRunOutcome> {
    const chatId = await originChat(task);
    if (!chatId) return inOwnChat(task, options.signal);
    const countsAgainstBudget = options.trigger?.kind !== "manual";
    if (countsAgainstBudget && budget.left(chatId) <= 0) return overBudget(task, chatId);
    try {
      if (task.mode === "script") {
        if (countsAgainstBudget) budget.take(chatId);
        return await runScriptInChat(task, chatId, options.signal);
      }
      return await runModelInChat(task, chatId, options, countsAgainstBudget);
    } catch (cause) {
      const error = errorText(cause);
      await record(
        chatId,
        taskNotice(task, "failure", options.signal.aborted ? "Cancelled" : "The run couldn't start"),
        `Scheduled task "${task.name}" failed: ${error}`,
      ).catch((recordError: unknown) => deps.onError?.(recordError));
      return { kind: "ran", chatId, result: options.signal.aborted ? "blocked" : "error", output: "", error };
    }
  }

  return { deliverTaskRunToChat, budget };
}

export type TaskRunChatDelivery = ReturnType<typeof createTaskRunChatDelivery>;
