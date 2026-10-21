// Add a workspace from a typed path or by cloning a repository.
//
// Everything here re-validates renderer input. Inspection is read-only; only
// an explicit open-with-create makes a folder (one level, never recursive),
// and only an explicit clone runs Git against the network.

import * as path from "node:path";
import {
  parseCloneUrl,
  type WorkspaceCloneFailureCode,
  type WorkspaceClonePreview,
  type WorkspaceCloneProgress,
  type WorkspaceCloneResult,
  type WorkspaceOpenPathResult,
  type WorkspacePathInspection,
  type WorkspacePathInvalidCode,
} from "../../renderer/shared/workspace-intake.js";
import { redactUrlCredentials } from "../shared/redaction.js";
import type { Workspace } from "./types.js";

export const WORKSPACE_PATH_MAX_LENGTH = 4_096;

export type ParsedWorkspacePath =
  | { ok: true; path: string }
  | { ok: false; code: WorkspacePathInvalidCode; reason: string };

const invalid = (code: WorkspacePathInvalidCode, reason: string) =>
  ({ ok: false, code, reason }) as const;

/**
 * Normalize a typed path. Accepts `~`, `~/…`, absolute paths, and `.`/`..`
 * paths relative to `relativeBase` (the active workspace folder). Anything
 * else, including `~user`, is rejected rather than guessed at.
 */
export function parseWorkspacePathInput(
  value: unknown,
  options: { home: string; relativeBase?: string },
): ParsedWorkspacePath {
  if (typeof value !== "string") return invalid("empty", "Enter a folder path.");
  const typed = value.trim();
  if (!typed) return invalid("empty", "Enter a folder path.");
  if (typed.length > WORKSPACE_PATH_MAX_LENGTH) return invalid("too-long", "That path is too long.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(typed)) {
    return invalid("invalid-characters", "That path contains characters Aiden can't use.");
  }
  if (typed === "~" || typed.startsWith("~/")) {
    return { ok: true, path: path.resolve(options.home, typed.slice(2)) };
  }
  if (typed.startsWith("~")) {
    return invalid("unsupported-prefix", "Use ~/ for your home folder.");
  }
  if (path.isAbsolute(typed)) return { ok: true, path: path.resolve(typed) };
  if (typed === "." || typed === ".." || typed.startsWith("./") || typed.startsWith("../")) {
    if (!options.relativeBase || !path.isAbsolute(options.relativeBase)) {
      return invalid("no-relative-base", "Relative paths need a workspace folder to start from.");
    }
    return { ok: true, path: path.resolve(options.relativeBase, typed) };
  }
  return invalid("unsupported-prefix", "Start the path with /, ~ or .");
}

interface StatLike {
  isDirectory(): boolean;
}

interface LinkStatLike extends StatLike {
  isSymbolicLink(): boolean;
  isFile(): boolean;
}

/** Marks a staging folder as created by this clone; holds a random token. */
const CLONE_OWNER_MARKER = ".aiden-clone-owner";
/** Git clones into `<staging>/repo`; the user's destination is untouched until success. */
const CLONE_STAGING_REPO = "repo";

export interface WorkspaceIntakeDependencies {
  home: string;
  stat(target: string): Promise<StatLike>;
  /** Stat without following a final-component symlink. */
  lstat(target: string): Promise<LinkStatLike>;
  rename(from: string, to: string): Promise<void>;
  /** Create a private (0700) uniquely named directory from a path prefix. */
  mkdtemp(prefix: string): Promise<string>;
  /** Create a new file; fails if anything already exists at the path. */
  writeNewFile(target: string, content: string): Promise<void>;
  readFile(target: string): Promise<string>;
  /** An unguessable token for the staging owner marker. */
  randomId(): string;
  logError(area: string, message: string, error: unknown): void;
  realpath(target: string): Promise<string>;
  readdir(target: string): Promise<string[]>;
  /** Make exactly one directory; the parent must already exist. */
  mkdir(target: string): Promise<void>;
  rmdir(target: string): Promise<void>;
  /** Remove a tree without following symlinks inside it (`fs.rm` recursive). */
  removeTree(target: string): Promise<void>;
  listWorkspaces(): Promise<Workspace[]>;
  getWorkspace(id: string): Promise<Workspace | null | undefined>;
  /** The shared registration path used by the native folder picker. */
  createFromFolder(folderPath: string): Promise<Workspace>;
  runClone(request: GitCloneRequest): Promise<GitCloneOutcome>;
  /** Treat `Widget` and `widget` as one folder (default: macOS and Windows). */
  caseInsensitivePaths?: boolean;
}

