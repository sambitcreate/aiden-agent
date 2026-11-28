// Main-process follow-through: background jobs, followed pull requests,
// goal checks (`/until`) and check-backs, wired to the chat. Keep-going goals
// are saved here too (`goal/goal-main.ts` runs them, and their checks run
// here). Each one turns its news into a follow-up notice through
// `noticeDelivery`, which queues it into a running answer, wakes an idle chat,
// or records it. State that must outlive a quit (follows, goals and
// check-backs) is saved under userData; jobs and checks stop when Aiden quits.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { app, ipcMain, logger } from "../../platform.js";
import {
  agentNotice,
  fenceAsData,
  tailText,
  type AgentNoticeV1,
} from "../../../renderer/shared/agent-notices.js";
import type {
  BackgroundJobOutput,
  BackgroundJobView,
} from "../../../renderer/shared/background-jobs.js";
import {
  emptyChatFollowThrough,
  type ChatFollowThroughV1,
} from "../../../renderer/shared/follow-through.js";
import { parseGitHubPullRequestUrl } from "../../../renderer/shared/chat-pull-requests.js";
import { agentShellCommandEnvironment } from "../agent-command-environment.js";
import { assertManagedWorktreeAdmission } from "../managed-worktree-admission.js";
import {
  WorkspaceMutationGate,
  workspaceMutationGate,
  commitWithWorkspaceMutationAdmission,
} from "../workspace-mutation-gate.js";
import { WorkspaceOperationRegistry } from "../workspace-operation-registry.js";
import { runBoundedShellCommand } from "../bounded-shell-command.js";
import { chatStore } from "../chat-store.js";
import { configStore } from "../config-store.js";
import { githubApi } from "../github/github-runtime-main.js";
import { hostPlatformCapabilities } from "../host-platform-capabilities.js";
import { hostRunRegistry } from "../host-runs-main.js";
import type { HostRunSummary } from "../host-run-registry.js";
import { llmClient } from "../llm-client.js";
import {
  BACKGROUND_JOB_MARKER,
  BackgroundJobLimitError,
  BackgroundJobs,
  describeJobEnd,
  formatDuration,
  newBackgroundJobId,
  type BackgroundJobEnded,
} from "./background-jobs.js";
import type { RunCommandLeftovers } from "../coding-tools.js";
import { ChatSettlement } from "./chat-settlement.js";
import { randomUUID } from "node:crypto";
import {
  CheckInterruptedError,
  DONE_WHEN_TIMEOUT_MS,
  GoalCheckRunner,
  migrateDoneWhenRecords,
  type GoalCheckResult,
} from "./done-when.js";
import { goalChatRefusal } from "../goal/goal-core.js";
import { noticeDelivery } from "./notice-delivery-main.js";
import {
  commandMayChangePullRequest,
  type PullRequestFollowRecord,
} from "./pull-request-follow.js";
import { PullRequestFollowReader } from "./pull-request-follow-github.js";
import { PullRequestFollows } from "./pull-request-follows.js";
import { AnsweringRuns } from "./answering-runs.js";
import { CheckBacks, type CheckBackRecord } from "./check-backs.js";
import { systemTimezone } from "../schedule-store-core.js";
import { parseGoalRecords, type GoalRecordV1 } from "../../../renderer/shared/goal.js";
import { goalTurnHooks } from "../goal/goal-turn-hooks.js";

const chatConfiguration = new WorkspaceMutationGate();
const commandHandoffs = new WorkspaceOperationRegistry();
const JOB_NOTICE_OUTPUT_CHARS = 3_000;
const MAX_CHECK_OUTPUT_BYTES = 10 * 1024 * 1024;

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
  /**
   * `/until` checks from releases before they became goals; migrated into
   * `goals` on launch and always written empty, so older releases still read the file.
   */
  checks: unknown[];
  /** Absent in files older releases wrote. */
  checkBacks?: CheckBackRecord[];
  /** Keep-going goals, one per chat. Absent in files older releases wrote. */
  goals?: GoalRecordV1[];
}

let savedFollows: PullRequestFollowRecord[] = [];
let savedCheckBacks: CheckBackRecord[] = [];
let savedGoals: GoalRecordV1[] = [];
/** `/until` checks from an older release whose chat couldn't be read yet: kept for the next launch. */
let savedLegacyChecks: unknown[] = [];
let saveChain: Promise<void> = Promise.resolve();
let saveScheduled = false;

