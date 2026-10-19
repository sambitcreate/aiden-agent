import * as fs from "node:fs/promises";
import {
  parseWorkspaceArtifactOutput,
  resolveWorkspaceArtifactCommand,
  WORKSPACE_ARTIFACT_LIMITS,
  workspaceArtifactSourceAccess,
  type WorkspaceArtifactPermission,
  type WorkspaceArtifactSourceResultV1,
  type WorkspaceArtifactSourceV1,
  type WorkspaceArtifactV1,
  type WorkspaceArtifactsChangedEvent,
} from "../../../renderer/shared/workspace-artifacts.js";
import type { BoundedShellCommandOptions, BoundedShellCommandResult } from "../bounded-shell-command.js";
import { workspaceArtifactDigest, type WorkspaceArtifactStore } from "./store.js";

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

function failure(result: BoundedShellCommandResult): string {
  const reason = result.timedOut
    ? "Timed out."
    : result.outputLimitExceeded
      ? "Printed more than an artifact can hold."
      : `Exited with code ${result.exitCode ?? "?"}.`;
  const detail = clip(result.stderr || result.stdout, WORKSPACE_ARTIFACT_LIMITS.errorChars - reason.length - 1);
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

/** The workspace file reader speaks about editing; say what it means for a page. */
function fileError(file: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return `There is no file at ${file}.`;
  const message = error instanceof Error ? error.message : String(error);
  if (/too large|too many lines/iu.test(message)) return `${file} is larger than an artifact can read.`;
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
          text = await withDeadline(
            dependencies.readFile(root, source.file, signal),
            WORKSPACE_ARTIFACT_LIMITS.sourceTimeoutMs,
            `Reading ${source.file} timed out.`,
          );
        } catch (error) {
          return { status: "error", at, error: clip(fileError(source.file, error), WORKSPACE_ARTIFACT_LIMITS.errorChars) };
        }
        if (Buffer.byteLength(text, "utf8") > WORKSPACE_ARTIFACT_LIMITS.sourceOutputBytes) {
          return { status: "error", at, error: `${source.file} is larger than an artifact can read.` };
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
    artifact: Pick<WorkspaceArtifactV1, "sources" | "actions" | "approvedDigest">,
    context: WorkspaceArtifactRunContext,
    signal: AbortSignal | undefined,
  ): Promise<SourceResults> {
    const approved = artifact.approvedDigest === workspaceArtifactDigest(artifact.sources, artifact.actions);
    const entries = await Promise.all(
      artifact.sources.map(async (source) => [source.name, await runSource(source, approved, context, signal)] as const),
    );
    return Object.fromEntries(entries);
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
    const key = `${view.digest}\0${approved}\0${context.permission}\0${folderPath ?? ""}`;
    let shared = inFlight.get(id);
    if (!shared || shared.key !== key || shared.controller.signal.aborted) {
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
          results = await runSources(view.artifact, { ...context, folderPath }, controller.signal);
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
    signal?: AbortSignal,
    /** The page's command digest when the person pressed the button; a page changed since then does not run. */
    expectedDigest?: string,
  ): Promise<WorkspaceArtifactActionResult> {
    const view = await dependencies.store.get(workspaceId, artifactId);
    if (!view) throw new Error("No artifact with that id exists in this workspace.");
    if (expectedDigest !== undefined && expectedDigest !== view.digest) {
      throw new Error("This page changed after you pressed the button. Try it again.");
    }
    const action = view.artifact.actions.find((entry) => entry.name === actionName);
    if (!action) throw new Error(`This page has no button named "${actionName}".`);
    const approved = view.artifact.approvedDigest === view.digest;
    const access = workspaceArtifactSourceAccess(
      context.permission,
      Boolean(context.folderPath),
      { name: action.name, kind: "shell", command: action.command, parse: "text" },
      approved,
    );
    if (access === "blocked") throw new Error("Workspace access is off, so this page’s buttons can’t run.");
    if (access === "needs-approval") throw new Error("Allow this page’s commands first.");
    const { command } = resolveWorkspaceArtifactCommand(action, args);
    const cwd = await verifiedFolder(context.folderPath!);
    const result = await dependencies.runShell({
      command,
      cwd,
      env: dependencies.env(),
      timeoutMs: WORKSPACE_ARTIFACT_LIMITS.actionTimeoutMs,
      maxOutputBytes: WORKSPACE_ARTIFACT_LIMITS.sourceOutputBytes,
      signal,
    });
    if (result.aborted) throw new Error("Cancelled.");
    const ok = result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded;
    const output = clip([result.stdout, result.stderr].filter(Boolean).join("\n"), WORKSPACE_ARTIFACT_LIMITS.actionOutputChars);
    return { ok, output: ok ? output : failure(result) };
  }

  return { runSources, refresh, runAction };
}

export type WorkspaceArtifactRunner = ReturnType<typeof createWorkspaceArtifactRunner>;
