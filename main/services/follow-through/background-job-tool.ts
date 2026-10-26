// The `background_job` tool: start a shell command that keeps running after
// the tool returns (a dev server, a watcher, a long test run), then read its
// output, list jobs, or stop one. The chat hears about a job that ends on its
// own through a follow-up notice, so the agent does not have to poll.

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { fenceAsData } from "../../../renderer/shared/agent-notices.js";
import {
  backgroundJobLabel,
  isBackgroundJobId,
  type BackgroundJobView,
} from "../../../renderer/shared/background-jobs.js";
import { declarePiRuntimeReplay } from "../pi-runtime-tool.js";
import {
  describeJobEnd,
  formatDuration,
  JOB_TAIL_CHARS,
  type BackgroundJobs,
} from "./background-jobs.js";

export const BACKGROUND_JOB_TOOL_NAME = "background_job";

/** How long `start` waits for early output or a quick failure. */
export const BACKGROUND_JOB_START_WAIT_MS = 1_500;
const DEFAULT_READ_CHARS = 4_000;
const START_OUTPUT_CHARS = 2_000;
const STOP_OUTPUT_CHARS = 2_000;

type BackgroundJobAction = "start" | "read" | "list" | "stop";

export interface BackgroundJobToolOptions {
  chatId: string;
  workspaceId: string;
  workspaceRoot: string;
  jobs: Pick<BackgroundJobs, "start" | "settle" | "read" | "list" | "stop">;
  /** Command environment, read per start so PATH changes apply. */
  env: () => NodeJS.ProcessEnv;
  /** Throws when the chat's folder access changed since the turn began. */
  revalidate: (signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  startWaitMs?: number;
}

function textResult(text: string, isError = false): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null, ...(isError ? { isError: true } : {}) };
}

function statusLine(job: BackgroundJobView, now: number): string {
  const elapsed = formatDuration((job.endedAt ?? now) - job.startedAt);
  const state = job.state === "running" ? `running for ${elapsed}` : `${describeJobEnd(job)} after ${elapsed}`;
  return `${job.id} · ${state} · ${backgroundJobLabel(job)}`;
}

function outputBlock(output: string, truncated: boolean): string {
  if (!output.trim()) return "No output yet.";
  return fenceAsData(truncated ? "Newest output (older output left out)" : "Output", output.trimEnd());
}

function requireJobId(value: unknown): string {
  if (!isBackgroundJobId(value)) throw new Error('Give the job_id, for example "job_1a2b3c4d". Use action "list" to see this chat\'s jobs.');
  return value;
}

/** Ask-mode approval: only starting a job runs something new. */
export function backgroundJobRequiresApproval(toolName: string, args: unknown): boolean {
  if (toolName !== BACKGROUND_JOB_TOOL_NAME) return false;
  return (args as { action?: unknown } | null)?.action === "start";
}

export function createBackgroundJobTool(options: BackgroundJobToolOptions): AgentTool {
  const now = options.now ?? Date.now;
  const tool: AgentTool = {
    name: BACKGROUND_JOB_TOOL_NAME,
    label: "Background Job",
    description:
      "Run a shell command in the background and keep working while it runs: dev servers, file watchers, long builds or test runs, anything that would outlast run_command's 2-minute limit or that you want to leave running. " +
      'action "start" runs `command` with the workspace folder as the working directory and returns its job_id with any early output. ' +
      'action "read" returns the newest output of a job; "list" shows this chat\'s jobs; "stop" ends a job and everything it started. ' +
      "When a job ends on its own you get a message in this chat with how it ended and its last output, so do not poll in a loop. " +
      "Jobs stop when the chat is deleted, folder access changes, or Aiden quits. Use run_command for short commands whose result you need right away.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("read"), Type.Literal("list"), Type.Literal("stop")]),
      command: Type.Optional(Type.String({ description: 'The shell command to run (action "start").' })),
      description: Type.Optional(
        Type.String({
          description: 'A short present-tense label for the job in 3-8 words, e.g. "Run the dev server" (action "start").',
        }),
      ),
      job_id: Type.Optional(Type.String({ description: 'The job to read or stop, e.g. "job_1a2b3c4d".' })),
      max_chars: Type.Optional(
        Type.Integer({
          minimum: 200,
          maximum: JOB_TAIL_CHARS,
          description: `Newest output characters to return (action "read"; default ${DEFAULT_READ_CHARS}).`,
        }),
      ),
    }),
    execute: async (_id, params, signal): Promise<AgentToolResult<null>> => {
      signal?.throwIfAborted();
      const input = params as {
        action: BackgroundJobAction;
        command?: string;
        description?: string;
        job_id?: string;
        max_chars?: number;
      };
      switch (input.action) {
        case "start": {
          const command = input.command?.trim();
          if (!command) throw new Error('Give the command to run with action "start".');
          await options.revalidate(signal);
          signal?.throwIfAborted();
          const started = options.jobs.start({
            chatId: options.chatId,
            workspaceId: options.workspaceId,
            cwd: options.workspaceRoot,
            command,
            ...(input.description ? { description: input.description } : {}),
            env: options.env(),
          });
          const settled = await options.jobs.settle(options.chatId, started.id, options.startWaitMs ?? BACKGROUND_JOB_START_WAIT_MS);
          const { output, truncated } = options.jobs.read(options.chatId, started.id, START_OUTPUT_CHARS);
          if (settled.state === "running") {
            return textResult(
              [
                `Started ${statusLine(settled, now())}.`,
                outputBlock(output, truncated),
                `You will get a message in this chat when it ends on its own. Read its output with action "read" and job_id "${settled.id}", or end it with action "stop".`,
              ].join("\n\n"),
            );
          }
          return textResult(
            [`The job ended right away: ${statusLine(settled, now())}.`, outputBlock(output, truncated)].join("\n\n"),
            settled.state !== "exited",
          );
        }
        case "read": {
          const jobId = requireJobId(input.job_id);
          const { job, output, truncated } = options.jobs.read(options.chatId, jobId, input.max_chars ?? DEFAULT_READ_CHARS);
          return textResult([`${statusLine(job, now())}.`, outputBlock(output, truncated)].join("\n\n"));
        }
        case "list": {
          const jobs = options.jobs.list(options.chatId);
          if (!jobs.length) return textResult("This chat has no background jobs.");
          return textResult(jobs.map((job) => `- ${statusLine(job, now())}`).join("\n"));
        }
        case "stop": {
          const jobId = requireJobId(input.job_id);
          const stopped = await options.jobs.stop(options.chatId, jobId, "agent");
          const { output, truncated } = options.jobs.read(options.chatId, jobId, STOP_OUTPUT_CHARS);
          return textResult([`${statusLine(stopped, now())}.`, outputBlock(output, truncated)].join("\n\n"));
        }
        default:
          throw new Error('Use action "start", "read", "list" or "stop".');
      }
    },
  };
  // Starting a process is a side effect: never replay it after a crash.
  return declarePiRuntimeReplay(tool, "never");
}
