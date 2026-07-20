// Structured Git operations for workspace-backed repositories. Commands always
// use argv execution (never a shell), run in an isolated process group with
// bounded output/time, and serialize mutations by Git's canonical common dir.

import { spawn, type ChildProcess } from "child_process";
import { createHash, randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { GitBranches, GitInfo, GitWorktree } from "./types.js";

const DEFAULT_READ_TIMEOUT_MS = 4_000;
const DEFAULT_MUTATION_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 1_000;
const DEFAULT_CACHE_ENTRIES = 64;
const KILL_GRACE_MS = 750;
const GIT_ROUTING_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
] as const;

export type GitErrorCode =
  | "aborted"
  | "command_failed"
  | "dirty_worktree"
  | "invalid_ref"
  | "not_repo"
  | "output_limit"
  | "timeout"
  | "unborn";

export class GitServiceError extends Error {
  constructor(
    readonly code: GitErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GitServiceError";
  }
}

interface GitRepository {
  cwd: string;
  topLevel: string;
  commonDir: string;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface GitRunOptions {
  allowExitCodes?: number[];
  mutation?: boolean;
  signal?: AbortSignal;
}

interface CacheEntry<T> {
  commonDir: string;
  expiresAt: number;
  value: T;
}

export interface GitServiceOptions {
  cacheEntries?: number;
  cacheTtlMs?: number;
  gitBinary?: string;
  maxBufferBytes?: number;
  mutationTimeoutMs?: number;
  readTimeoutMs?: number;
}

interface ParsedStatus {
  branch?: string;
  detached: boolean;
  unborn: boolean;
  uncommitted: number;
  upstream?: string;
  ahead: number;
  behind: number;
}

interface RemoteRefs {
  branches: string[];
  defaultBranch?: string;
}

export interface GitCreatedWorktree extends GitWorktree {
  branch: string;
  /** The path Aiden should authorize; preserves a nested source-workspace scope. */
  workspacePath: string;
  repositoryPath: string;
  createdFromHead: string;
}

export interface GitDeleteWorktreeResult {
  branchDeleted: boolean;
}

type TerminationReason = "aborted" | "output_limit" | "timeout";

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return search ? value.split(search).join(replacement) : value;
}

function redactGitText(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, "$1***@")
    .replace(/([?&](?:access_token|auth|key|password|signature|token)=)[^&\s]+/gi, "$1***");
}

function publicGitMessage(value: unknown, cwd: string): string {
  const raw = replaceAllLiteral(String(value || "Git command failed."), "\u0000", "").trim();
  const withoutWorkspace = replaceAllLiteral(raw, cwd, "the workspace");
  const withoutHome = replaceAllLiteral(withoutWorkspace, os.homedir(), "~");
  return (redactGitText(withoutHome) || "Git command failed.").slice(0, 1_200);
}

function gitEnvironment(mutation: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_ROUTING_ENV) delete env[key];
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: mutation ? "1" : "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
}

/** Parse `git status --porcelain=v2 --branch -z` without line/path splitting. */
export function parseGitStatus(raw: string): ParsedStatus {
  const records = raw.split("\u0000");
  let branch: string | undefined;
  let detached = false;
  let unborn = false;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  let uncommitted = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("# branch.head ")) {
      const head = record.slice("# branch.head ".length);
      detached = head === "(detached)";
      if (!detached && head !== "(unknown)") branch = head;
      continue;
    }
    if (record.startsWith("# branch.oid ") && !branch) {
      const oid = record.slice("# branch.oid ".length);
      unborn = oid === "(initial)";
      if (!unborn) branch = oid.slice(0, 8);
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length) || undefined;
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (record.startsWith("1 ") || record.startsWith("u ") || record.startsWith("? ")) {
      uncommitted += 1;
      continue;
    }
    if (record.startsWith("2 ")) {
      // Rename/copy records carry their original path as the next NUL record.
      uncommitted += 1;
      index += 1;
    }
  }

  return { branch, detached, unborn, uncommitted, upstream, ahead, behind };
}

function parseRefList(raw: string): string[] {
  return raw
    .split("\u0000")
    .map((value) => value.replace(/^\n+|\n+$/g, ""))
    .filter(Boolean);
}

