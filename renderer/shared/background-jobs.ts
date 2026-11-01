// Background jobs contract shared by main and the renderer: what a job looks
// like in lists and how it ended. Main owns the processes; the renderer only
// lists, reads output and asks for a stop.

export type BackgroundJobState = "running" | "exited" | "failed" | "stopped";

/** Why a job was stopped rather than ending by itself. */
export type BackgroundJobEndReason =
  | "agent"
  | "person"
  | "output-limit"
  | "chat-deleted"
  | "access-changed"
  | "app-quit";

export interface BackgroundJobView {
  /** Short id the agent and the person refer to, e.g. `job_1a2b3c4d`. */
  id: string;
  chatId: string;
  workspaceId: string;
  command: string;
  /** The agent's short label, e.g. "Run the dev server". */
  description?: string;
  state: BackgroundJobState;
  startedAt: number;
  endedAt?: number;
  pid?: number;
  exitCode?: number | null;
  signal?: string;
  endReason?: BackgroundJobEndReason;
  outputBytes: number;
}

export interface BackgroundJobOutput {
  job: BackgroundJobView;
  output: string;
  /** Older output was left out. */
  truncated: boolean;
}

const JOB_ID = /^job_[0-9a-f]{8}$/u;

export function isBackgroundJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID.test(value);
}

/** The name the person sees: the agent's label, else the command. */
export function backgroundJobLabel(job: Pick<BackgroundJobView, "description" | "command">): string {
  return job.description?.trim() || job.command;
}
