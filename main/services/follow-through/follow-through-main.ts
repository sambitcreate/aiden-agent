// Main-process follow-through: background jobs, followed pull requests and
// "done when" checks, wired to the chat. Each one turns its news into a
// follow-up notice through `noticeDelivery`, which queues it into a running
// answer, wakes an idle chat, or records it. State that must outlive a quit
// (follows and checks) is saved under userData; jobs stop when Aiden quits.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { app, ipcMain, logger } from "../../platform.js";
import { agentNotice, fenceAsData, tailText, type AgentNoticeV1 } from "../../../renderer/shared/agent-notices.js";
import type { BackgroundJobOutput } from "../../../renderer/shared/background-jobs.js";
import {
  emptyChatFollowThrough,
  type ChatFollowThroughV1,
} from "../../../renderer/shared/follow-through.js";
import { parseGitHubPullRequestUrl } from "../../../renderer/shared/chat-pull-requests.js";
import { agentShellCommandEnvironment } from "../agent-command-environment.js";
import { runBoundedShellCommand } from "../bounded-shell-command.js";
import { chatStore } from "../chat-store.js";
import { configStore } from "../config-store.js";
import { githubApi } from "../github/github-runtime-main.js";
import { hostPlatformCapabilities } from "../host-platform-capabilities.js";
import { hostRunRegistry } from "../host-runs-main.js";
import type { HostRunSummary } from "../host-run-registry.js";
import { llmClient } from "../llm-client.js";
import { BackgroundJobs, describeJobEnd, formatDuration, type BackgroundJobEnded } from "./background-jobs.js";
import { DoneWhenChecks, DONE_WHEN_TIMEOUT_MS, type DoneWhenRecord } from "./done-when.js";
import { noticeDelivery } from "./notice-delivery-main.js";
import type { PullRequestFollowRecord } from "./pull-request-follow.js";
import { PullRequestFollowReader } from "./pull-request-follow-github.js";
import { PullRequestFollows } from "./pull-request-follows.js";

const JOB_NOTICE_OUTPUT_CHARS = 3_000;
const MAX_CHECK_OUTPUT_BYTES = 10 * 1024 * 1024;
const RUN_WINDOW_SLACK_MS = 60_000;
const RUN_WINDOW_KEEP_MS = 2 * 24 * 60 * 60_000;

function followThroughDir(): string {
  return path.join(app.getPath("userData"), "follow-through");
}

function changed(chatId: string): void {
  ipcMain.broadcast("chats:follow-through-changed", { chatId });
}

// ── Saved state (follows and checks) ─────────────────────────────────────

interface SavedState {
  version: 1;
  follows: PullRequestFollowRecord[];
  checks: DoneWhenRecord[];
}

let savedFollows: PullRequestFollowRecord[] = [];
let savedChecks: DoneWhenRecord[] = [];
let saveChain: Promise<void> = Promise.resolve();
let saveScheduled = false;

function scheduleSave(): void {
  if (saveScheduled) return;
  saveScheduled = true;
  saveChain = saveChain
    .then(async () => {
      saveScheduled = false;
      const state: SavedState = { version: 1, follows: savedFollows, checks: savedChecks };
      await fsp.mkdir(followThroughDir(), { recursive: true, mode: 0o700 });
      const target = path.join(followThroughDir(), "state.json");
      const temporary = `${target}.${process.pid}.tmp`;
      await fsp.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await fsp.rename(temporary, target);
    })
    .catch((error: unknown) => {
      saveScheduled = false;
      logger.warn("follow-through", "Follow-through state could not be saved.", error);
    });
}

async function loadState(): Promise<SavedState> {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(followThroughDir(), "state.json"), "utf8")) as SavedState;
    if (parsed?.version === 1 && Array.isArray(parsed.follows) && Array.isArray(parsed.checks)) return parsed;
  } catch {
    // No saved state yet, or unreadable: start empty.
  }
  return { version: 1, follows: [], checks: [] };
}

// ── When each chat was answering (own-comment detection, check trigger) ──

const runStarts = new Map<string, { chatId: string; start: number }>();
const runWindows = new Map<string, Array<{ start: number; end: number }>>();
const settledRuns = new Set<string>();

function chatWasAnswering(chatId: string, at: number): boolean {
  for (const run of runStarts.values()) {
    if (run.chatId === chatId && at >= run.start - RUN_WINDOW_SLACK_MS) return true;
  }
  return (runWindows.get(chatId) ?? []).some(
    (window) => at >= window.start - RUN_WINDOW_SLACK_MS && at <= window.end + RUN_WINDOW_SLACK_MS,
  );
}