function scheduleSave(): void {
  if (saveScheduled) return;
  saveScheduled = true;
  saveChain = saveChain
    .then(async () => {
      saveScheduled = false;
      const state: SavedState = {
        version: 1,
        follows: savedFollows,
        checks: savedLegacyChecks,
        checkBacks: savedCheckBacks,
        goals: savedGoals,
      };
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
    const parsed = JSON.parse(
      await fsp.readFile(path.join(followThroughDir(), "state.json"), "utf8"),
    ) as SavedState;
    if (parsed?.version === 1 && Array.isArray(parsed.follows) && Array.isArray(parsed.checks))
      return parsed;
  } catch {
    // No saved state yet, or unreadable: start empty.
  }
  return { version: 1, follows: [], checks: [], checkBacks: [] };
}

// ── When each chat was answering (own-comment detection, check trigger) ──

const answeringRuns = new AnsweringRuns({ isChatBusy: (chatId) => llmClient.isChatBusy(chatId) });
const settledRuns = new Set<string>();
/** Recently deleted chats, so a run that ends after its chat is gone leaves no window behind. */
const deletedChats = new Set<string>();

function chatWasAnswering(chatId: string, at: number): boolean {
  return answeringRuns.wasAnswering(chatId, at);
}

/** The registry dropped a run: one evicted while running will never report its end. */
function observeRemovedRun(summary: HostRunSummary): void {
  if (settledRuns.has(summary.runId) || deletedChats.has(summary.chatId)) return;
  answeringRuns.hostRunChanged(summary, true);
  chatSettlement.hostRunChanged(summary, true);
}

function observeRun(summary: HostRunSummary): void {
  const terminal =
    summary.state === "done" || summary.state === "failed" || summary.state === "cancelled";
  if (!terminal) {
    if (deletedChats.has(summary.chatId)) return;
    answeringRuns.hostRunChanged(summary, false);
    chatSettlement.hostRunChanged(summary, false);
    return;
  }
  if (settledRuns.has(summary.runId)) return;
  settledRuns.add(summary.runId);
  if (settledRuns.size > 500) settledRuns.delete(settledRuns.values().next().value!);
  if (deletedChats.has(summary.chatId)) return;
  answeringRuns.hostRunChanged(summary, false);
  chatSettlement.hostRunChanged(summary, false);
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
  onChange: (chatId) => {
    changed(chatId);
    if (!deletedChats.has(chatId)) chatSettlement.jobsChanged(chatId);
  },
  log: (message, error) => logger.warn("background-jobs", message, error),
});

/** Jobs the agent marked `stop_when_chat_settles` stop 20 minutes after their chat goes quiet. */
export const chatSettlement = new ChatSettlement({
  hasStoppableJobs: (chatId) => backgroundJobs.hasSettleStoppable(chatId),
  // The desktop composer's queue lives in the window; a queued message that
  // sends starts an answer, which cancels the window.
  isChatBusy: (chatId) => llmClient.isChatBusy(chatId) || noticeDelivery.hasPending(chatId),
  stopSettled: (chatId) => backgroundJobs.stopSettled(chatId),
  log: (message, error) => logger.warn("background-jobs", message, error),
});

/**
 * Goal checks (`/until`): one command at a time per chat, in the chat's
 * workspace folder, with the same admission, process-group record and
 * recovery as a background job.
 */
