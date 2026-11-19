import { assertArtifactFilePath, WorkspaceArtifactFileDeniedError } from "./file-policy.js";
import * as fs from "node:fs/promises";
import {
  parseWorkspaceArtifactOutput,
  resolveWorkspaceArtifactCommand,
  WORKSPACE_ARTIFACT_LIMITS,
  workspaceArtifactCommandAccess,
  workspaceArtifactSourceAccess,
  type WorkspaceArtifactPermission,
  type WorkspaceArtifactSourceResultV1,
  type WorkspaceArtifactSourceV1,
  type WorkspaceArtifactsChangedEvent,
  type WorkspaceArtifactV1,
  type WorkspaceArtifactView,
} from "../../../renderer/shared/workspace-artifacts.js";
import type { BoundedShellCommandOptions, BoundedShellCommandResult } from "../bounded-shell-command.js";
import { ManagedWorktreeFileIoError } from "../managed-worktree-file-io.js";
import { MAX_EDITOR_LINES } from "../workspace-files.js";
import type { ArgvPlanOptions } from "./argv-runner.js";
import type { WorkspaceArtifactStore } from "./store.js";

/**
 * Runs workspace artifact sources and buttons in the workspace folder, under
 * the same access the workspace gives chats: None runs nothing, Ask runs
 * shell commands only once the person approved this exact set, Full runs
 * them. File sources read through the bounded workspace file reader.
 */

export interface WorkspaceArtifactRunContext {
  /** The workspace folder, already resolved (realpath) by the caller. */
  folderPath: string | undefined;
  permission: WorkspaceArtifactPermission;
}

export interface WorkspaceArtifactRunnerDependencies {
  runShell: (options: BoundedShellCommandOptions) => Promise<BoundedShellCommandResult>;
  /** Runs a button whose command takes page data, as argument lists without a shell (`runArgvPlan`). */
  runArgv: (options: ArgvPlanOptions) => Promise<BoundedShellCommandResult>;
  /** Reads a workspace-relative file inside the folder; rejects paths that leave it. */
  readFile: (root: string, file: string, signal: AbortSignal | undefined) => Promise<string>;
  /** Environment for shell commands (the agent's shell PATH and variables). */
  env: () => NodeJS.ProcessEnv;
  store: Pick<WorkspaceArtifactStore, "get" | "saveSnapshot">;
  notify: (event: WorkspaceArtifactsChangedEvent) => void;
}