function observeRun(summary: HostRunSummary): void {
  const terminal = summary.state === "done" || summary.state === "failed" || summary.state === "cancelled";
  if (!terminal) {
    if (!runStarts.has(summary.runId)) {
      runStarts.set(summary.runId, { chatId: summary.chatId, start: Date.parse(summary.startedAt) || Date.now() });
    }
    return;
  }
  if (settledRuns.has(summary.runId)) return;
  settledRuns.add(summary.runId);
  if (settledRuns.size > 500) settledRuns.delete(settledRuns.values().next().value!);
  const start = runStarts.get(summary.runId)?.start ?? (Date.parse(summary.startedAt) || Date.now());
  runStarts.delete(summary.runId);
  const now = Date.now();
  const windows = (runWindows.get(summary.chatId) ?? []).filter((window) => window.end > now - RUN_WINDOW_KEEP_MS);
  windows.push({ start, end: Date.parse(summary.updatedAt) || now });
  runWindows.set(summary.chatId, windows.slice(-50));
  if (summary.state === "done" && doneWhen.get(summary.chatId)?.state === "waiting") {
    void (async () => {
      await llmClient.waitForChatIdle(summary.chatId);
      if (!llmClient.isChatBusy(summary.chatId)) doneWhen.answerFinished(summary.chatId);
    })().catch((error: unknown) => logger.warn("follow-through", "The done-when check could not start.", error));
  }
}

// ── Notices ───────────────────────────────────────────────────────────────

function postNotice(chatId: string, notice: AgentNoticeV1, text: string, wake: boolean): void {
  void noticeDelivery.post({ chatId, notice, text, wake });
}

function jobEndedNotice({ job, tail }: BackgroundJobEnded): void {
  const ok = job.state === "exited";
  const label = job.description || job.command;
  const elapsed = formatDuration((job.endedAt ?? Date.now()) - job.startedAt);
  const ending = describeJobEnd(job);
  const output = tail.trim()
    ? fenceAsData("End of its output", tailText(tail.trimEnd(), JOB_NOTICE_OUTPUT_CHARS).text)
    : "It printed nothing.";
  postNotice(
    job.chatId,
    agentNotice({
      source: "background_job",
      tone: ok ? "success" : "failure",
      title: ok ? "Background job finished" : "Background job failed",
      summary: `${label} · ${ending} after ${elapsed}`,
    }),
    [
      "[Aiden follow-up: background job]",
      `Background job ${job.id} (\`${job.command}\`) ${ending} after ${elapsed}.`,
      output,
      ok
        ? "Carry on with what this job was for, or tell the person it finished if that is all that was left."
        : "Look into why it ended and fix it if that is part of your task; otherwise tell the person.",
    ].join("\n\n"),
    true,
  );
}

// ── The three services ─────────────────────────────────────────────────────

export const backgroundJobs = new BackgroundJobs({
  logDir: path.join(app.getPath("userData"), "background-jobs"),
  onEnded: jobEndedNotice,
  onChange: changed,
  log: (message, error) => logger.warn("background-jobs", message, error),
});

export const doneWhen = new DoneWhenChecks({
  run: async (record, signal) => {
    const workspace = await configStore.getWorkspace(record.workspaceId);
    if (!workspace?.folderPath || workspace.permission === "none") {
      return { exitCode: null, timedOut: false, aborted: false, output: "Folder access is off for this chat, so the check could not run." };
    }
    const result = await runBoundedShellCommand({
      command: record.command,
      cwd: workspace.folderPath,
      env: agentShellCommandEnvironment(),
      timeoutMs: DONE_WHEN_TIMEOUT_MS,
      maxOutputBytes: MAX_CHECK_OUTPUT_BYTES,
      signal,
    });
    return {
      exitCode: result.outputLimitExceeded ? null : result.exitCode,
      timedOut: result.timedOut,
      aborted: result.aborted,
      output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
    };
  },
  post: ({ chatId, notice, text, wake }) => postNotice(chatId, notice, text, wake),
  persist: (records) => {
    savedChecks = records;
    scheduleSave();
  },
  onChange: changed,
  now: Date.now,
});

export const pullRequestFollows = new PullRequestFollows({
  reader: new PullRequestFollowReader(githubApi),
  post: (chatId, { notice, text, wake }) => postNotice(chatId, notice, text, wake),
  persist: (records) => {
    savedFollows = records;
    scheduleSave();
  },
  onChange: changed,
  chatWasAnswering,
  now: Date.now,
  log: (message, error) => logger.warn("follow-through", message, error),
});

// ── Lifecycle ─────────────────────────────────────────────────────────────

let started = false;