export function parseRemoteRefs(raw: string): RemoteRefs {
  const fields = raw.split("\u0000").map((value) => value.replace(/^\n+|\n+$/g, ""));
  const branches: string[] = [];
  const defaults: Array<{ branch: string; remote: string }> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const ref = fields[index];
    const symbolicTarget = fields[index + 1];
    if (!ref.startsWith("refs/remotes/")) continue;
    const short = ref.slice("refs/remotes/".length);
    if (!symbolicTarget) {
      branches.push(short);
      continue;
    }
    if (!ref.endsWith("/HEAD")) continue;
    const prefix = ref.slice(0, -"/HEAD".length);
    if (!symbolicTarget.startsWith(`${prefix}/`)) continue;
    defaults.push({
      branch: symbolicTarget.slice(prefix.length + 1),
      remote: prefix.slice("refs/remotes/".length),
    });
  }
  const preferred =
    defaults.find((entry) => entry.remote === "origin") ??
    defaults.find((entry) => entry.remote === "upstream") ??
    defaults[0];
  return { branches, defaultBranch: preferred?.branch };
}

export function parseGitWorktrees(raw: string, currentPath: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let next: Partial<GitWorktree> = {};
  const finish = () => {
    if (!next.path || !next.head) return;
    worktrees.push({
      path: next.path,
      head: next.head,
      branch: next.branch,
      bare: next.bare ?? false,
      detached: next.detached ?? false,
      current: path.resolve(next.path) === path.resolve(currentPath),
    });
    next = {};
  };
  for (const record of raw.split("\u0000")) {
    if (!record) {
      finish();
      continue;
    }
    const separator = record.indexOf(" ");
    const key = separator === -1 ? record : record.slice(0, separator);
    const value = separator === -1 ? "" : record.slice(separator + 1);
    if (key === "worktree") next.path = value;
    else if (key === "HEAD") next.head = value;
    else if (key === "branch") next.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "bare") next.bare = true;
    else if (key === "detached") next.detached = true;
  }
  finish();
  return worktrees;
}

function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already have exited.
    }
  }
}

export class GitService {
  private readonly gitBinary: string;
  private readonly maxBufferBytes: number;
  private readonly readTimeoutMs: number;
  private readonly mutationTimeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cacheEntries: number;
  private readonly infoCache = new Map<string, CacheEntry<GitInfo>>();
  private readonly branchCache = new Map<string, CacheEntry<GitBranches>>();
  private readonly mutations = new Map<string, Promise<void>>();
  private readonly mutationEpochs = new Map<string, number>();

  constructor(options: GitServiceOptions = {}) {
    this.gitBinary = options.gitBinary ?? "git";
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.mutationTimeoutMs = options.mutationTimeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.cacheEntries = options.cacheEntries ?? DEFAULT_CACHE_ENTRIES;
  }