export interface WorkspaceArtifactActionResult {
  ok: boolean;
  /** Combined output, trimmed and capped, for the toast. */
  output: string;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * The start and the end of `text` within `max` characters: a command's usage
 * line or first complaint is at the start, and the error that stopped it is
 * usually at the end.
 */
function headAndTail(text: string, max: number): string {
  const trimmed = text.trim();
  const gap = " … ";
  if (trimmed.length <= max || max < 2 * gap.length) return clip(trimmed, max);
  const room = max - gap.length;
  const head = Math.floor(room * 0.4);
  return `${trimmed.slice(0, head).trimEnd()}${gap}${trimmed.slice(trimmed.length - (room - head)).trimStart()}`;
}

function failure(result: BoundedShellCommandResult): string {
  const reason = result.timedOut
    ? "Timed out."
    : result.outputLimitExceeded
      ? "Printed more than an artifact can hold."
      : `Exited with code ${result.exitCode ?? "?"}.`;
  const detail = headAndTail(result.stderr || result.stdout, WORKSPACE_ARTIFACT_LIMITS.errorChars - reason.length - 1);
  return detail ? `${reason} ${detail}` : reason;
}

type SourceResults = Record<string, WorkspaceArtifactSourceResultV1>;

/** One refresh run, shared by every caller that asked for the same commands under the same access. */
interface SharedRefresh {
  /** Digest, approval, permission and resolved folder the run was started with. */
  key: string;
  promise: Promise<SourceResults>;
  /** Aborts the run once every caller has left. */
  controller: AbortController;
  callers: number;
  /** Order of starting; the newest live run for a page is the one that saves. */
  generation: number;
}

const FOLDER_UNAVAILABLE = "The workspace folder is unavailable.";

/** Options for the refresh that follows a save. */
export interface WorkspaceArtifactRefreshOptions {
  /**
   * The page as it was before this save. A source it had with the same
   * definition, whose last read succeeded and is still fresh, keeps that read
   * instead of running again.
   */
  reuseFrom?: Pick<WorkspaceArtifactV1, "revision" | "sources">;
}

function sameSource(a: WorkspaceArtifactSourceV1, b: WorkspaceArtifactSourceV1): boolean {
  if (a.name !== b.name || a.parse !== b.parse) return false;
  if (a.kind === "shell") return b.kind === "shell" && a.command === b.command;
  return b.kind === "file" && a.file === b.file;
}

/**
 * How long a read counts as fresh: the page's own interval, or for a page
 * without one the shortest interval a page may ask for.
 */
function freshForMs(artifact: Pick<WorkspaceArtifactV1, "refresh">): number {
  return (artifact.refresh.intervalSeconds ?? WORKSPACE_ARTIFACT_LIMITS.minIntervalSeconds) * 1000;
}

/**
 * The saved reads a refresh after a save may keep: a source whose definition
 * the save left unchanged (or the saved read already belongs to this
 * revision), whose last read succeeded within the freshness window, and
 * which this access would run now.
 */
function reusableReads(
  view: WorkspaceArtifactView,
  reuseFrom: WorkspaceArtifactRefreshOptions["reuseFrom"],
  approved: boolean,
  context: WorkspaceArtifactRunContext,
  now: number,
): SourceResults {
  const snapshot = view.snapshot;
  if (!reuseFrom || !snapshot) return {};
  const window = freshForMs(view.artifact);
  const reused: SourceResults = {};
  for (const source of view.artifact.sources) {
    const result = snapshot.sources[source.name];
    if (!result || result.status !== "ok" || result.dataJson === undefined) continue;
    if (!(now - result.at >= 0 && now - result.at < window)) continue;
    const before =
      snapshot.revision === view.artifact.revision
        ? source
        : snapshot.revision === reuseFrom.revision
          ? reuseFrom.sources.find((candidate) => candidate.name === source.name)
          : undefined;
    if (!before || !sameSource(before, source)) continue;
    if (workspaceArtifactSourceAccess(context.permission, Boolean(context.folderPath), source, approved) !== "run") continue;
    reused[source.name] = result;
  }
  return reused;
}

/** Resolves the folder as it is now: a folder that was removed or is no longer a directory runs nothing. */
async function verifiedFolder(folderPath: string): Promise<string> {
  try {
    const real = await fs.realpath(folderPath);
    if ((await fs.stat(real)).isDirectory()) return real;
  } catch {
    // Reported below.
  }
  throw new Error(FOLDER_UNAVAILABLE);
}

function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function tooLarge(file: string): string {
  return `${file} is larger than the ${WORKSPACE_ARTIFACT_LIMITS.sourceOutputBytes / 1024} KiB an artifact can read.`;
}

/** The workspace file reader speaks about editing; say what it means for a page. */
function fileError(file: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return `There is no file at ${file}.`;
  if (error instanceof ManagedWorktreeFileIoError && error.code === "too_many_bytes") return tooLarge(file);
  const message = error instanceof Error ? error.message : String(error);
  if (/too large/iu.test(message)) return tooLarge(file);
  if (/too many lines/iu.test(message)) return `${file} has more than ${MAX_EDITOR_LINES.toLocaleString("en-US")} lines, more than an artifact can read.`;
  if (/binary|not valid UTF-8/iu.test(message)) return `${file} is not a text file.`;
  return message;
}

function cancelledResults(sources: readonly WorkspaceArtifactSourceV1[]): SourceResults {
  const at = Date.now();
  return Object.fromEntries(sources.map((source) => [source.name, { status: "error", at, error: "Cancelled." } as const]));
}

export function createWorkspaceArtifactRunner(dependencies: WorkspaceArtifactRunnerDependencies) {
  const inFlight = new Map<string, SharedRefresh>();
  const generations = new Map<string, number>();
  /** Runs still going, per page. */
  const live = new Map<string, Set<SharedRefresh>>();
  /** The generation whose results each page last saved. */
  const savedGeneration = new Map<string, number>();

  /**
   * A run saves only when nothing newer has saved and no newer run is still
   * going, so data read under older commands, approval or access never
   * overwrites a newer read, and a cancelled newer run does not strand the page.
   */
  function shouldSave(id: string, entry: SharedRefresh): boolean {
    if (entry.controller.signal.aborted || entry.generation <= (savedGeneration.get(id) ?? 0)) return false;
    for (const other of live.get(id) ?? []) {
      if (other.generation > entry.generation && !other.controller.signal.aborted) return false;
    }
    return true;
  }

  async function runSource(
    source: WorkspaceArtifactSourceV1,
    approved: boolean,
    context: WorkspaceArtifactRunContext,
    signal: AbortSignal | undefined,
  ): Promise<WorkspaceArtifactSourceResultV1> {
    const at = Date.now();
    const access = workspaceArtifactSourceAccess(context.permission, Boolean(context.folderPath), source, approved);
    if (access === "blocked") return { status: "blocked", at, error: "Workspace access is off." };
    if (access === "needs-approval") return { status: "blocked", at, error: "Waiting for you to allow this page’s commands." };
    const root = context.folderPath!;
    let text: string;
    try {
      if (source.kind === "file") {
        try {
          assertArtifactFilePath(source.file);
          text = await withDeadline(
            dependencies.readFile(root, source.file, signal),
            WORKSPACE_ARTIFACT_LIMITS.sourceTimeoutMs,
            `Reading ${source.file} timed out.`,
          );
        } catch (error) {
          return { status: "error", at, ...(error instanceof WorkspaceArtifactFileDeniedError ? { policyDenied: true as const } : {}), error: clip(fileError(source.file, error), WORKSPACE_ARTIFACT_LIMITS.errorChars) };
        }
        if (Buffer.byteLength(text, "utf8") > WORKSPACE_ARTIFACT_LIMITS.sourceOutputBytes) {
          return { status: "error", at, error: tooLarge(source.file) };
        }
      } else {
        const result = await dependencies.runShell({
          command: source.command,
          cwd: root,
          env: dependencies.env(),
          timeoutMs: WORKSPACE_ARTIFACT_LIMITS.sourceTimeoutMs,
          maxOutputBytes: WORKSPACE_ARTIFACT_LIMITS.sourceOutputBytes,
          signal,
        });
        if (result.aborted) return { status: "error", at, error: "Cancelled." };
        if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) {
          return { status: "error", at, error: failure(result) };
        }
        text = result.stdout;
      }
    } catch (error) {
      return { status: "error", at, error: clip(error instanceof Error ? error.message : String(error), WORKSPACE_ARTIFACT_LIMITS.errorChars) };
    }
    const parsed = parseWorkspaceArtifactOutput(source.parse, text);
    return parsed.ok ? { status: "ok", at, dataJson: parsed.dataJson } : { status: "error", at, error: parsed.error };
  }

