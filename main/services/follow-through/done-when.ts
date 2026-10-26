// "Done when" checks: the person names a command (`/until npm test`) and it
// runs after each answer in that chat. While it fails, the agent gets the end
// of its output and keeps going, up to five checks. A pass, the fifth failure,
// or the person clearing it ends the loop. A check cut off by a quit is never
// rerun on launch; it waits for the next answer instead.

import { agentNotice, fenceAsData, tailText, type AgentNoticeV1 } from "../../../renderer/shared/agent-notices.js";
import {
  MAX_DONE_WHEN_CHECKS,
  MAX_DONE_WHEN_COMMAND_CHARS,
  type DoneWhenCheckState,
  type DoneWhenCheckView,
} from "../../../renderer/shared/follow-through.js";

export const DONE_WHEN_TIMEOUT_MS = 10 * 60_000;
export const DONE_WHEN_OUTPUT_CHARS = 3_000;

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

export interface DoneWhenRunResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  output: string;
}

export interface DoneWhenNotice {
  chatId: string;
  notice: AgentNoticeV1;
  text: string;
  wake: boolean;
}

export interface DoneWhenDeps {
  run(record: DoneWhenRecord, signal: AbortSignal): Promise<DoneWhenRunResult>;
  post(notice: DoneWhenNotice): void;
  /** Saves every record; called after each change. */
  persist(records: DoneWhenRecord[]): void;
  onChange?(chatId: string): void;
  now(): number;
}

export function doneWhenView(record: DoneWhenRecord): DoneWhenCheckView {
  return {
    command: record.command,
    state: record.state,
    checksRun: record.checksRun,
    setAt: record.setAt,
    ...(record.lastRunAt !== undefined ? { lastRunAt: record.lastRunAt } : {}),
    ...(record.lastExitCode !== undefined ? { lastExitCode: record.lastExitCode } : {}),
    ...(record.lastTimedOut ? { lastTimedOut: true } : {}),
  };
}

export function validateDoneWhenCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("Name the check to run, for example /until npm test.");
  if (trimmed.length > MAX_DONE_WHEN_COMMAND_CHARS) throw new Error("The check command is too long.");
  if (/[\r\n]/u.test(trimmed)) throw new Error("Write the check on one line.");
  return trimmed;
}

function outcomeLine(result: DoneWhenRunResult): string {
  if (result.timedOut) return "it ran for 10 minutes without finishing";
  return `exit code ${result.exitCode ?? "unknown"}`;
}