  private run(cwd: string, args: string[], options: GitRunOptions = {}): Promise<GitCommandResult> {
    if (options.signal?.aborted) {
      return Promise.reject(new GitServiceError("aborted", "Git operation was cancelled."));
    }
    const timeoutMs = options.mutation ? this.mutationTimeoutMs : this.readTimeoutMs;
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.gitBinary, args, {
          cwd,
          detached: process.platform !== "win32",
          env: gitEnvironment(options.mutation === true),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        reject(new GitServiceError("command_failed", publicGitMessage(error, cwd), error));
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let termination: TerminationReason | undefined;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const terminate = (reason: TerminationReason) => {
        if (termination || settled) return;
        termination = reason;
        terminateProcessGroup(child, "SIGTERM");
        killTimer = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      };
      const append = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
        const nextBytes = (stream === "stdout" ? stdoutBytes : stderrBytes) + chunk.byteLength;
        if (nextBytes > this.maxBufferBytes) {
          terminate("output_limit");
          return;
        }
        target.push(chunk);
        if (stream === "stdout") stdoutBytes = nextBytes;
        else stderrBytes = nextBytes;
      };
      child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk, "stdout"));
      child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk, "stderr"));

      const abort = () => terminate("aborted");
      options.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
      timeout.unref();

      const cleanup = () => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
      };
      const finishError = (error: GitServiceError) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      child.once("error", (error) => {
        finishError(new GitServiceError("command_failed", publicGitMessage(error, cwd), error));
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = Buffer.concat(stderr).toString("utf8");
        if (termination === "aborted") {
          reject(new GitServiceError("aborted", "Git operation was cancelled."));
          return;
        }
        if (termination === "timeout") {
          reject(new GitServiceError("timeout", `Git did not finish within ${Math.ceil(timeoutMs / 1_000)} seconds.`));
          return;
        }
        if (termination === "output_limit") {
          reject(new GitServiceError("output_limit", "Git produced more output than Aiden can safely process."));
          return;
        }
        const exitCode = code ?? 1;
        if (exitCode === 0 || options.allowExitCodes?.includes(exitCode)) {
          resolve({ stdout: stdoutText, stderr: stderrText, exitCode });
          return;
        }
        const detail = stderrText || stdoutText || `Git exited with code ${exitCode}${signal ? ` (${signal})` : ""}.`;
        reject(new GitServiceError("command_failed", publicGitMessage(detail, cwd)));
      });
    });
  }

  private async repository(cwd: string): Promise<GitRepository | null> {
    let canonicalCwd: string;
    try {
      canonicalCwd = await fs.realpath(cwd);
    } catch {
      return null;
    }
    const inside = await this.run(canonicalCwd, ["rev-parse", "--is-inside-work-tree"], { allowExitCodes: [128] });
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return null;
    const [topLevelResult, commonDirResult] = await Promise.all([
      this.run(canonicalCwd, ["rev-parse", "--show-toplevel"]),
      this.run(canonicalCwd, ["rev-parse", "--git-common-dir"]),
    ]);
    const topLevel = await fs.realpath(topLevelResult.stdout.trimEnd());
    const commonPath = commonDirResult.stdout.trimEnd();
    const commonDir = await fs.realpath(path.isAbsolute(commonPath) ? commonPath : path.resolve(canonicalCwd, commonPath));
    return { cwd: canonicalCwd, topLevel, commonDir };
  }

  private requireRepository(repo: GitRepository | null): GitRepository {
    if (!repo) throw new GitServiceError("not_repo", "This workspace is not a Git repository.");
    return repo;
  }

  private getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return undefined;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry.value;
  }

  private setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, commonDir: string, value: T): void {
    cache.set(key, { commonDir, expiresAt: Date.now() + this.cacheTtlMs, value });
    while (cache.size > this.cacheEntries) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) break;
      cache.delete(oldest);
    }
  }

  private invalidate(commonDir: string): void {
    for (const [key, entry] of this.infoCache) if (entry.commonDir === commonDir) this.infoCache.delete(key);
    for (const [key, entry] of this.branchCache) if (entry.commonDir === commonDir) this.branchCache.delete(key);
  }

  private bumpEpoch(commonDir: string): void {
    const next = (this.mutationEpochs.get(commonDir) ?? 0) + 1;
    this.mutationEpochs.delete(commonDir);
    this.mutationEpochs.set(commonDir, next);
    while (this.mutationEpochs.size > this.cacheEntries) {
      const oldest = this.mutationEpochs.keys().next().value as string | undefined;
      if (!oldest || this.mutations.has(oldest)) break;
      this.mutationEpochs.delete(oldest);
    }
  }

  private enqueueMutation<T>(commonDir: string, operation: () => Promise<T>): Promise<T> {
    this.bumpEpoch(commonDir);
    this.invalidate(commonDir);
    const previous = this.mutations.get(commonDir) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.mutations.set(commonDir, tail);
    void tail.finally(() => {
      if (this.mutations.get(commonDir) === tail) this.mutations.delete(commonDir);
      this.bumpEpoch(commonDir);
      this.invalidate(commonDir);
    });
    return result;
  }

  private async stableRead<T>(repo: GitRepository, operation: () => Promise<T>): Promise<T> {
    for (;;) {
      const active = this.mutations.get(repo.commonDir);
      if (active) await active;
      const epoch = this.mutationEpochs.get(repo.commonDir) ?? 0;
      const value = await operation();
      if (epoch === (this.mutationEpochs.get(repo.commonDir) ?? 0) && !this.mutations.has(repo.commonDir)) {
        return value;
      }
      // A read can finish after the mutation's final invalidation and populate
      // the cache with its pre-mutation snapshot. Drop that value before the
      // retry so both the caller and subsequent readers observe the new state.
      this.invalidate(repo.commonDir);
    }
  }

  private async readRemoteRefs(repo: GitRepository): Promise<RemoteRefs> {
    const result = await this.run(repo.cwd, [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname)%00%(symref)%00",
      "refs/remotes",
    ]);
    return parseRemoteRefs(result.stdout);
  }

  private async status(repo: GitRepository): Promise<GitInfo> {
    const [raw, remotesResult, remoteRefs] = await Promise.all([
      this.run(repo.cwd, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"]),
      this.run(repo.cwd, ["remote"]),
      this.readRemoteRefs(repo),
    ]);
    const parsed = parseGitStatus(raw.stdout);
    return {
      isRepo: true,
      branch: parsed.branch,
      detached: parsed.detached,
      unborn: parsed.unborn,
      uncommitted: parsed.uncommitted,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      defaultBranch: remoteRefs.defaultBranch,
      hasRemote: remotesResult.stdout.trim().length > 0,
      remoteState: parsed.upstream ? "local-ref" : undefined,
    };
  }

  async info(cwd: string): Promise<GitInfo> {
    const repo = await this.repository(cwd);
    if (!repo) return { isRepo: false };
    return this.stableRead(repo, async () => {
      const cached = this.getCached(this.infoCache, repo.cwd);
      if (cached) return cached;
      const value = await this.status(repo);
      this.setCached(this.infoCache, repo.cwd, repo.commonDir, value);
      return value;
    });
  }

  async branches(cwd: string): Promise<GitBranches> {
    const repo = await this.repository(cwd);
    if (!repo) return { isRepo: false, branches: [], remoteBranches: [], uncommitted: 0 };
    return this.stableRead(repo, async () => {
      const cached = this.getCached(this.branchCache, repo.cwd);
      if (cached) return cached;
      const [info, localResult, remoteRefs] = await Promise.all([
        this.status(repo),
        this.run(repo.cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%00", "refs/heads"]),
        this.readRemoteRefs(repo),
      ]);
      const local = parseRefList(localResult.stdout);
      if (info.unborn && info.branch && !local.includes(info.branch)) local.unshift(info.branch);
      const value: GitBranches = {
        ...info,
        current: info.branch,
        branches: local,
        remoteBranches: remoteRefs.branches,
        uncommitted: info.uncommitted ?? 0,
      };
      this.setCached(this.branchCache, repo.cwd, repo.commonDir, value);
      return value;
    });
  }

  private async validateBranchName(repo: GitRepository, name: string): Promise<void> {
    const result = await this.run(repo.cwd, ["check-ref-format", "--branch", name], { allowExitCodes: [1, 128] });
    if (result.exitCode !== 0) throw new GitServiceError("invalid_ref", "Enter a valid Git branch name.");
  }

  private async requireHead(repo: GitRepository): Promise<string> {
    const head = await this.run(repo.cwd, ["rev-parse", "--verify", "HEAD"], { allowExitCodes: [128] });
    if (head.exitCode !== 0) {
      throw new GitServiceError("unborn", "Create the repository's first commit before creating another branch or worktree.");
    }
    return head.stdout.trim();
  }

  async checkout(cwd: string, name: string, signal?: AbortSignal): Promise<void> {
    const repo = this.requireRepository(await this.repository(cwd));
    await this.validateBranchName(repo, name);
    await this.enqueueMutation(repo.commonDir, async () => {
      const exists = await this.run(repo.cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], {
        allowExitCodes: [1],
      });
      if (exists.exitCode !== 0) throw new GitServiceError("invalid_ref", `Local branch “${name}” no longer exists.`);
      await this.run(repo.cwd, ["switch", "--no-guess", "--", name], { mutation: true, signal });
    });
  }

  async createBranch(cwd: string, name: string, signal?: AbortSignal): Promise<void> {
    const repo = this.requireRepository(await this.repository(cwd));
    await this.validateBranchName(repo, name);
    await this.enqueueMutation(repo.commonDir, async () => {
      await this.requireHead(repo);
      await this.run(repo.cwd, ["switch", "-c", name, "--"], { mutation: true, signal });
    });
  }

  private async inspectWorktrees(repo: GitRepository, currentPath: string): Promise<GitWorktree[]> {
    const result = await this.run(repo.cwd, ["worktree", "list", "--porcelain", "-z"]);
    return parseGitWorktrees(result.stdout, currentPath);
  }

  async worktrees(cwd: string): Promise<GitWorktree[]> {
    const repo = this.requireRepository(await this.repository(cwd));
    return this.stableRead(repo, () => this.inspectWorktrees(repo, repo.topLevel));
  }

  private async rollbackCreatedWorktree(
    repo: GitRepository,
    worktreePath: string,
    branch: string,
    createdFromHead: string,
    createdByCommand: boolean,
  ): Promise<unknown | undefined> {
    let rollbackError: unknown;
    let ownedRegistration = false;
    try {
      ownedRegistration = createdByCommand || (await this.inspectWorktrees(repo, repo.cwd)).some(
        (worktree) =>
          worktree.branch === branch && path.resolve(worktree.path) === path.resolve(worktreePath),
      );
    } catch (error) {
      rollbackError = error;
    }
    try {
      await this.run(repo.cwd, ["worktree", "remove", "--force", "--", worktreePath], {
        allowExitCodes: [128],
        mutation: true,
      });
      await this.run(repo.cwd, ["worktree", "prune"], { mutation: true });
    } catch (error) {
      rollbackError ??= error;
    }
    try {
      const remaining = await this.inspectWorktrees(repo, repo.cwd);
      const branchInUse = remaining.some((worktree) => worktree.branch === branch);
      const ref = await this.run(repo.cwd, ["show-ref", "--verify", "--hash", `refs/heads/${branch}`], {
        allowExitCodes: [1],
      });
      if (ownedRegistration && !branchInUse && ref.exitCode === 0 && ref.stdout.trim() === createdFromHead) {
        await this.run(repo.cwd, ["branch", "-D", "--", branch], { mutation: true });
      }
    } catch (error) {
      rollbackError ??= error;
    }
    await fs.rm(worktreePath, { force: true, recursive: true }).catch((error) => {
      rollbackError ??= error;
    });
    return rollbackError;
  }

  async createWorktree(cwd: string, root: string, branch: string, signal?: AbortSignal): Promise<GitCreatedWorktree> {
    const repo = this.requireRepository(await this.repository(cwd));
    await this.validateBranchName(repo, branch);
    return this.enqueueMutation(repo.commonDir, async () => {
      const createdFromHead = await this.requireHead(repo);
      const exists = await this.run(repo.cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
        allowExitCodes: [1],
      });
      if (exists.exitCode === 0) throw new GitServiceError("invalid_ref", `Branch “${branch}” already exists.`);

      const repositoryId = createHash("sha256").update(repo.commonDir).digest("hex").slice(0, 12);
      const repositoryName = path.basename(repo.topLevel).replace(/[^a-zA-Z0-9._-]+/g, "-") || "repository";
      const branchSlug = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const managedRoot = await fs.realpath(root);
      const repositoryRoot = path.join(managedRoot, `${repositoryName}-${repositoryId}`);
      await fs.mkdir(repositoryRoot, { recursive: true, mode: 0o700 });
      const worktreePath = path.join(repositoryRoot, `${branchSlug}-${randomUUID().slice(0, 8)}`);
      let createdByCommand = false;
      try {
        await this.run(repo.cwd, ["worktree", "add", "-b", branch, "--", worktreePath, "HEAD"], {
          mutation: true,
          signal,
        });
        createdByCommand = true;
        const created = (await this.inspectWorktrees(repo, worktreePath)).find((worktree) => worktree.branch === branch);
        if (!created) throw new GitServiceError("command_failed", "Git created the worktree but Aiden could not inspect it.");
        const relativeWorkspacePath = path.relative(repo.topLevel, repo.cwd);
        const workspacePath = path.join(created.path, relativeWorkspacePath);
        if (!(await fs.stat(workspacePath)).isDirectory()) {
          throw new GitServiceError(
            "command_failed",
            "The workspace subfolder is not present in HEAD, so Aiden did not widen access to the repository root.",
          );
        }
        return {
          ...created,
          branch,
          workspacePath,
          repositoryPath: repo.topLevel,
          createdFromHead,
        };
      } catch (error) {
        const rollbackError = await this.rollbackCreatedWorktree(
          repo,
          worktreePath,
          branch,
          createdFromHead,
          createdByCommand,
        );
        if (rollbackError) {
          throw new GitServiceError(
            "command_failed",
            "Git worktree creation failed, and Aiden could not fully roll it back. Inspect `git worktree list` before retrying.",
            { operationError: error, rollbackError },
          );
        }
        throw error;
      }
    });
  }

  async rollbackWorktree(cwd: string, created: GitCreatedWorktree): Promise<void> {
    const repo = this.requireRepository(await this.repository(cwd));
    await this.enqueueMutation(repo.commonDir, async () => {
      const rollbackError = await this.rollbackCreatedWorktree(
        repo,
        created.path,
        created.branch,
        created.createdFromHead,
        true,
      );
      if (rollbackError) {
        throw new GitServiceError("command_failed", "Aiden could not fully roll back the managed worktree.", rollbackError);
      }
    });
  }

  async deleteManagedWorktree(
    cwd: string,
    worktreePath: string,
    branch: string,
    createdFromHead: string,
    signal?: AbortSignal,
  ): Promise<GitDeleteWorktreeResult> {
    const repo = this.requireRepository(await this.repository(cwd));
    return this.enqueueMutation(repo.commonDir, async () => {
      const registered = (await this.inspectWorktrees(repo, repo.cwd)).find(
        (worktree) => path.resolve(worktree.path) === path.resolve(worktreePath) && worktree.branch === branch,
      );
      if (!registered) throw new GitServiceError("command_failed", "This managed worktree is no longer registered.");
      const status = parseGitStatus(
        (await this.run(worktreePath, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"]))
          .stdout,
      );
      if (status.uncommitted > 0) {
        throw new GitServiceError("dirty_worktree", "Commit, stash, or discard this worktree's changes before deleting it.");
      }
      await this.run(repo.cwd, ["worktree", "remove", "--", worktreePath], { mutation: true, signal });
      const ref = await this.run(repo.cwd, ["show-ref", "--verify", "--hash", `refs/heads/${branch}`], {
        allowExitCodes: [1],
      });
      const branchDeleted = ref.exitCode === 0 && ref.stdout.trim() === createdFromHead;
      if (branchDeleted) await this.run(repo.cwd, ["branch", "-D", "--", branch], { mutation: true, signal });
      return { branchDeleted };
    });
  }
}

const gitService = new GitService();

export const gitInfo = (folderPath: string) => gitService.info(folderPath);
export const gitBranches = (folderPath: string) => gitService.branches(folderPath);
export const gitCheckout = (folderPath: string, name: string, signal?: AbortSignal) =>
  gitService.checkout(folderPath, name, signal);
export const gitCreateBranch = (folderPath: string, name: string, signal?: AbortSignal) =>
  gitService.createBranch(folderPath, name, signal);
export const gitWorktrees = (folderPath: string) => gitService.worktrees(folderPath);
export const gitCreateWorktree = (folderPath: string, root: string, branch: string, signal?: AbortSignal) =>
  gitService.createWorktree(folderPath, root, branch, signal);
export const gitRollbackWorktree = (folderPath: string, created: GitCreatedWorktree) =>
  gitService.rollbackWorktree(folderPath, created);
export const gitDeleteManagedWorktree = (
  folderPath: string,
  worktreePath: string,
  branch: string,
  createdFromHead: string,
  signal?: AbortSignal,
) => gitService.deleteManagedWorktree(folderPath, worktreePath, branch, createdFromHead, signal);
