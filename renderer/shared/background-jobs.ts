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
  /**
   * `command`: processes a `run_command` call left running (a server started
   * with a trailing `&`). Aiden tracks and stops them but has no exit code or
   * output for them.
   */
  origin?: "command";
  /** TCP ports the job's processes listen on, lowest first, while it runs. */
  ports?: number[];
}

export interface BackgroundJobOutput {
  job: BackgroundJobView;
  output: string;
  /** Older output was left out. */
  truncated: boolean;
}

const JOB_ID = /^job_[0-9a-f]{8}$/u;

/** Most ports a job lists. */
export const MAX_BACKGROUND_JOB_PORTS = 5;

/** The address a person opens for a port a job listens on. */
export function backgroundJobPortUrl(port: number): string {
  return `http://localhost:${port}`;
}

export function isBackgroundJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID.test(value);
}

/** The name the person sees: the agent's label, else the command. */
export function backgroundJobLabel(job: Pick<BackgroundJobView, "description" | "command">): string {
  return job.description?.trim() || job.command;
}