export const goalChecks = new GoalCheckRunner({
  run: async (record, signal) => {
    const chat = await chatStore.get(record.chatId);
    const workspace = await configStore.getWorkspace(record.workspaceId);
    signal.throwIfAborted();
    if (
      !chat ||
      chat.workspaceId !== workspace?.id ||
      !workspace?.folderPath ||
      workspace.permission === "none"
    ) {
      throw new CheckInterruptedError(
        "Folder access is off for this chat, so the check can't run.",
      );
    }
    await assertManagedWorktreeAdmission(workspace);
    signal.throwIfAborted();
    if (workspaceMutationGate.isChanging(workspace.id)) {
      return { exitCode: null, timedOut: false, aborted: true, output: "" };
    }
    const id = newBackgroundJobId();
    const result = await runBoundedShellCommand({
      command: record.command,
      cwd: workspace.folderPath,
      env: { ...agentShellCommandEnvironment(), [BACKGROUND_JOB_MARKER]: id },
      timeoutMs: DONE_WHEN_TIMEOUT_MS,
      maxOutputBytes: MAX_CHECK_OUTPUT_BYTES,
      signal,
      recordGroup: (pid) => backgroundJobs.recordCheckGroup(id, pid, workspace.id, record.chatId),
    });
    return {
      exitCode: result.outputLimitExceeded ? null : result.exitCode,
      timedOut: result.timedOut,
      aborted: result.aborted,
      output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
    };
  },
  onChange: changed,
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

/** Settings → Scheduled tasks → "Let chats check back later" (on unless turned off). */
export async function chatCheckBacksEnabled(): Promise<boolean> {
  return (await configStore.getSettings()).chatCheckBacks !== false;
}

export const checkBacks = new CheckBacks({
  persist: (records) => {
    savedCheckBacks = records;
    scheduleSave();
  },
  flush: () => saveChain,
  post: (post) => noticeDelivery.post(post),
  onChange: changed,
  enabled: () => hostPlatformCapabilities().chatCheckBacks && chatCheckBacksEnabled(),
  timezone: systemTimezone,
  now: Date.now,
  log: (message, error) => logger.warn("follow-through", message, error),
});

/**
 * A push Aiden made (the Push dialog, a paired device, or the agent): read
 * the followed pull requests in that repository soon. `repository` is the
 * credential-free `host/owner/name` the push captured; without one the timed
 * read still catches the change.
 */
export function pullRequestBranchPushed(repository: string | undefined): void {
  const selector = repository?.toLowerCase();
  if (!selector) return;
  for (const chatId of new Set(pullRequestFollows.all().map((follow) => follow.chatId))) {
    pullRequestFollows.nudge(
      chatId,
      "action",
      (follow) => `${follow.host}/${follow.repository}`.toLowerCase() === selector,
    );
  }
}

/**
 * `run_command` in a workspace chat: each command's processes carry a fresh
 * job marker, and whatever the command leaves running becomes one of the
 * chat's background jobs.
 */
export function runCommandLeftovers(input: {
  chatId: string;
  workspaceId: string;
  cwd: string;
}): RunCommandLeftovers {
  return {
    begin() {
      if (workspaceMutationGate.isChanging(input.workspaceId))
        throw new Error("The workspace is changing.");
      const operation = commandHandoffs.admit(input.workspaceId);
      const id = newBackgroundJobId();
      return {
        signal: operation.signal,
        release: operation.release,
        // A push or `gh pr comment` from the agent: read this chat's follows soon.
        finished: (command) => {
          if (commandMayChangePullRequest(command))
            pullRequestFollows.nudge(input.chatId, "action");
        },
        env: { [BACKGROUND_JOB_MARKER]: id },
        adopt: async (processGroup, command, description, output) => {
          let job: BackgroundJobView | undefined;
          try {
            job = await backgroundJobs.adopt({
              id,
              ...input,
              command,
              ...(description ? { description } : {}),
              processGroup,
              ...(output ? { output } : {}),
            });
          } catch (error) {
            if (!(error instanceof BackgroundJobLimitError)) throw error;
            return {
              note: `[Aiden: this command left processes running, but they are not tracked: ${error.message} Stop them yourself if they should not keep running.]`,
              adopted: false,
            };
          }
          if (!job) return undefined;
          const note = [
            `[Aiden: this command left processes running. They are now background job ${job.id}: the person sees it beside the chat with a Stop button, and it stops when the chat is deleted or Aiden quits.`,
            output
              ? `Read its output with background_job action "read".`
              : "Its output went elsewhere, so Aiden does not capture it.",
            "Next time, start servers and watchers with the background_job tool.]",
          ].join(" ");
          return { note, adopted: true };
        },
      };
    },
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

let started = false;

export async function reapFollowThroughProcesses(): Promise<void> {
  if (hostPlatformCapabilities().backgroundJobs) {
    const reaped = await backgroundJobs.reapPreviousLaunch();
    if (reaped)
      logger.info(
        "background-jobs",
        `Stopped ${reaped} background job(s) left from the last launch.`,
      );
  }
}

export async function startFollowThrough(): Promise<void> {
  if (started) return;
  started = true;
  hostRunRegistry.onChange((summary, removed) => {
    if (removed) observeRemovedRun(summary);
    else observeRun(summary);
  });
  const state = await loadState();
  savedFollows = state.follows;
  savedCheckBacks = Array.isArray(state.checkBacks) ? state.checkBacks : [];
  savedGoals = parseGoalRecords(state.goals);
  // `/until` checks saved before they became goals come back as paused goals,
  // in chats that can still have one. A check whose chat can't be read now
  // stays saved, for the next launch.
  const savedChecks: unknown[] = Array.isArray(state.checks) ? state.checks : [];
  const eligibility = new Map<string, boolean | undefined>();
  for (const entry of savedChecks) {
    const chatId = (entry as { chatId?: unknown } | null)?.chatId;
    if (typeof chatId !== "string" || eligibility.has(chatId)) continue;
    try {
      eligibility.set(chatId, goalChatRefusal(await chatStore.get(chatId)) === undefined);
    } catch (error) {
      logger.warn(
        "follow-through",
        "A saved check's chat could not be read; it stays for the next launch.",
        error,
      );
      eligibility.set(chatId, undefined);
    }
  }
  const migration = migrateDoneWhenRecords(savedChecks, savedGoals, {
    now: Date.now(),
    newId: () => `goal-${randomUUID()}`,
    eligible: (chatId) => eligibility.get(chatId),
  });
  savedLegacyChecks = migration.kept;
  if (migration.goals.length > 0) savedGoals = [...savedGoals, ...migration.goals];
  if (migration.goals.length > 0 || savedLegacyChecks.length !== savedChecks.length) scheduleSave();
  pullRequestFollows.restore(state.follows);
  checkBacks.restore(savedCheckBacks);
  // Older releases could leave persisted follows behind after access was revoked.
  for (const follow of pullRequestFollows.all()) {
    if (follow.state !== "following") continue;
    try {
      const chat = await chatStore.get(follow.chatId);
      const workspace = chat?.workspaceId
        ? await configStore.getWorkspace(chat.workspaceId)
        : undefined;
      if (workspace?.folderPath && workspace.permission !== "none") continue;
    } catch (error) {
      logger.warn(
        "follow-through",
        "Could not verify workspace access for a restored pull request follow.",
        error,
      );
    }
    pullRequestFollows.stop(follow.chatId, follow, "access-changed");
  }
  pullRequestFollows.start();
}

export async function shutdownFollowThrough(): Promise<void> {
  // First, so a check-back notice going out finishes and is saved as fired below.
  await checkBacks.shutdown();
  chatSettlement.shutdown();
  answeringRuns.shutdown();
  pullRequestFollows.shutdown();
  await goalChecks.shutdown();
  await backgroundJobs.shutdown();
  await saveChain;
}

/** The keep-going goals saved with follow-through, as loaded by `startFollowThrough`. */
export function savedFollowThroughGoals(): readonly GoalRecordV1[] {
  return savedGoals;
}

/** Saves the keep-going goals with the rest of follow-through. */
export function saveFollowThroughGoals(goals: readonly GoalRecordV1[]): void {
  savedGoals = [...goals];
  scheduleSave();
}

/** A deleted chat loses its jobs, follows, check, check-backs and goal. */
export async function deleteChatFollowThrough(chatId: string): Promise<void> {
  pullRequestFollows.deleteChat(chatId);
  goalTurnHooks().chatDeleted(chatId);
  checkBacks.deleteChat(chatId);
  const checkStopped = goalChecks.stopChat(chatId);
  answeringRuns.deleteChat(chatId);
  chatSettlement.clear(chatId);
  deletedChats.add(chatId);
  if (deletedChats.size > 500) deletedChats.delete(deletedChats.values().next().value!);
  await Promise.all([checkStopped, backgroundJobs.stopChat(chatId, "chat-deleted", true)]);
}

/** A delete that rolled back before its durable boundary leaves the chat in use: observe its runs again. */
export function restoreChatFollowThrough(chatId: string): void {
  deletedChats.delete(chatId);
}

/** Folder access changed: what ran in that folder stops. */
export async function closeWorkspaceFollowThrough(
  workspaceId: string,
): Promise<(committed: boolean) => Promise<void>> {
  const chatIds = (await chatStore.list(workspaceId)).map((chat) => chat.id);
  const resumePolls = pullRequestFollows.pauseChats(chatIds);
  try {
    await Promise.all([
      goalChecks.interruptWorkspace(workspaceId),
      commandHandoffs.cancelAndSettle(workspaceId),
    ]);
    // Stopping the jobs clears each chat's quiet window through `jobsChanged`.
    await backgroundJobs.stopWorkspace(workspaceId, "access-changed");
  } catch (error) {
    resumePolls();
    throw error;
  }
  return async (committed) => {
    try {
      if (committed) {
        for (const chatId of chatIds) {
          for (const follow of pullRequestFollows.list(chatId))
            pullRequestFollows.stop(chatId, follow, "access-changed");
        }
        goalTurnHooks().accessChanged(chatIds);
        await saveChain;
      }
    } finally {
      resumePolls();
    }
  };
}

// ── Reads and actions for the renderer and tools ───────────────────────────

export function chatFollowThrough(chatId: string): ChatFollowThroughV1 {
  return {
    ...emptyChatFollowThrough(chatId),
    jobs: backgroundJobs.list(chatId),
    pullRequests: pullRequestFollows.list(chatId),
    checkBacks: checkBacks.list(chatId),
  };
}

/** The person cancelled a check-back from the composer chip. */
export async function cancelCheckBackForPerson(chatId: string, id: string): Promise<void> {
  const outcome = await checkBacks.cancel(chatId, id);
  if (!outcome.ok) throw new Error("That check-back already ran or was cancelled.");
}

/** The person turned "Let chats check back later" off: every pending one is cancelled. */
export function chatCheckBacksSwitched(enabled: boolean): void {
  if (!enabled) checkBacks.cancelAll();
}

export function readJobOutput(chatId: string, jobId: string): BackgroundJobOutput {
  const output = backgroundJobs.read(chatId, jobId);
  // The person is looking at the chat's jobs: its quiet window starts over.
  chatSettlement.personActive(chatId);
  return output;
}

export async function stopJobForPerson(chatId: string, jobId: string): Promise<void> {
  await backgroundJobs.stop(chatId, jobId, "person");
}

/** Hold configuration admission across chat and workspace reads and PR resolution. */
async function configureFollowThrough(
  chatId: string,
  prepare: (workspaceId: string) => Promise<() => void>,
): Promise<void> {
  const admission = chatConfiguration.admit(chatId);
  try {
    const chat = await chatStore.get(chatId);
    if (
      !hostPlatformCapabilities().backgroundJobs ||
      !chat?.workspaceId ||
      chat.botId ||
      chat.owner
    ) {
      throw new Error("Follow-through requires a workspace chat on this computer.");
    }
    const workspaceId = chat.workspaceId;
    await commitWithWorkspaceMutationAdmission(workspaceMutationGate, workspaceId, async () => {
      const workspace = await configStore.getWorkspace(workspaceId);
      if (!workspace?.folderPath || workspace.permission === "none")
        throw new Error("Folder access is off for this chat.");
      await assertManagedWorktreeAdmission(workspace);
      const commit = await prepare(workspaceId);
      return () => {
        admission.signal.throwIfAborted();
        if (deletedChats.has(chatId)) throw new Error("The chat is being deleted.");
        commit();
      };
    });
  } finally {
    admission.release();
  }
}

/** A move invalidates in-flight setup. An active check or undelivered result
 * still belongs to the old workspace, so the person must stop it first. */
export async function beginFollowThroughMove(chatId: string): Promise<() => void> {
  if (noticeDelivery.hasPending(chatId))
    throw new Error("Wait for this chat’s follow-up message before changing workspaces.");
  if (
    goalChecks.isRunning(chatId) ||
    pullRequestFollows.list(chatId).some((follow) => follow.state === "following")
  ) {
    throw new Error("Stop this chat’s check or pull request follow before changing workspaces.");
  }
  const goalRefusal = goalTurnHooks().moveRefusal(chatId);
  if (goalRefusal) throw new Error(goalRefusal);
  const finish = chatConfiguration.begin(chatId);
  try {
    await backgroundJobs.confirmChatChecksStopped(chatId);
    return finish;
  } catch (error) {
    finish();
    throw error;
  }
}

/** Throws why this chat can't run a goal check: not a workspace chat on this computer, folder access off, a replaced worktree. */
export function prepareGoalCheck(chatId: string): Promise<void> {
  return configureFollowThrough(chatId, async () => () => undefined);
}

/** Runs a command goal's check in the chat's workspace folder. */
export async function runGoalCheck(
  chatId: string,
  command: string,
  signal: AbortSignal,
): Promise<GoalCheckResult> {
  const chat = await chatStore.get(chatId);
  if (!chat?.workspaceId)
    return { kind: "stopped", summary: "This chat has no folder, so the check can't run." };
  return goalChecks.run({ chatId, workspaceId: chat.workspaceId, command }, signal);
}

export function followChatPullRequest(
  chatId: string,
  resolve: () => Promise<PullRequestTarget>,
): Promise<void> {
  return configureFollowThrough(chatId, async () => {
    const target = await resolve();
    return () => {
      pullRequestFollows.follow({ chatId, ...target, startedBy: "person" });
    };
  });
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
  currentPullRequest: (
    chatId: string,
  ) => Promise<{
    pullRequest?: {
      host: string;
      repository: string;
      number: number;
      url: string;
      title?: string;
    } | null;
  }>,
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