export interface GitCloneRequest {
  url: string;
  destination: string;
  cwd: string;
  signal: AbortSignal;
  onProgress(progress: { phase: string; percent?: number }): void;
}

export type GitCloneOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: "cancelled" | "timeout" | "spawn-failed" | "exit";
      stderrTail: string;
    };

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? ((error as NodeJS.ErrnoException).code ?? undefined)
    : undefined;
}

function accessFailure(error: unknown, subject: "path" | "parent"): WorkspacePathInspection {
  const code = errnoCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return {
      kind: "invalid",
      code: "permission-denied",
      reason: subject === "path" ? "Aiden can't access that folder." : "Aiden can't access the parent folder.",
    };
  }
  if (code === "ENAMETOOLONG") return { kind: "invalid", code: "too-long", reason: "That path is too long." };
  if (code === "ENOTDIR") {
    return { kind: "invalid", code: "parent-not-a-folder", reason: "Part of that path is a file, not a folder." };
  }
  return { kind: "invalid", code: "unreadable", reason: "Aiden couldn't read that path." };
}

/** Redact and shorten Git's last stderr line for display. */
export function cloneFailureDetail(stderrTail: string, home: string): string | undefined {
  const lines = stderrTail
    .split(/[\r\n]+/u)
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:remote: )?[A-Za-z ]+:\s+\d{1,3}%/u.test(line));
  const last = lines[lines.length - 1];
  if (!last) return undefined;
  const withoutHome = home ? last.split(home).join("~") : last;
  return redactUrlCredentials(withoutHome).slice(0, 300);
}

/** Map Git's stderr to a short, typed failure the menu can show. */
export function classifyCloneFailure(
  stderrTail: string,
): { code: WorkspaceCloneFailureCode; reason: string } {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(stderrTail)) {
    return {
      code: "host-key",
      reason: "The host's SSH key isn't trusted yet. Connect to it once from Terminal, then try again.",
    };
  }
  if (
    /Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Permission denied \(|HTTP (?:401|403)|returned error: 40[13]/iu.test(
      stderrTail,
    )
  ) {
    return {
      code: "auth-failed",
      reason: "Git couldn't sign in. Check your Git credentials or SSH key for that host.",
    };
  }
  if (
    /Repository not found|not found|does not appear to be a git repository|HTTP 404|returned error: 404/iu.test(
      stderrTail,
    )
  ) {
    return { code: "not-found", reason: "That repository wasn't found, or you don't have access to it." };
  }
  if (
    /Could not resolve host|Could not resolve hostname|Connection refused|Connection timed out|Network is unreachable|Operation timed out|unable to access|Failed to connect/iu.test(
      stderrTail,
    )
  ) {
    return { code: "network", reason: "Git couldn't reach that host. Check the URL and your connection." };
  }
  return { code: "failed", reason: "Git couldn't clone that repository." };
}

/** `~/projects` when it exists, otherwise the home folder. */
export async function defaultCloneBaseDirectory(
  home: string,
  stat: (target: string) => Promise<StatLike>,
): Promise<string> {
  const projects = path.join(home, "projects");
  try {
    if ((await stat(projects)).isDirectory()) return projects;
  } catch {
    // Fall back to the home folder.
  }
  return home;
}

export interface CloneRequestInput {
  url: unknown;
  destination?: unknown;
}

