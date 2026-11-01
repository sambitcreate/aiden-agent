// A chat's background jobs on phones (`chat:jobs`, contract revision 49): what the
// agent left running for the chat, the ports each serves on the Mac, and Stop.
// The Mac's one job registry answers; this file only projects it for the wire.

import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  AIDEN_REMOTE_MAX_BACKGROUND_JOB_LABEL,
  AIDEN_REMOTE_MAX_BACKGROUND_JOB_PORTS,
  AIDEN_REMOTE_MAX_BACKGROUND_JOBS,
  type AidenRemoteBackgroundJob,
  type AidenRemoteBackgroundJobs,
} from "./aiden-remote-protocol.js";
import { backgroundJobLabel, isBackgroundJobId, type BackgroundJobView } from "../../renderer/shared/background-jobs.js";

export interface AidenRemoteBackgroundJobRegistry {
  list(chatId: string): BackgroundJobView[];
  /** Resolves once the job has ended; throws for a job the chat does not have. */
  stop(chatId: string, jobId: string): Promise<unknown>;
}

function clip(text: string, maximum: number): string {
  const characters = Array.from(text.replace(/\s+/gu, " ").trim());
  return characters.length <= maximum ? characters.join("") : `${characters.slice(0, maximum - 1).join("")}…`;
}

export function projectAidenRemoteBackgroundJob(view: BackgroundJobView): AidenRemoteBackgroundJob {
  const running = view.state === "running";
  const exitCode =
    (view.state === "exited" || view.state === "failed") && typeof view.exitCode === "number" ? view.exitCode : undefined;
  return {
    id: view.id,
    label: clip(backgroundJobLabel(view), AIDEN_REMOTE_MAX_BACKGROUND_JOB_LABEL) || "Background job",
    state: view.state,
    startedAt: new Date(view.startedAt).toISOString(),
    ...(!running ? { endedAt: new Date(view.endedAt ?? view.startedAt).toISOString() } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(view.state === "stopped" ? { endReason: view.endReason ?? "person" } : {}),
    ...(view.origin === "command" ? { fromCommand: true as const } : {}),
    ports: running ? (view.ports ?? []).slice(0, AIDEN_REMOTE_MAX_BACKGROUND_JOB_PORTS) : [],
  };
}

export class AidenRemoteBackgroundJobService {
  constructor(private readonly jobs: AidenRemoteBackgroundJobRegistry) {}

  list(chatId: string): AidenRemoteBackgroundJobs {
    return {
      jobs: this.jobs
        .list(chatId)
        .sort((left, right) => Number(right.state === "running") - Number(left.state === "running") || right.startedAt - left.startedAt)
        .slice(0, AIDEN_REMOTE_MAX_BACKGROUND_JOBS)
        .map(projectAidenRemoteBackgroundJob),
    };
  }

  /** Stops a running job (polite, then forced) and returns the chat's list. A finished one is returned as it is. */
  async stop(chatId: string, jobId: string): Promise<AidenRemoteBackgroundJobs> {
    if (!isBackgroundJobId(jobId) || !this.jobs.list(chatId).some((job) => job.id === jobId)) {
      throw new AidenRemoteServiceError("not_found", "This chat has no such background job.", 404);
    }
    await this.jobs.stop(chatId, jobId);
    return this.list(chatId);
  }
}