export async function startFollowThrough(): Promise<void> {
  if (started) return;
  started = true;
  hostRunRegistry.onChange((summary, removed) => {
    if (!removed) observeRun(summary);
  });
  if (hostPlatformCapabilities().backgroundJobs) {
    const reaped = await backgroundJobs.reapPreviousLaunch().catch(() => 0);
    if (reaped) logger.info("background-jobs", `Stopped ${reaped} background job(s) left from the last launch.`);
  }
  const state = await loadState();
  savedFollows = state.follows;
  savedChecks = state.checks;
  pullRequestFollows.restore(state.follows);
  doneWhen.restore(state.checks);
  pullRequestFollows.start();
}

export async function shutdownFollowThrough(): Promise<void> {
  pullRequestFollows.shutdown();
  doneWhen.shutdown();
  await backgroundJobs.shutdown();
  await saveChain;
}

/** A deleted chat loses its jobs, follows and check. */
export async function deleteChatFollowThrough(chatId: string): Promise<void> {
  pullRequestFollows.deleteChat(chatId);
  doneWhen.clear(chatId);
  runWindows.delete(chatId);
  for (const [runId, run] of runStarts) if (run.chatId === chatId) runStarts.delete(runId);
  await backgroundJobs.stopChat(chatId, "chat-deleted", true);
}

/** Folder access changed: what ran in that folder stops. */
export async function closeWorkspaceFollowThrough(workspaceId: string): Promise<void> {
  doneWhen.clearWorkspace(workspaceId);
  await backgroundJobs.stopWorkspace(workspaceId, "access-changed");
}

// ── Reads and actions for the renderer and tools ───────────────────────────

export function chatFollowThrough(chatId: string): ChatFollowThroughV1 {
  const check = doneWhen.get(chatId);
  return {
    ...emptyChatFollowThrough(chatId),
    jobs: backgroundJobs.list(chatId),
    pullRequests: pullRequestFollows.list(chatId),
    check: check
      ? {
          command: check.command,
          state: check.state,
          checksRun: check.checksRun,
          setAt: check.setAt,
          ...(check.lastRunAt !== undefined ? { lastRunAt: check.lastRunAt } : {}),
          ...(check.lastExitCode !== undefined ? { lastExitCode: check.lastExitCode } : {}),
          ...(check.lastTimedOut ? { lastTimedOut: true } : {}),
        }
      : null,
  };
}

export function readJobOutput(chatId: string, jobId: string): BackgroundJobOutput {
  return backgroundJobs.read(chatId, jobId);
}

export async function stopJobForPerson(chatId: string, jobId: string): Promise<void> {
  await backgroundJobs.stop(chatId, jobId, "person");
}

/** The chat's workspace, only when its folder is reachable with access on. */
export async function followThroughWorkspace(chatId: string): Promise<{ workspaceId: string; folderPath: string }> {
  const chat = await chatStore.get(chatId);
  if (!chat) throw new Error("The chat no longer exists.");
  if (chat.botId) throw new Error("Bots don't use this.");
  if (!chat.workspaceId) throw new Error("This chat has no folder.");
  const workspace = await configStore.getWorkspace(chat.workspaceId);
  if (!workspace?.folderPath || workspace.permission === "none") throw new Error("Folder access is off for this chat.");
  return { workspaceId: workspace.id, folderPath: workspace.folderPath };
}

export async function setDoneWhenCheck(chatId: string, command: string): Promise<void> {
  const { workspaceId } = await followThroughWorkspace(chatId);
  doneWhen.set({ chatId, workspaceId, command, runNow: !llmClient.isChatBusy(chatId) });
}

export function clearDoneWhenCheck(chatId: string): void {
  doneWhen.clear(chatId);
}

export interface PullRequestTarget {
  host: string;
  repository: string;
  number: number;
  url: string;
  title?: string;
}

/** A pull request URL, or the chat's current pull request when none is given. */
export async function resolvePullRequestTarget(
  chatId: string,
  url: string | undefined,
  currentPullRequest: (chatId: string) => Promise<{ pullRequest?: { host: string; repository: string; number: number; url: string; title?: string } | null }>,
): Promise<PullRequestTarget> {
  if (url) {
    const ref = parseGitHubPullRequestUrl(url);
    if (!ref) throw new Error("That is not a GitHub pull request link.");
    return { ...ref, url: `https://${ref.host}/${ref.repository}/pull/${ref.number}` };
  }
  const current = await currentPullRequest(chatId);
  if (!current.pullRequest) throw new Error("This chat has no pull request yet. Give its link.");
  const { host, repository, number, url: link, title } = current.pullRequest;
  return { host, repository, number, url: link, ...(title ? { title } : {}) };
}
