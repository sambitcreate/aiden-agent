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

export function createWorkspaceArtifactRunner(dependencies: WorkspaceArtifactRunnerDependencies) {
  const inFlight = new Map<string, Promise<Record<string, WorkspaceArtifactSourceResultV1>>>();

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
        text = await dependencies.readFile(root, source.file, signal);
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
  ): Promise<Record<string, WorkspaceArtifactSourceResultV1>> {
    const approved = artifact.approvedDigest === workspaceArtifactDigest(artifact.sources, artifact.actions);
    const entries = await Promise.all(
      artifact.sources.map(async (source) => [source.name, await runSource(source, approved, context, signal)] as const),
    );
    return Object.fromEntries(entries);
  }

  /**
   * Re-reads an artifact's sources, saves the snapshot and tells every
   * window. A refresh already running for the same artifact is shared.
   */
  function refresh(
    workspaceId: string,
    artifactId: string,
    context: WorkspaceArtifactRunContext,
    signal?: AbortSignal,
  ): Promise<Record<string, WorkspaceArtifactSourceResultV1>> {
    const key = `${workspaceId}:${artifactId}`;
    const running = inFlight.get(key);
    if (running) return running;
    const work = (async () => {
      const view = await dependencies.store.get(workspaceId, artifactId);
      if (!view) throw new Error("No artifact with that id exists in this workspace.");
      const results = await runSources(view.artifact, context, signal);
      if (signal?.aborted) return results;
      // Save against the artifact as it is now: a page updated meanwhile keeps only its own sources.
      const current = (await dependencies.store.get(workspaceId, artifactId))?.artifact;
      if (!current) return results;
      await dependencies.store.saveSnapshot(workspaceId, current, results);
      dependencies.notify({ workspaceId, artifactId, reason: "refreshed" });
      return results;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, work);
    return work;
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
  ): Promise<WorkspaceArtifactActionResult> {
    const view = await dependencies.store.get(workspaceId, artifactId);
    if (!view) throw new Error("No artifact with that id exists in this workspace.");
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
    const result = await dependencies.runShell({
      command,
      cwd: context.folderPath!,
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