  /** Runs every source of one artifact once; results are not saved. */
  async function runSources(
    sources: readonly WorkspaceArtifactSourceV1[],
    approved: boolean,
    context: WorkspaceArtifactRunContext,
    signal: AbortSignal | undefined,
  ): Promise<SourceResults> {
    const entries = await Promise.all(
      sources.map(async (source) => [source.name, await runSource(source, approved, context, signal)] as const),
    );
    return Object.fromEntries(entries);
  }

  /**
   * Runs `sources` once in the workspace folder, as a refresh would, and
   * saves nothing: the tool's check of a page or of sources it means to save.
   * `approved` says whether the person allowed these exact shell commands.
   */
  async function check(
    sources: readonly WorkspaceArtifactSourceV1[],
    approved: boolean,
    context: WorkspaceArtifactRunContext,
    signal?: AbortSignal,
  ): Promise<SourceResults> {
    if (signal?.aborted) return cancelledResults(sources);
    let folderPath = context.folderPath;
    if (folderPath !== undefined) {
      try {
        folderPath = await verifiedFolder(folderPath);
      } catch (error) {
        const at = Date.now();
        const message = error instanceof Error ? error.message : FOLDER_UNAVAILABLE;
        return Object.fromEntries(sources.map((source) => [source.name, { status: "error", at, error: message } as const]));
      }
    }
    return runSources(sources, approved, { ...context, folderPath }, signal);
  }