export function createWorkspaceIntakeService(deps: WorkspaceIntakeDependencies) {
  const activeDestinations = new Set<string>();
  const caseInsensitivePaths =
    deps.caseInsensitivePaths ?? (process.platform === "darwin" || process.platform === "win32");

  const relativeBase = async (workspaceId: string | undefined): Promise<string | undefined> => {
    if (!workspaceId) return undefined;
    return (await deps.getWorkspace(workspaceId))?.folderPath ?? undefined;
  };

  const registeredAt = async (canonicalPath: string): Promise<Workspace | undefined> =>
    (await deps.listWorkspaces()).find((workspace) => workspace.folderPath === canonicalPath);

  const inspectResolved = async (target: string): Promise<WorkspacePathInspection> => {
    let stats: StatLike;
    try {
      stats = await deps.stat(target);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") return accessFailure(error, "path");
      const parent = path.dirname(target);
      try {
        const parentStats = await deps.stat(parent);
        if (!parentStats.isDirectory()) {
          return { kind: "invalid", code: "parent-not-a-folder", reason: "The parent is a file, not a folder." };
        }
      } catch (parentError) {
        if (errnoCode(parentError) === "ENOENT") {
          return { kind: "invalid", code: "parent-missing", reason: "The parent folder doesn't exist." };
        }
        return accessFailure(parentError, "parent");
      }
      return { kind: "creatable", path: target };
    }
    if (!stats.isDirectory()) {
      return { kind: "invalid", code: "not-a-folder", reason: "That path is a file, not a folder." };
    }
    let canonical: string;
    try {
      canonical = await deps.realpath(target);
    } catch (error) {
      return accessFailure(error, "path");
    }
    const existing = await registeredAt(canonical);
    if (existing) return { kind: "existing-workspace", workspaceId: existing.id, path: target };
    let isGitRepo = false;
    try {
      // A `.git` directory or gitdir file marks a repository or worktree root.
      // Checked on disk only: no Git process runs while the user types.
      await deps.stat(path.join(target, ".git"));
      isGitRepo = true;
    } catch {
      isGitRepo = false;
    }
    return { kind: "folder", path: target, isGitRepo };
  };

  const inspect = async (
    input: unknown,
    relativeToWorkspaceId?: string,
  ): Promise<WorkspacePathInspection> => {
    const parsed = parseWorkspacePathInput(input, {
      home: deps.home,
      relativeBase: await relativeBase(relativeToWorkspaceId),
    });
    if (!parsed.ok) return { kind: "invalid", code: parsed.code, reason: parsed.reason };
    return inspectResolved(parsed.path);
  };

  /** Register a folder, returning the existing workspace if another call won the race. */
  const register = async (
    folderPath: string,
  ): Promise<{ ok: true; workspace: Workspace; existing: boolean } | { ok: false; reason: string }> => {
    try {
      return { ok: true, workspace: await deps.createFromFolder(folderPath), existing: false };
    } catch (error) {
      try {
        const existing = await registeredAt(await deps.realpath(folderPath));
        if (existing) return { ok: true, workspace: existing, existing: true };
      } catch {
        // Report the registration failure below.
      }
      return {
        ok: false,
        reason: error instanceof Error && error.message ? error.message : "Aiden couldn't add that folder.",
      };
    }
  };

  const open = async (
    input: unknown,
    options: { create: boolean; relativeToWorkspaceId?: string },
  ): Promise<WorkspaceOpenPathResult<Workspace>> => {
    const inspection = await inspect(input, options.relativeToWorkspaceId);
    switch (inspection.kind) {
      case "invalid":
        return { ok: false, code: inspection.code, reason: inspection.reason };
      case "existing-workspace": {
        const workspace = await deps.getWorkspace(inspection.workspaceId);
        if (workspace) return { ok: true, workspace, created: false, existing: true };
        // Removed meanwhile: register it again below.
        const registered = await register(inspection.path);
        return registered.ok
          ? { ok: true, workspace: registered.workspace, created: false, existing: registered.existing }
          : { ok: false, code: "register-failed", reason: registered.reason };
      }
      case "folder": {
        const registered = await register(inspection.path);
        return registered.ok
          ? { ok: true, workspace: registered.workspace, created: false, existing: registered.existing }
          : { ok: false, code: "register-failed", reason: registered.reason };
      }
      case "creatable": {
        if (!options.create) {
          return { ok: false, code: "missing", reason: "That folder doesn't exist yet." };
        }
        let created = true;
        try {
          await deps.mkdir(inspection.path);
        } catch (error) {
          if (errnoCode(error) !== "EEXIST") {
            const failure = accessFailure(error, "parent");
            return {
              ok: false,
              code: "create-failed",
              reason:
                failure.kind === "invalid" && failure.code === "permission-denied"
                  ? "Aiden doesn't have permission to create a folder there."
                  : "Aiden couldn't create that folder.",
            };
          }
          created = false;
        }
        const registered = await register(inspection.path);
        if (!registered.ok) {
          if (created) await deps.rmdir(inspection.path).catch(() => undefined);
          return { ok: false, code: "register-failed", reason: registered.reason };
        }
        return { ok: true, workspace: registered.workspace, created, existing: registered.existing };
      }
    }
  };

  const previewClone = async (url: unknown): Promise<WorkspaceClonePreview> => {
    const parsed = parseCloneUrl(url);
    if (!parsed.ok) return { ok: false, code: "invalid-url", reason: parsed.reason };
    const base = await defaultCloneBaseDirectory(deps.home, deps.stat);
    return { ok: true, url: parsed.url, repoName: parsed.repoName, destination: path.join(base, parsed.repoName) };
  };

  type CloneFailure = Extract<WorkspaceCloneResult<Workspace>, { ok: false }>;
  const fail = (code: WorkspaceCloneFailureCode, reason: string, extra: Partial<CloneFailure> = {}): CloneFailure => ({
    ok: false,
    code,
    reason,
    ...extra,
  });

  /** One key per folder however it is spelled: canonical parent plus folded name. */
  const destinationKey = async (destination: string): Promise<string> => {
    const name = path.basename(destination);
    const parent = await deps.realpath(path.dirname(destination));
    return path.join(parent, caseInsensitivePaths ? name.toLowerCase() : name);
  };

  /** The destination must be absent or an empty real folder; a link is never followed. */
  const checkDestination = async (
    destination: string,
  ): Promise<{ ok: true; state: "absent" | "empty" } | { ok: false; failure: CloneFailure }> => {
    let stats: LinkStatLike;
    try {
      stats = await deps.lstat(destination);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return { ok: true, state: "absent" };
      return { ok: false, failure: fail("invalid-destination", "Aiden can't read the destination folder.") };
    }
    if (stats.isSymbolicLink()) {
      return { ok: false, failure: fail("invalid-destination", "The destination is a link. Choose a real folder.") };
    }
    const occupied = fail("destination-exists", "The destination folder already exists and isn't empty.");
    if (!stats.isDirectory()) return { ok: false, failure: occupied };
    try {
      if ((await deps.readdir(destination)).length > 0) return { ok: false, failure: occupied };
    } catch {
      return { ok: false, failure: fail("invalid-destination", "Aiden can't read the destination folder.") };
    }
    return { ok: true, state: "empty" };
  };

  /** A private folder beside the destination, marked as this clone's own. */
  const createStaging = async (parent: string): Promise<{ staging: string; token: string }> => {
    const staging = await deps.mkdtemp(path.join(parent, ".aiden-clone-"));
    const token = deps.randomId();
    try {
      await deps.writeNewFile(path.join(staging, CLONE_OWNER_MARKER), token);
    } catch (error) {
      await deps.rmdir(staging).catch(() => undefined);
      throw error;
    }
    return { staging, token };
  };

  /**
   * Delete a staging folder only when it still carries this clone's marker:
   * a real directory holding a regular-file marker with the token. Anything
   * else is left in place and logged. Removal never follows symlinks.
   */
  const removeStaging = async (staging: string, token: string): Promise<void> => {
    const marker = path.join(staging, CLONE_OWNER_MARKER);
    try {
      const folder = await deps.lstat(staging);
      const markerStats = await deps.lstat(marker);
      if (
        folder.isSymbolicLink() ||
        !folder.isDirectory() ||
        markerStats.isSymbolicLink() ||
        !markerStats.isFile() ||
        (await deps.readFile(marker)) !== token
      ) {
        throw new Error("The clone staging folder no longer carries Aiden's owner marker.");
      }
    } catch (error) {
      deps.logError("workspace", "Left a clone staging folder Aiden could not verify as its own.", error);
      return;
    }
    await deps.removeTree(staging).catch((error: unknown) => {
      deps.logError("workspace", "Could not remove a clone staging folder.", error);
    });
  };

  /**
   * Move a finished clone into place. The destination must still be absent or
   * an empty real folder; otherwise nothing of the user's is touched.
   */
  const publishClone = async (staging: string, destination: string): Promise<CloneFailure | undefined> => {
    const appeared = fail(
      "destination-exists",
      "Something appeared in the destination folder during the clone, so the clone was discarded.",
    );
    const check = await checkDestination(destination);
    if (!check.ok) return appeared;
    if (check.state === "empty") {
      try {
        await deps.rmdir(destination);
      } catch {
        return appeared;
      }
    }
    try {
      // rename never replaces a non-empty folder, a file or a link with a directory.
      await deps.rename(path.join(staging, CLONE_STAGING_REPO), destination);
    } catch {
      return appeared;
    }
    return undefined;
  };

  const clone = async (
    input: CloneRequestInput,
    options: { cloneId: string; signal: AbortSignal; onProgress(progress: WorkspaceCloneProgress): void; beforePublish?(stagedRepository: string): Promise<void>; beforeRegister?(): Promise<void> },
  ): Promise<WorkspaceCloneResult<Workspace>> => {
    const parsed = parseCloneUrl(input.url);
    if (!parsed.ok) return fail("invalid-url", parsed.reason);

    let destination: string;
    if (input.destination === undefined || input.destination === null || input.destination === "") {
      destination = path.join(await defaultCloneBaseDirectory(deps.home, deps.stat), parsed.repoName);
    } else {
      const parsedDestination = parseWorkspacePathInput(input.destination, { home: deps.home });
      if (!parsedDestination.ok) return fail("invalid-destination", parsedDestination.reason);
      destination = parsedDestination.path;
    }
    if (destination === path.parse(destination).root) {
      return fail("invalid-destination", "Choose a folder for the repository.");
    }
    // Never clone into or beneath a Git directory: the remote's config would
    // then govern the enclosing repository.
    if (destination.split(path.sep).some((segment) => segment.toLowerCase() === ".git")) {
      return fail("invalid-destination", "Choose a folder that isn't named .git.");
    }

    const inspection = await inspectResolved(destination);
    if (inspection.kind === "invalid") return fail("invalid-destination", inspection.reason);
    const initial = await checkDestination(destination);
    if (!initial.ok) return initial.failure;

    let key: string;
    try {
      key = await destinationKey(destination);
    } catch {
      return fail("invalid-destination", "Aiden can't read the folder that would contain the repository.");
    }
    if (activeDestinations.has(key)) {
      return fail("busy", "A clone into that folder is already running.");
    }
    activeDestinations.add(key);
    try {
      let staging: string;
      let token: string;
      try {
        ({ staging, token } = await createStaging(path.dirname(destination)));
      } catch {
        return fail("invalid-destination", "Aiden couldn't create a folder for the clone there.");
      }
      try {
        if (options.signal.aborted) return fail("cancelled", "Clone cancelled.");
        const outcome = await deps.runClone({
          url: parsed.url,
          destination: path.join(staging, CLONE_STAGING_REPO),
          cwd: staging,
          signal: options.signal,
          onProgress: (progress) => options.onProgress({ cloneId: options.cloneId, ...progress }),
        });
        if (!outcome.ok) {
          if (outcome.reason === "cancelled") return fail("cancelled", "Clone cancelled.");
          if (outcome.reason === "timeout") return fail("timeout", "The clone took too long and was stopped.");
          const detail = cloneFailureDetail(outcome.stderrTail, deps.home);
          if (outcome.reason === "spawn-failed") {
            return fail("git-unavailable", "Aiden couldn't run Git. Install Git and try again.", detail ? { detail } : {});
          }
          const classified = classifyCloneFailure(outcome.stderrTail);
          return fail(classified.code, classified.reason, detail ? { detail } : {});
        }
        await options.beforePublish?.(path.join(staging, CLONE_STAGING_REPO));
        if (options.signal.aborted) return fail("cancelled", "Clone cancelled.");
        const published = await publishClone(staging, destination);
        if (published) return published;
      } finally {
        await removeStaging(staging, token);
      }
      await options.beforeRegister?.();
      const registered = await register(destination);
      if (!registered.ok) {
        return fail(
          "register-failed",
          `The repository was cloned, but Aiden couldn't add it as a workspace: ${registered.reason}`,
          { destination },
        );
      }
      return { ok: true, workspace: registered.workspace, destination };
    } finally {
      activeDestinations.delete(key);
    }
  };

  return { inspect, open, previewClone, clone };
}

export type WorkspaceIntakeService = ReturnType<typeof createWorkspaceIntakeService>;