export class DoneWhenChecks {
  private readonly records = new Map<string, DoneWhenRecord>();
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly deps: DoneWhenDeps) {}

  /** Load saved checks. One that was running when Aiden closed waits for the next answer. */
  restore(records: readonly DoneWhenRecord[]): void {
    for (const record of records) {
      if (record?.version !== 1 || typeof record.chatId !== "string" || typeof record.command !== "string") continue;
      this.records.set(record.chatId, record.state === "running" ? { ...record, state: "waiting" } : { ...record });
    }
  }

  get(chatId: string): DoneWhenRecord | undefined {
    const record = this.records.get(chatId);
    return record ? { ...record } : undefined;
  }

  list(): DoneWhenRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  /** Set (or replace) a chat's check. With `runNow` it runs once right away. */
  set(input: { chatId: string; workspaceId: string; command: string; runNow: boolean }): DoneWhenRecord {
    const command = validateDoneWhenCommand(input.command);
    this.running.get(input.chatId)?.abort();
    const record: DoneWhenRecord = {
      version: 1,
      chatId: input.chatId,
      workspaceId: input.workspaceId,
      command,
      state: "waiting",
      checksRun: 0,
      setAt: this.deps.now(),
    };
    this.records.set(input.chatId, record);
    this.changed(input.chatId);
    if (input.runNow) void this.runCheck(input.chatId);
    return { ...record };
  }

  clear(chatId: string): boolean {
    const had = this.records.delete(chatId);
    this.running.get(chatId)?.abort();
    if (had) this.changed(chatId);
    return had;
  }

  clearWorkspace(workspaceId: string): void {
    for (const record of [...this.records.values()]) {
      if (record.workspaceId === workspaceId) this.clear(record.chatId);
    }
  }

  /** An answer in the chat finished. Runs a waiting check; returns whether it started. */
  answerFinished(chatId: string): boolean {
    const record = this.records.get(chatId);
    if (!record || record.state !== "waiting" || this.running.has(chatId)) return false;
    void this.runCheck(chatId);
    return true;
  }

  /** Stop any check that is running, for quit. */
  shutdown(): void {
    for (const controller of this.running.values()) controller.abort();
  }

  private async runCheck(chatId: string): Promise<void> {
    const record = this.records.get(chatId);
    if (!record || this.running.has(chatId)) return;
    const controller = new AbortController();
    this.running.set(chatId, controller);
    const started: DoneWhenRecord = {
      ...record,
      state: "running",
      checksRun: record.checksRun + 1,
      lastRunAt: this.deps.now(),
    };
    this.records.set(chatId, started);
    this.changed(chatId);
    let result: DoneWhenRunResult;
    try {
      result = await this.deps.run(started, controller.signal);
    } catch (error) {
      result = {
        exitCode: null,
        timedOut: false,
        aborted: controller.signal.aborted,
        output: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (this.running.get(chatId) === controller) this.running.delete(chatId);
    }
    // Cleared or replaced while it ran: that record is no longer this check.
    if (this.records.get(chatId) !== started) return;
    if (result.aborted) {
      this.records.set(chatId, { ...started, state: "waiting", checksRun: record.checksRun });
      this.changed(chatId);
      return;
    }
    const passed = result.exitCode === 0 && !result.timedOut;
    const finished: DoneWhenRecord = {
      ...started,
      state: passed ? "passed" : started.checksRun >= MAX_DONE_WHEN_CHECKS ? "gave-up" : "waiting",
      lastExitCode: result.exitCode,
      ...(result.timedOut ? { lastTimedOut: true } : {}),
    };
    if (!result.timedOut) delete finished.lastTimedOut;
    this.records.set(chatId, finished);
    this.changed(chatId);
    this.deps.post(this.noticeFor(finished, result));
  }

  private noticeFor(record: DoneWhenRecord, result: DoneWhenRunResult): DoneWhenNotice {
    const count = `${record.checksRun} of ${MAX_DONE_WHEN_CHECKS}`;
    const { text: tail, truncated } = tailText(result.output.trimEnd(), DONE_WHEN_OUTPUT_CHARS);
    const output = tail.trim()
      ? fenceAsData(truncated ? "End of the check's output" : "The check's output", tail)
      : "The check printed nothing.";
    if (record.state === "passed") {
      return {
        chatId: record.chatId,
        notice: agentNotice({ source: "check", tone: "success", title: "Check passed", summary: `${record.command} · check ${count}` }),
        text: `[Aiden follow-up: done-when check]\nThe check the person set passed: \`${record.command}\` (check ${count}). Aiden stopped running it.`,
        wake: false,
      };
    }
    if (record.state === "gave-up") {
      return {
        chatId: record.chatId,
        notice: agentNotice({ source: "check", tone: "failure", title: "Check still failing", summary: `${record.command} · ${outcomeLine(result)} · stopped after ${MAX_DONE_WHEN_CHECKS} checks` }),
        text: [
          "[Aiden follow-up: done-when check]",
          `The check the person set still fails after ${MAX_DONE_WHEN_CHECKS} checks: \`${record.command}\` (${outcomeLine(result)}). Aiden stopped running it.`,
          output,
        ].join("\n\n"),
        wake: false,
      };
    }
    return {
      chatId: record.chatId,
      notice: agentNotice({ source: "check", tone: "failure", title: "Check failed", summary: `${record.command} · ${outcomeLine(result)} · check ${count}` }),
      text: [
        "[Aiden follow-up: done-when check]",
        `The person asked you to keep going until this check passes: \`${record.command}\`. It failed (${outcomeLine(result)}); this was check ${count}.`,
        output,
        "Find the cause and fix it. Aiden runs the check again when your answer ends.",
      ].join("\n\n"),
      wake: true,
    };
  }

  private changed(chatId: string): void {
    this.deps.persist(this.list());
    this.deps.onChange?.(chatId);
  }
}