  /**
   * Re-reads an artifact's sources, saves the snapshot and tells every
   * window. A run already going for the same commands under the same access
   * is shared; a caller that cancels leaves it, and the run stops only once
   * every caller has left.
   */
  async function refresh(
    workspaceId: string,
    artifactId: string,
    context: WorkspaceArtifactRunContext,
    signal?: AbortSignal,
    options: WorkspaceArtifactRefreshOptions = {},
  ): Promise<SourceResults> {
    const view = await dependencies.store.get(workspaceId, artifactId);
    if (!view) throw new Error("No artifact with that id exists in this workspace.");
    if (signal?.aborted) return cancelledResults(view.artifact.sources);
    const id = `${workspaceId}:${artifactId}`;
    const approved = view.artifact.approvedDigest === view.digest;
    // Resolved first, so the same folder reached through a link shares one run.
    let folderPath = context.folderPath;
    let folderError: string | undefined;
    if (folderPath !== undefined) {
      try {
        folderPath = await verifiedFolder(folderPath);
      } catch (error) {
        folderError = error instanceof Error ? error.message : FOLDER_UNAVAILABLE;
      }
    }
    if (signal?.aborted) return cancelledResults(view.artifact.sources);
    const fullKey = `${view.digest}\0${approved}\0${context.permission}\0${folderPath ?? ""}`;
    const reused =
      folderError === undefined ? reusableReads(view, options.reuseFrom, approved, { ...context, folderPath }, Date.now()) : {};
    const reusedNames = Object.keys(reused).sort();
    const key = reusedNames.length ? `${fullKey}\0reuse\0${reusedNames.join("\0")}` : fullKey;
    let shared = inFlight.get(id);
    // A run already reading every source is joined, whatever this one could keep.
    const joinable = shared && !shared.controller.signal.aborted && (shared.key === key || shared.key === fullKey);
    if (!shared || !joinable) {
      const controller = new AbortController();
      const generation = (generations.get(id) ?? 0) + 1;
      generations.set(id, generation);
      const entry: SharedRefresh = { key, controller, callers: 0, generation, promise: Promise.resolve({}) };
      entry.promise = (async () => {
        let results: SourceResults;
        if (folderError !== undefined) {
          const at = Date.now();
          results = Object.fromEntries(view.artifact.sources.map((source) => [source.name, { status: "error", at, error: folderError } as const]));
        } else {
          const toRun = view.artifact.sources.filter((source) => !(source.name in reused));
          const ran = await runSources(toRun, approved, { ...context, folderPath }, controller.signal);
          results = Object.fromEntries(view.artifact.sources.map((source) => [source.name, reused[source.name] ?? ran[source.name]!]));
        }
        if (!shouldSave(id, entry)) return results;
        // A page whose commands changed meanwhile is re-read by its own refresh; these results describe the old ones.
        const current = await dependencies.store.get(workspaceId, artifactId);
        if (!current || current.digest !== view.digest || !shouldSave(id, entry)) return results;
        savedGeneration.set(id, generation);
        await dependencies.store.saveSnapshot(workspaceId, current.artifact, results);
        dependencies.notify({ workspaceId, artifactId, reason: "refreshed" });
        return results;
      })().finally(() => {
        if (inFlight.get(id) === entry) inFlight.delete(id);
        const running = live.get(id);
        running?.delete(entry);
        if (running?.size === 0) live.delete(id);
      });
      inFlight.set(id, entry);
      live.set(id, (live.get(id) ?? new Set()).add(entry));
      shared = entry;
    }
    return join(shared, view.artifact.sources, signal);
  }

  function join(shared: SharedRefresh, sources: readonly WorkspaceArtifactSourceV1[], signal: AbortSignal | undefined) {
    shared.callers += 1;
    return new Promise<SourceResults>((resolve, reject) => {
      let left = false;
      const leave = () => {
        if (left) return false;
        left = true;
        signal?.removeEventListener("abort", onAbort);
        shared.callers -= 1;
        return true;
      };
      const onAbort = () => {
        if (!leave()) return;
        if (shared.callers === 0) shared.controller.abort();
        resolve(cancelledResults(sources));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      shared.promise.then(
        (results) => {
          if (leave()) resolve(results);
        },
        (error: unknown) => {
          if (leave()) reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /**
   * Runs one of the page's buttons with the values the page passed. The
   * command comes from the saved artifact, never from the renderer.
   */
  async function runAction(
    workspaceId: string,
    artifactId: string,
    actionName: string,
    args: readonly unknown[],
    context: WorkspaceArtifactRunContext,
    signal: AbortSignal | undefined,
    /** The page's command digest when the person pressed the button; a page changed since then does not run. */
    expectedDigest: string,
  ): Promise<WorkspaceArtifactActionResult> {
    const view = await dependencies.store.get(workspaceId, artifactId);
    if (!view) throw new Error("No artifact with that id exists in this workspace.");
    if (expectedDigest !== view.digest) {
      throw new Error("This page changed after you pressed the button. Try it again.");
    }
    const action = view.artifact.actions.find((entry) => entry.name === actionName);
    if (!action) throw new Error(`This page has no button named "${actionName}".`);
    const approved = view.artifact.approvedDigest === view.digest;
    const access = workspaceArtifactCommandAccess(context.permission, Boolean(context.folderPath), approved);
    if (access === "blocked") throw new Error("Workspace access is off, so this page’s buttons can’t run.");
    if (access === "needs-approval") throw new Error("Allow this page’s commands first.");
    const resolved = resolveWorkspaceArtifactCommand(action, args);
    const cwd = await verifiedFolder(context.folderPath!);
    const run = {
      cwd,
      env: dependencies.env(),
      timeoutMs: WORKSPACE_ARTIFACT_LIMITS.actionTimeoutMs,
      maxOutputBytes: WORKSPACE_ARTIFACT_LIMITS.sourceOutputBytes,
      signal,
    };
    // A command with page data never goes through a shell.
    const result = resolved.kind === "argv"
      ? await dependencies.runArgv({ ...run, steps: resolved.steps })
      : await dependencies.runShell({ ...run, command: resolved.command });
    if (result.aborted) throw new Error("Cancelled.");
    const ok = result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded;
    const output = clip([result.stdout, result.stderr].filter(Boolean).join("\n"), WORKSPACE_ARTIFACT_LIMITS.actionOutputChars);
    return { ok, output: ok ? output : failure(result) };
  }

  return { refresh, runAction, check };
}

export type WorkspaceArtifactRunner = ReturnType<typeof createWorkspaceArtifactRunner>;
