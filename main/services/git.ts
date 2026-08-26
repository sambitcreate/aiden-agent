// Structured Git operations for workspace-backed repositories. Commands always
// use argv execution (never a shell), run in an isolated process group with
// bounded output/time, and serialize mutations by Git's canonical common dir.

import { spawn, type ChildProcess } from "child_process";
import { createHash, randomUUID } from "crypto";
import { constants as fsConstants } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { GitBranches, GitInfo, GitWorktree } from "./types.js";
import {
  finalizeManagedWorktreeRemovalManifest,
  managedWorktreeRemovalManifestPresent,
  ManagedWorktreeRemoverError,
  removeManagedWorktreeDirectory,
  type ManagedWorktreeDirectoryIdentity,
} from "./managed-worktree-remover.js";
import { recordDiagnosticCounter } from "./performance-diagnostics.js";
import { trackDiagnosticChild } from "./performance-child.js";

const DEFAULT_READ_TIMEOUT_MS = 4_000;
const DEFAULT_MUTATION_TIMEOUT_MS = 20_000;
const DEFAULT_PUSH_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 1_000;
const DEFAULT_CACHE_ENTRIES = 64;
const SNAPSHOT_CACHE_ENTRIES = 4_096;
const KILL_GRACE_MS = 750;
const WORKTREE_OWNER_MARKER = "aiden-owner";
const WORKTREE_OWNER_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
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
  | "conflicted"
  | "dirty_worktree"
  | "invalid_input"
  | "invalid_ref"
  | "not_repo"
  | "output_limit"
  | "stale_snapshot"
  | "timeout"
  | "unsupported_scope"
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

export class GitManagedWorktreeDeleteError extends GitServiceError {
  constructor(
    error: GitServiceError,
    readonly destructiveMutationAttempted: boolean,
  ) {
    super(error.code, error.message, error);
    this.name = "GitManagedWorktreeDeleteError";
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
  truncated?: boolean;
}

interface GitRunOptions {
  allowExitCodes?: number[];
  allowTruncatedOutput?: boolean;
  gitIndexFile?: string;
  frozenRemoteAlias?: string;
  frozenRemote?: GitPushTransport;
  prePushProxy?: GitPrePushProxy;
  mutation?: boolean;
  nonInteractiveCommit?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface GitPushTransport {
  endpoint: string;
  proxy?: string;
  proxyAuthMethod?: string;
  receivePack?: string;
}

interface GitPrePushProxy {
  completedPath: string;
  frozenEndpoint: string;
  hooksPath: string;
  originalHookPath?: string;
  remote: string;
  tempDir: string;
}

interface GitTrackingRefSnapshot {
  ref: string;
  expectedOld: string;
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
  pushTimeoutMs?: number;
  readTimeoutMs?: number;
  snapshotMaxBytes?: number;
  worktreeDirectoryRemover?: (identity: ManagedWorktreeDirectoryIdentity) => Promise<void>;
  worktreeRemovalManifestFinalizer?: (targetPath: string, expectedDigest: string) => Promise<void>;
  worktreeRemovalManifestInspector?: (targetPath: string) => Promise<boolean>;
}

interface ParsedStatus {
  branch?: string;
  detached: boolean;
  unborn: boolean;
  uncommitted: number;
  ignored: number;
  upstream?: string;
  ahead: number;
  behind: number;
}

interface RemoteRefs {
  branches: string[];
  defaultBranch?: string;
}

interface ReviewSnapshot {
  complete: boolean;
  value?: string;
}

interface SnapshotFileCacheEntry {
  digest: string;
  signature: string;
}

interface GitIndexTransaction {
  indexPath: string;
  lockHandle: fs.FileHandle | null;
  lockPath: string;
  messagePath: string;
  tempDir: string;
  tempIndexPath: string;
}

interface GitHeadGuard {
  headHandle: fs.FileHandle;
  headLockPath: string;
  refHandle: fs.FileHandle;
  refLockPath: string;
}

interface GitWorktreeAdminIdentity {
  device: number;
  gitdirContents: string;
  inode: number;
}

interface GitWorktreeRemovalJournal {
  version: 3;
  phase:
    | "prepared"
    | "quarantined"
    | "checkout_cleanup_started"
    | "checkout_complete"
    | "admin_cleanup_started"
    | "needs_review"
    | "filesystem_complete";
  adminDevice: number;
  adminGitdirContents: string;
  adminInode: number;
  adminManifestDigest: string | null;
  branch: string;
  checkoutDevice: number;
  checkoutInode: number;
  checkoutManifestDigest: string | null;
  checkoutPath: string;
  checkoutAuthorization: string;
  checkoutQuarantine: string;
  createdFromHead: string;
  gitDir: string;
  gitDirAuthorization: string;
  gitDirQuarantine: string;
  ownershipToken: string;
  repositoryPath: string;
}

export interface GitCreatedWorktree extends GitWorktree {
  branch: string;
  /** The path Aiden should authorize; preserves a nested source-workspace scope. */
  workspacePath: string;
  repositoryPath: string;
  worktreeGitDir: string;
  ownershipToken: string;
  worktreeDevice: number;
  worktreeInode: number;
  createdFromHead: string;
}

type GitWorktreeRollbackIdentity = Pick<
  GitCreatedWorktree,
  "worktreeGitDir" | "ownershipToken" | "worktreeDevice" | "worktreeInode"
>;

export interface GitDeleteWorktreeResult {
  branchDeleted: boolean;
}

export type GitReviewFileStatus =
  | "added"
  | "conflicted"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "untracked";

export interface GitReviewFile {
  path: string;
  previousPath?: string;
  status: GitReviewFileStatus;
  staged: boolean;
  unstaged: boolean;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface GitReviewSummary {
  fileCount: number;
  additions: number;
  deletions: number;
  unavailableStats: number;
  stagedFiles: number;
  unstagedFiles: number;
  conflictedFiles: number;
}

export interface GitCommitCapability {
  allowed: boolean;
  reason?: string;
  snapshot?: string;
  snapshotComplete: boolean;
  repositoryRoot: boolean;
}

export interface GitReview {
  isRepo: boolean;
  branch?: string;
  files: GitReviewFile[];
  summary: GitReviewSummary;
  commit: GitCommitCapability;
}

export interface GitDiffInput {
  expectedSnapshot: string;
  path: string;
}

export type GitCommitMode = "staged" | "all";

export interface GitCommitInput {
  expectedSnapshot: string;
  message: string;
  mode: GitCommitMode;
}

export interface GitCommitResult {
  commit: string;
  branch: string;
  remainingChanges?: number;
  subject: string;
  warning?: string;
}

export interface GitPushCapability {
  allowed: boolean;
  reason?: string;
  branch?: string;
  expectedHead?: string;
  remotes: string[];
  remoteIdentities: Record<string, string>;
  suggestedRemote?: string;
  destinationBranch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  repositoryRoot: boolean;
  remoteState: "local-ref";
}

export interface GitPushInput {
  destinationBranch: string;
  expectedBranch: string;
  expectedHead: string;
  expectedRemoteIdentity: string;
  remote: string;
  setUpstream: boolean;
}

export interface GitPushResult {
  branch: string;
  commit: string;
  destinationBranch: string;
  remote: string;
  upstreamSet: boolean;
  warning?: string;
}

export interface GitComparison {
  currentBranch?: string;
  expectedHead: string;
  expectedTarget: string;
  targetRef: string;
  targetLabel: string;
  mergeBase: string;
  ahead: number;
  behind: number;
  files: GitReviewFile[];
  summary: GitReviewSummary;
  snapshot: string;
  remoteState: "local-ref";
}

export interface GitComparisonDiffInput {
  expectedHead: string;
  expectedTarget: string;
  mergeBase: string;
  path: string;
  targetRef: string;
}

type CommitRefReconciliation = "absent" | "advanced" | "exact" | "unknown";

type IndexFinalization = "branch_moved" | "failed" | "finalized" | "head_locked" | "head_moved";

export interface GitFileDiff {
  path: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
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
  delete env.GIT_CONFIG_COUNT;
  delete env.GIT_CONFIG_PARAMETERS;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: mutation ? "1" : "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
}

function gitCommandConfigEnvironment(options: GitRunOptions): NodeJS.ProcessEnv {
  const entries: Array<[string, string]> = [];
  if (options.frozenRemoteAlias && options.frozenRemote) {
    const placeholder = `aiden-frozen://${options.frozenRemoteAlias}`;
    entries.push(
      [`remote.${options.frozenRemoteAlias}.url`, placeholder],
      [`remote.${options.frozenRemoteAlias}.pushurl`, placeholder],
      [`url.${options.frozenRemote.endpoint}.insteadOf`, placeholder],
      [`url.${options.frozenRemote.endpoint}.pushInsteadOf`, placeholder],
    );
    if (options.frozenRemote.receivePack !== undefined) {
      entries.push([
        `remote.${options.frozenRemoteAlias}.receivepack`,
        options.frozenRemote.receivePack,
      ]);
    }
    if (options.frozenRemote.proxy !== undefined) {
      entries.push([`remote.${options.frozenRemoteAlias}.proxy`, options.frozenRemote.proxy]);
    }
    if (options.frozenRemote.proxyAuthMethod !== undefined) {
      entries.push([
        `remote.${options.frozenRemoteAlias}.proxyAuthMethod`,
        options.frozenRemote.proxyAuthMethod,
      ]);
    }
  }
  if (options.prePushProxy) entries.push(["core.hooksPath", options.prePushProxy.hooksPath]);
  if (entries.length === 0) return {};
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
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
  let ignored = 0;

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
    if (record.startsWith("! ")) {
      ignored += 1;
      continue;
    }
    if (record.startsWith("2 ")) {
      // Rename/copy records carry their original path as the next NUL record.
      uncommitted += 1;
      index += 1;
    }
  }

  return { branch, detached, unborn, uncommitted, ignored, upstream, ahead, behind };
}

function parseRefList(raw: string): string[] {
  return raw
    .split("\u0000")
    .map((value) => value.replace(/^\n+|\n+$/g, ""))
    .filter(Boolean);
}

function valueAfterFields(record: string, fieldCount: number): string {
  let cursor = 0;
  for (let field = 0; field < fieldCount; field += 1) {
    cursor = record.indexOf(" ", cursor);
    if (cursor === -1) return "";
    cursor += 1;
  }
  return record.slice(cursor);
}

function reviewStatus(xy: string, recordType: string): GitReviewFileStatus {
  if (recordType === "u" || xy.includes("U")) return "conflicted";
  if (xy.includes("R")) return "renamed";
  if (xy.includes("C")) return "copied";
  if (xy.includes("A")) return "added";
  if (xy.includes("D")) return "deleted";
  return "modified";
}

/** Parse workspace-relative `git status --porcelain=v2 -z` entries for Review. */
export function parseGitReviewStatus(raw: string): GitReviewFile[] {
  const records = raw.split("\u0000");
  const files: GitReviewFile[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.startsWith("# ") || record.startsWith("! ")) continue;
    if (record.startsWith("? ")) {
      files.push({
        path: record.slice(2),
        status: "untracked",
        staged: false,
        unstaged: true,
      });
      continue;
    }

    const recordType = record[0];
    if (recordType !== "1" && recordType !== "2" && recordType !== "u") continue;
    const xy = record.slice(2, 4);
    const pathFieldCount = recordType === "1" ? 8 : recordType === "2" ? 9 : 10;
    const filePath = valueAfterFields(record, pathFieldCount);
    if (!filePath) continue;
    const previousPath = recordType === "2" ? records[index + 1] || undefined : undefined;
    if (recordType === "2") index += 1;
    files.push({
      path: filePath,
      ...(previousPath ? { previousPath } : {}),
      status: reviewStatus(xy, recordType),
      staged: xy[0] !== ".",
      unstaged: xy[1] !== ".",
    });
  }
  return files.sort((left, right) =>
    left.path.localeCompare(right.path, undefined, { numeric: true }),
  );
}

interface GitNumstat {
  path: string;
  additions?: number;
  deletions?: number;
  binary: boolean;
}

/** Parse `git diff --numstat -z`, including its three-record rename form. */
export function parseGitNumstat(raw: string): GitNumstat[] {
  const records = raw.split("\u0000");
  const stats: GitNumstat[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    let filePath = record.slice(secondTab + 1);
    if (!filePath) {
      index += 1;
      const previousPath = records[index];
      index += 1;
      filePath = records[index] || previousPath;
    }
    if (!filePath) continue;
    const binary = added === "-" || deleted === "-";
    stats.push({
      path: filePath,
      additions: binary ? undefined : Number(added),
      deletions: binary ? undefined : Number(deleted),
      binary,
    });
  }
  return stats;
}

/** Parse NUL-delimited `git diff --name-status -z --find-renames`. */
export function parseGitNameStatus(raw: string): GitReviewFile[] {
  const records = raw.split("\u0000");
  const files: GitReviewFile[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const statusCode = records[index];
    if (!statusCode) continue;
    const kind = statusCode[0];
    const firstPath = records[index + 1];
    if (!firstPath) break;
    index += 1;
    let filePath = firstPath;
    let previousPath: string | undefined;
    if (kind === "R" || kind === "C") {
      previousPath = firstPath;
      filePath = records[index + 1] || firstPath;
      index += 1;
    }
    const status: GitReviewFileStatus =
      kind === "A"
        ? "added"
        : kind === "D"
          ? "deleted"
          : kind === "R"
            ? "renamed"
            : kind === "C"
              ? "copied"
              : kind === "U"
                ? "conflicted"
                : "modified";
    files.push({
      path: filePath,
      ...(previousPath ? { previousPath } : {}),
      status,
      staged: false,
      unstaged: false,
    });
  }
  return files.sort((left, right) =>
    left.path.localeCompare(right.path, undefined, { numeric: true }),
  );
}

function lexicalWorkspacePath(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\u0000") || path.isAbsolute(relativePath)) {
    throw new GitServiceError("command_failed", "Choose a changed file inside the workspace.");
  }
  const fullPath = path.resolve(root, relativePath);
  const relative = path.relative(root, fullPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new GitServiceError("command_failed", "Choose a changed file inside the workspace.");
  }
  return fullPath;
}

function countTextLines(value: string): number {
  if (!value) return 0;
  const lines = value.split("\n");
  return lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
}

function gitDiffHeaderPath(prefix: "a" | "b", value: string): string {
  const fullPath = `${prefix}/${value}`;
  const needsQuotes = [...fullPath].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      /\s/u.test(character) || character === '"' || character === "\\" || code < 32 || code === 127
    );
  });
  if (!needsQuotes) return fullPath;
  let escaped = "";
  for (const character of fullPath) {
    if (character === "\\") escaped += "\\\\";
    else if (character === '"') escaped += '\\"';
    else if (character === "\n") escaped += "\\n";
    else if (character === "\r") escaped += "\\r";
    else if (character === "\t") escaped += "\\t";
    else {
      const code = character.codePointAt(0) ?? 0;
      escaped += code < 32 || code === 127 ? `\\${code.toString(8).padStart(3, "0")}` : character;
    }
  }
  return `"${escaped}"`;
}

function workspaceRelativeStatusPath(repo: GitRepository, gitPath: string): string {
  const prefix = path.relative(repo.topLevel, repo.cwd).split(path.sep).join("/");
  if (!prefix) return gitPath;
  return gitPath.startsWith(`${prefix}/`) ? gitPath.slice(prefix.length + 1) : gitPath;
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
  private readonly snapshotMaxBytes: number;
  private readonly readTimeoutMs: number;
  private readonly mutationTimeoutMs: number;
  private readonly pushTimeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cacheEntries: number;
  private readonly worktreeDirectoryRemover: (
    identity: ManagedWorktreeDirectoryIdentity,
  ) => Promise<void>;
  private readonly worktreeRemovalManifestFinalizer: (
    targetPath: string,
    expectedDigest: string,
  ) => Promise<void>;
  private readonly worktreeRemovalManifestInspector: (targetPath: string) => Promise<boolean>;
  private readonly infoCache = new Map<string, CacheEntry<GitInfo>>();
  private readonly branchCache = new Map<string, CacheEntry<GitBranches>>();
  private readonly mutations = new Map<string, Promise<void>>();
  private readonly mutationEpochs = new Map<string, number>();
  private readonly snapshotFileCache = new Map<string, SnapshotFileCacheEntry>();

  constructor(options: GitServiceOptions = {}) {
    this.gitBinary = options.gitBinary ?? "git";
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.snapshotMaxBytes = options.snapshotMaxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES;
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.mutationTimeoutMs = options.mutationTimeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS;
    this.pushTimeoutMs = options.pushTimeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.cacheEntries = options.cacheEntries ?? DEFAULT_CACHE_ENTRIES;
    this.worktreeDirectoryRemover =
      options.worktreeDirectoryRemover ?? removeManagedWorktreeDirectory;
    this.worktreeRemovalManifestFinalizer =
      options.worktreeRemovalManifestFinalizer ?? finalizeManagedWorktreeRemovalManifest;
    this.worktreeRemovalManifestInspector =
      options.worktreeRemovalManifestInspector ?? managedWorktreeRemovalManifestPresent;
  }

  private run(cwd: string, args: string[], options: GitRunOptions = {}): Promise<GitCommandResult> {
    if (options.signal?.aborted) {
      return Promise.reject(new GitServiceError("aborted", "Git operation was cancelled."));
    }
    const timeoutMs =
      options.timeoutMs ?? (options.mutation ? this.mutationTimeoutMs : this.readTimeoutMs);
    const diagnosticStarted = performance.now();
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        const commandConfigEnvironment = gitCommandConfigEnvironment(options);
        child = spawn(this.gitBinary, args, {
          cwd,
          detached: process.platform !== "win32",
          env: {
            ...gitEnvironment(options.mutation === true),
            ...commandConfigEnvironment,
            ...(options.prePushProxy
              ? {
                  AIDEN_GIT_CONFIG_COUNT: commandConfigEnvironment.GIT_CONFIG_COUNT ?? "0",
                  AIDEN_PRE_PUSH_COMPLETED_PATH: options.prePushProxy.completedPath,
                  AIDEN_PRE_PUSH_FROZEN_URL: options.prePushProxy.frozenEndpoint,
                  AIDEN_PRE_PUSH_HOOK_PATH: options.prePushProxy.originalHookPath ?? "",
                  AIDEN_PRE_PUSH_REMOTE: options.prePushProxy.remote,
                }
              : {}),
            ...(options.gitIndexFile ? { GIT_INDEX_FILE: options.gitIndexFile } : {}),
            ...(options.nonInteractiveCommit ? { GIT_EDITOR: ":" } : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        trackDiagnosticChild("git", child);
      } catch (error) {
        recordDiagnosticCounter("child-result:git", {
          errors: 1,
          durationMs: performance.now() - diagnosticStarted,
        });
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
        const currentBytes = stream === "stdout" ? stdoutBytes : stderrBytes;
        const nextBytes = currentBytes + chunk.byteLength;
        if (nextBytes > this.maxBufferBytes) {
          const remaining = Math.max(0, this.maxBufferBytes - currentBytes);
          if (remaining > 0) target.push(chunk.subarray(0, remaining));
          if (stream === "stdout") stdoutBytes += remaining;
          else stderrBytes += remaining;
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
        recordDiagnosticCounter("child-result:git", {
          errors: 1,
          durationMs: performance.now() - diagnosticStarted,
          bytesOut: stdoutBytes + stderrBytes,
        });
        finishError(new GitServiceError("command_failed", publicGitMessage(error, cwd), error));
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = Buffer.concat(stderr).toString("utf8");
        recordDiagnosticCounter("child-result:git", {
          errors: termination || (code ?? 1) !== 0 ? 1 : 0,
          durationMs: performance.now() - diagnosticStarted,
          bytesOut: stdoutBytes + stderrBytes,
        });
        if (termination === "aborted") {
          reject(new GitServiceError("aborted", "Git operation was cancelled."));
          return;
        }
        if (termination === "timeout") {
          reject(
            new GitServiceError(
              "timeout",
              `Git did not finish within ${Math.ceil(timeoutMs / 1_000)} seconds.`,
            ),
          );
          return;
        }
        if (termination === "output_limit") {
          if (options.allowTruncatedOutput) {
            resolve({
              stdout: stdoutText,
              stderr: stderrText,
              exitCode: 0,
              truncated: true,
            });
            return;
          }
          reject(
            new GitServiceError(
              "output_limit",
              "Git produced more output than Aiden can safely process.",
            ),
          );
          return;
        }
        const exitCode = code ?? 1;
        if (exitCode === 0 || options.allowExitCodes?.includes(exitCode)) {
          resolve({ stdout: stdoutText, stderr: stderrText, exitCode });
          return;
        }
        const detail =
          stderrText ||
          stdoutText ||
          `Git exited with code ${exitCode}${signal ? ` (${signal})` : ""}.`;
        reject(new GitServiceError("command_failed", publicGitMessage(detail, cwd)));
      });
    });
  }

  private async repository(cwd: string, signal?: AbortSignal): Promise<GitRepository | null> {
    if (signal?.aborted) {
      throw new GitServiceError("aborted", "Git operation was cancelled.");
    }
    let canonicalCwd: string;
    try {
      canonicalCwd = await fs.realpath(cwd);
    } catch {
      return null;
    }
    const inside = await this.run(canonicalCwd, ["rev-parse", "--is-inside-work-tree"], {
      allowExitCodes: [128],
      signal,
    });
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return null;
    const [topLevelResult, commonDirResult] = await Promise.all([
      this.run(canonicalCwd, ["rev-parse", "--show-toplevel"], { signal }),
      this.run(canonicalCwd, ["rev-parse", "--git-common-dir"], { signal }),
    ]);
    if (signal?.aborted) {
      throw new GitServiceError("aborted", "Git operation was cancelled.");
    }
    const topLevel = await fs.realpath(topLevelResult.stdout.trimEnd());
    const commonPath = commonDirResult.stdout.trimEnd();
    const commonDir = await fs.realpath(
      path.isAbsolute(commonPath) ? commonPath : path.resolve(canonicalCwd, commonPath),
    );
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

  private setCached<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    commonDir: string,
    value: T,
  ): void {
    cache.set(key, {
      commonDir,
      expiresAt: Date.now() + this.cacheTtlMs,
      value,
    });
    while (cache.size > this.cacheEntries) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) break;
      cache.delete(oldest);
    }
  }

  private invalidate(commonDir: string): void {
    for (const [key, entry] of this.infoCache)
      if (entry.commonDir === commonDir) this.infoCache.delete(key);
    for (const [key, entry] of this.branchCache)
      if (entry.commonDir === commonDir) this.branchCache.delete(key);
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

  private async stableRead<T>(
    repo: GitRepository,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    for (;;) {
      if (signal?.aborted) {
        throw new GitServiceError("aborted", "Git operation was cancelled.");
      }
      const active = this.mutations.get(repo.commonDir);
      if (active) await active;
      const epoch = this.mutationEpochs.get(repo.commonDir) ?? 0;
      const value = await operation();
      if (signal?.aborted) {
        throw new GitServiceError("aborted", "Git operation was cancelled.");
      }
      if (
        epoch === (this.mutationEpochs.get(repo.commonDir) ?? 0) &&
        !this.mutations.has(repo.commonDir)
      ) {
        return value;
      }
      // A read can finish after the mutation's final invalidation and populate
      // the cache with its pre-mutation snapshot. Drop that value before the
      // retry so both the caller and subsequent readers observe the new state.
      this.invalidate(repo.commonDir);
    }
  }

  private async readRemoteRefs(repo: GitRepository, signal?: AbortSignal): Promise<RemoteRefs> {
    const result = await this.run(
      repo.cwd,
      [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname)%00%(symref)%00",
        "refs/remotes",
      ],
      { signal },
    );
    return parseRemoteRefs(result.stdout);
  }

  private async status(repo: GitRepository, signal?: AbortSignal): Promise<GitInfo> {
    const [raw, remotesResult, remoteRefs] = await Promise.all([
      this.run(
        repo.cwd,
        ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"],
        { signal },
      ),
      this.run(repo.cwd, ["remote"], { signal }),
      this.readRemoteRefs(repo, signal),
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

  async info(cwd: string, signal?: AbortSignal): Promise<GitInfo> {
    const repo = await this.repository(cwd, signal);
    if (!repo) return { isRepo: false };
    return this.stableRead(
      repo,
      async () => {
        const cached = this.getCached(this.infoCache, repo.cwd);
        if (cached) return cached;
        const value = await this.status(repo, signal);
        this.setCached(this.infoCache, repo.cwd, repo.commonDir, value);
        return value;
      },
      signal,
    );
  }

  async branches(cwd: string, signal?: AbortSignal): Promise<GitBranches> {
    const repo = await this.repository(cwd, signal);
    if (!repo)
      return {
        isRepo: false,
        branches: [],
        remoteBranches: [],
        uncommitted: 0,
      };
    return this.stableRead(
      repo,
      async () => {
        const cached = this.getCached(this.branchCache, repo.cwd);
        if (cached) return cached;
        const [info, localResult, remoteRefs] = await Promise.all([
          this.status(repo, signal),
          this.run(
            repo.cwd,
            ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%00", "refs/heads"],
            { signal },
          ),
          this.readRemoteRefs(repo, signal),
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
      },
      signal,
    );
  }

  private async reviewSnapshot(
    repo: GitRepository,
    rawStatus: string,
    files: GitReviewFile[],
    coreFileMode: boolean,
    signal?: AbortSignal,
  ): Promise<ReviewSnapshot> {
    const hash = createHash("sha256");
    hash.update("aiden-git-review-v1\u0000");
    hash.update(rawStatus);
    hash.update(`\u0000core.fileMode:${coreFileMode}\u0000`);
    let totalBytes = Buffer.byteLength(rawStatus);
    for (const file of files) {
      if (signal?.aborted) throw new GitServiceError("aborted", "Git operation was cancelled.");
      hash.update("\u0000path\u0000");
      hash.update(file.path);
      const lexicalPath = lexicalWorkspacePath(repo.cwd, file.path);
      try {
        const stats = await fs.lstat(lexicalPath);
        hash.update(`\u0000mode:${stats.mode.toString(8)}\u0000`);
        if (stats.isSymbolicLink()) {
          const target = await fs.readlink(lexicalPath);
          totalBytes += Buffer.byteLength(target);
          if (totalBytes > this.snapshotMaxBytes) return { complete: false };
          hash.update("symlink\u0000");
          hash.update(target);
          continue;
        }
        if (!stats.isFile()) return { complete: false };
        if (totalBytes + stats.size > this.snapshotMaxBytes) return { complete: false };
        totalBytes += stats.size;
        const cacheKey = `${repo.cwd}\u0000${file.path}`;
        const signature = [
          stats.dev,
          stats.ino,
          stats.mode,
          stats.size,
          stats.mtimeMs,
          stats.ctimeMs,
        ].join(":");
        let digest =
          this.snapshotFileCache.get(cacheKey)?.signature === signature
            ? this.snapshotFileCache.get(cacheKey)?.digest
            : undefined;
        if (!digest) {
          const contents = await fs.readFile(lexicalPath);
          if (
            contents.byteLength !== stats.size ||
            totalBytes - stats.size + contents.byteLength > this.snapshotMaxBytes
          ) {
            return { complete: false };
          }
          digest = createHash("sha256").update(contents).digest("hex");
          this.snapshotFileCache.delete(cacheKey);
          this.snapshotFileCache.set(cacheKey, { digest, signature });
          while (this.snapshotFileCache.size > SNAPSHOT_CACHE_ENTRIES) {
            const oldest = this.snapshotFileCache.keys().next().value as string | undefined;
            if (!oldest) break;
            this.snapshotFileCache.delete(oldest);
          }
        }
        hash.update("file\u0000");
        hash.update(digest);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { complete: false };
        hash.update("missing\u0000");
      }
    }
    return { complete: true, value: hash.digest("hex") };
  }

  private async coreFileMode(repo: GitRepository, signal?: AbortSignal): Promise<boolean> {
    const result = await this.run(repo.cwd, ["config", "--bool", "--get", "core.fileMode"], {
      allowExitCodes: [1],
      signal,
    });
    return result.exitCode !== 0 || result.stdout.trim() !== "false";
  }

  private async inspectReview(repo: GitRepository, signal?: AbortSignal): Promise<GitReview> {
    const [statusResult, coreFileMode] = await Promise.all([
      this.run(
        repo.cwd,
        [
          "-c",
          "status.relativePaths=true",
          "status",
          "--porcelain=v2",
          "--branch",
          "-z",
          "--untracked-files=all",
          "--",
          ".",
        ],
        { signal },
      ),
      this.coreFileMode(repo, signal),
    ]);
    const parsedStatus = parseGitStatus(statusResult.stdout);
    const files = parseGitReviewStatus(statusResult.stdout).map((file) => ({
      ...file,
      path: workspaceRelativeStatusPath(repo, file.path),
      ...(file.previousPath
        ? { previousPath: workspaceRelativeStatusPath(repo, file.previousPath) }
        : {}),
    }));
    const [head, snapshot] = await Promise.all([
      this.run(repo.cwd, ["rev-parse", "--verify", "HEAD"], {
        allowExitCodes: [128],
        signal,
      }),
      this.reviewSnapshot(repo, statusResult.stdout, files, coreFileMode, signal),
    ]);
    const hasHead = head.exitCode === 0;
    const numstat = hasHead
      ? await this.run(
          repo.cwd,
          [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--numstat",
            "-z",
            "--relative",
            "HEAD",
            "--",
            ".",
          ],
          { signal },
        )
      : null;
    const stats = new Map(
      parseGitNumstat(numstat?.stdout ?? "").map((entry) => [entry.path, entry] as const),
    );

    await Promise.all(
      files.map(async (file) => {
        const stat = stats.get(file.path);
        if (stat) {
          file.additions = stat.additions;
          file.deletions = stat.deletions;
          file.binary = stat.binary;
          return;
        }
        // With no HEAD, every current file is effectively added relative to
        // the empty tree. Inspect the working copy so an AM file reports its
        // final contents instead of only the older staged blob.
        if (hasHead && file.status !== "untracked") return;
        try {
          const lexicalPath = lexicalWorkspacePath(repo.cwd, file.path);
          const lexicalStats = await fs.lstat(lexicalPath);
          if (lexicalStats.isSymbolicLink()) {
            const target = await fs.readlink(lexicalPath);
            file.additions = countTextLines(target);
            file.deletions = 0;
            file.binary = false;
            return;
          }
          const canonicalPath = await fs.realpath(lexicalPath);
          const relative = path.relative(repo.cwd, canonicalPath);
          if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          )
            return;
          const fileStats = await fs.stat(canonicalPath);
          if (!fileStats.isFile() || fileStats.size > this.maxBufferBytes) return;
          const buffer = await fs.readFile(canonicalPath);
          if (buffer.subarray(0, 8_192).includes(0)) {
            file.binary = true;
            return;
          }
          file.additions = countTextLines(buffer.toString("utf8"));
          file.deletions = 0;
        } catch {
          // The file may have changed between status and inspection. Refresh will reconcile it.
        }
      }),
    );
    const summary: GitReviewSummary = {
      fileCount: files.length,
      additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
      deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
      unavailableStats: files.filter(
        (file) => file.additions === undefined || file.deletions === undefined,
      ).length,
      stagedFiles: files.filter((file) => file.staged).length,
      unstagedFiles: files.filter((file) => file.unstaged).length,
      conflictedFiles: files.filter((file) => file.status === "conflicted").length,
    };
    const repositoryRoot = path.resolve(repo.cwd) === path.resolve(repo.topLevel);
    let reason: string | undefined;
    if (!repositoryRoot) {
      reason = "Commit from Aiden is available only when the workspace is the repository root.";
    } else if (parsedStatus.detached) {
      reason = "Switch to a local branch before committing from Aiden.";
    } else if (summary.conflictedFiles > 0) {
      reason = "Resolve conflicted files before committing.";
    } else if (summary.fileCount === 0) {
      reason = "The working tree is clean.";
    } else if (!snapshot.complete || !snapshot.value) {
      reason =
        "These changes are too large or contain an unsupported path for a safe Aiden commit.";
    } else if (!parsedStatus.branch) {
      reason = "Aiden could not determine the current branch.";
    } else {
      reason = await this.commitStateBlocker(repo, signal);
      if (!reason) {
        const identity = await this.run(repo.cwd, ["var", "GIT_AUTHOR_IDENT"], {
          allowExitCodes: [1, 128],
          signal,
        });
        if (identity.exitCode !== 0) {
          reason = "Configure Git user.name and user.email before committing.";
        }
      }
    }
    return {
      isRepo: true,
      branch: parsedStatus.branch,
      files,
      summary,
      commit: {
        allowed: !reason,
        reason,
        snapshot: snapshot.value,
        snapshotComplete: snapshot.complete,
        repositoryRoot,
      },
    };
  }

  async review(cwd: string, signal?: AbortSignal): Promise<GitReview> {
    const repo = await this.repository(cwd);
    if (!repo) {
      return {
        isRepo: false,
        files: [],
        summary: {
          fileCount: 0,
          additions: 0,
          deletions: 0,
          unavailableStats: 0,
          stagedFiles: 0,
          unstagedFiles: 0,
          conflictedFiles: 0,
        },
        commit: {
          allowed: false,
          reason: "This workspace is not a Git repository.",
          snapshotComplete: false,
          repositoryRoot: false,
        },
      };
    }
    return this.stableRead(repo, () => this.inspectReview(repo, signal));
  }

  private async currentFilePatch(
    repo: GitRepository,
    relativePath: string,
    signal?: AbortSignal,
  ): Promise<GitFileDiff> {
    const lexicalPath = lexicalWorkspacePath(repo.cwd, relativePath);
    const lexicalStats = await fs.lstat(lexicalPath);
    const symbolic = lexicalStats.isSymbolicLink();
    const executable = !symbolic && (lexicalStats.mode & 0o111) !== 0;
    const coreFileMode = await this.coreFileMode(repo, signal);
    const gitMode = symbolic ? "120000" : executable && coreFileMode ? "100755" : "100644";
    let buffer: Buffer;
    if (symbolic) {
      buffer = Buffer.from(await fs.readlink(lexicalPath), "utf8");
    } else {
      const canonicalPath = await fs.realpath(lexicalPath);
      const relative = path.relative(repo.cwd, canonicalPath);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new GitServiceError(
          "command_failed",
          "The changed file resolves outside the workspace.",
        );
      }
      const stats = await fs.stat(canonicalPath);
      if (!stats.isFile())
        throw new GitServiceError("command_failed", "The changed path is not a file.");
      buffer = await fs.readFile(canonicalPath);
    }
    if (signal?.aborted) throw new GitServiceError("aborted", "Git operation was cancelled.");
    const limited = buffer.subarray(0, this.maxBufferBytes);
    const fromPath = gitDiffHeaderPath("a", relativePath);
    const toPath = gitDiffHeaderPath("b", relativePath);
    const binary = !symbolic && limited.subarray(0, 8_192).includes(0);
    if (binary) {
      return {
        path: relativePath,
        patch: `diff --git ${fromPath} ${toPath}\nnew file mode ${gitMode}\nBinary file ${toPath} is not shown.\n`,
        binary: true,
        truncated: buffer.byteLength > limited.byteLength,
      };
    }
    const text = limited.toString("utf8");
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const patch = [
      `diff --git ${fromPath} ${toPath}`,
      `new file mode ${gitMode}`,
      "--- /dev/null",
      `+++ ${toPath}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
      buffer.byteLength === limited.byteLength && text.length > 0 && !text.endsWith("\n")
        ? "\\ No newline at end of file"
        : undefined,
      buffer.byteLength > limited.byteLength ? "+… [diff truncated by Aiden]" : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    return {
      path: relativePath,
      patch: `${patch}\n`,
      binary: false,
      truncated: buffer.byteLength > limited.byteLength,
    };
  }

  async diff(cwd: string, input: GitDiffInput, signal?: AbortSignal): Promise<GitFileDiff> {
    const repo = this.requireRepository(await this.repository(cwd));
    const relativePath = input.path;
    lexicalWorkspacePath(repo.cwd, relativePath);
    const review = await this.inspectReview(repo, signal);
    if (!review.commit.snapshot || review.commit.snapshot !== input.expectedSnapshot) {
      throw new GitServiceError(
        "stale_snapshot",
        "The working tree changed after this review. Refresh changes before opening the diff.",
      );
    }
    const file = review.files.find((candidate) => candidate.path === relativePath);
    if (!file)
      throw new GitServiceError("stale_snapshot", "That file is no longer part of this review.");
    const head = await this.run(repo.cwd, ["rev-parse", "--verify", "HEAD"], {
      allowExitCodes: [128],
      signal,
    });
    let diff: GitFileDiff;
    if (file.status === "untracked" || head.exitCode !== 0) {
      diff = await this.currentFilePatch(repo, relativePath, signal);
    } else {
      const pathspecs = file.previousPath ? [file.previousPath, file.path] : [file.path];
      pathspecs.forEach((pathspec) => lexicalWorkspacePath(repo.cwd, pathspec));
      const result = await this.run(
        repo.cwd,
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--find-renames",
          "--unified=3",
          "--relative",
          "HEAD",
          "--",
          ...pathspecs,
        ],
        { signal, allowTruncatedOutput: true },
      );
      const binary = /^(?:Binary files .* differ|GIT binary patch)$/mu.test(result.stdout);
      diff = {
        path: relativePath,
        patch: result.stdout,
        binary,
        truncated: result.truncated === true,
      };
    }
    const verifiedReview = await this.inspectReview(repo, signal);
    if (verifiedReview.commit.snapshot !== input.expectedSnapshot) {
      throw new GitServiceError(
        "stale_snapshot",
        "The working tree changed while Aiden prepared this diff. Refresh changes and try again.",
      );
    }
    return diff;
  }

  private async repositoryGitPath(
    repo: GitRepository,
    name: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.run(repo.cwd, ["rev-parse", "--git-path", name], {
      signal,
    });
    const value = result.stdout.trimEnd();
    if (!value) throw new GitServiceError("command_failed", `Git did not return its ${name} path.`);
    return path.isAbsolute(value) ? value : path.resolve(repo.cwd, value);
  }

  private async commitStateBlocker(
    repo: GitRepository,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const inProgress = [
      ["MERGE_HEAD", "Finish or abort the merge before committing from Aiden."],
      ["CHERRY_PICK_HEAD", "Finish or abort the cherry-pick before committing from Aiden."],
      ["REVERT_HEAD", "Finish or abort the revert before committing from Aiden."],
      ["rebase-merge", "Finish or abort the rebase before committing from Aiden."],
      ["rebase-apply", "Finish or abort the rebase before committing from Aiden."],
    ] as const;
    for (const [gitPath, reason] of inProgress) {
      const resolvedPath = await this.repositoryGitPath(repo, gitPath, signal);
      try {
        await fs.access(resolvedPath);
        return reason;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          return "Aiden could not verify whether another Git operation is in progress.";
        }
      }
    }
    const sharedIndex = await this.run(repo.cwd, ["rev-parse", "--shared-index-path"], {
      allowExitCodes: [128],
      signal,
    });
    if (sharedIndex.exitCode === 0 && sharedIndex.stdout.trim()) {
      return "Disable Git split-index mode before committing from Aiden.";
    }
    return undefined;
  }

  private async beginIndexTransaction(repo: GitRepository): Promise<GitIndexTransaction> {
    const indexPath = await this.repositoryGitPath(repo, "index");
    const lockPath = `${indexPath}.lock`;
    let lockHandle: fs.FileHandle | null = null;
    let tempDir: string | null = null;
    try {
      lockHandle = await fs.open(lockPath, "wx", 0o666);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new GitServiceError(
          "command_failed",
          "Git's index is busy. Wait for the other Git operation to finish, then refresh Review.",
          error,
        );
      }
      throw new GitServiceError(
        "command_failed",
        "Aiden could not lock Git's index safely.",
        error,
      );
    }
    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-git-index-"));
      const tempIndexPath = path.join(tempDir, "index");
      const messagePath = path.join(tempDir, "COMMIT_EDITMSG");
      try {
        await fs.copyFile(indexPath, tempIndexPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.run(repo.cwd, ["read-tree", "--empty"], {
          gitIndexFile: tempIndexPath,
          mutation: true,
        });
      }
      return {
        indexPath,
        lockHandle,
        lockPath,
        messagePath,
        tempDir,
        tempIndexPath,
      };
    } catch (error) {
      try {
        await lockHandle.close();
      } catch {
        // The lock may already be closed after an I/O failure.
      }
      await fs.unlink(lockPath).catch(() => undefined);
      if (tempDir) await fs.rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
      if (error instanceof GitServiceError) throw error;
      throw new GitServiceError(
        "command_failed",
        "Aiden could not create an isolated Git index.",
        error,
      );
    }
  }

  private async finalizeIndexTransaction(transaction: GitIndexTransaction): Promise<void> {
    const handle = transaction.lockHandle;
    if (!handle) return;
    const contents = await fs.readFile(transaction.tempIndexPath);
    await handle.truncate(0);
    if (contents.byteLength > 0) await handle.write(contents, 0, contents.byteLength, 0);
    await handle.sync();
    await handle.close();
    transaction.lockHandle = null;
    await fs.rename(transaction.lockPath, transaction.indexPath);
  }

  private async releaseIndexTransaction(transaction: GitIndexTransaction): Promise<void> {
    if (transaction.lockHandle) {
      await transaction.lockHandle.close().catch(() => undefined);
      transaction.lockHandle = null;
    }
    await fs.unlink(transaction.lockPath).catch(() => undefined);
    await fs.rm(transaction.tempDir, { force: true, recursive: true }).catch(() => undefined);
  }

  private async beginHeadGuard(repo: GitRepository, branchRef: string): Promise<GitHeadGuard> {
    const [headPath, refPath] = await Promise.all([
      this.repositoryGitPath(repo, "HEAD"),
      this.repositoryGitPath(repo, branchRef),
    ]);
    const headLockPath = `${headPath}.lock`;
    const refLockPath = `${refPath}.lock`;
    const headHandle = await fs.open(headLockPath, "wx", 0o600);
    try {
      const refHandle = await fs.open(refLockPath, "wx", 0o600);
      return { headHandle, headLockPath, refHandle, refLockPath };
    } catch (error) {
      await headHandle.close().catch(() => undefined);
      await fs.unlink(headLockPath).catch(() => undefined);
      throw error;
    }
  }

  private async releaseHeadGuard(guard: GitHeadGuard): Promise<void> {
    await guard.refHandle.close().catch(() => undefined);
    await guard.headHandle.close().catch(() => undefined);
    await fs.unlink(guard.refLockPath).catch(() => undefined);
    await fs.unlink(guard.headLockPath).catch(() => undefined);
  }

  private async finalizeIndexForHead(
    repo: GitRepository,
    branchRef: string,
    candidateCommit: string,
    transaction: GitIndexTransaction,
  ): Promise<IndexFinalization> {
    let guard: GitHeadGuard;
    try {
      guard = await this.beginHeadGuard(repo, branchRef);
    } catch {
      return "head_locked";
    }

    try {
      const before = await this.uncancelledSymbolicHead(repo);
      if (before !== branchRef) return "branch_moved";
      const refBefore = await this.reconcileCommitRef(repo, branchRef, candidateCommit);
      if (refBefore !== "exact") return "branch_moved";
      try {
        await this.finalizeIndexTransaction(transaction);
      } catch {
        if (transaction.lockHandle) {
          await transaction.lockHandle.close().catch(() => undefined);
          transaction.lockHandle = null;
        }
        await fs.unlink(transaction.lockPath).catch(() => undefined);
        return "failed";
      }
      const after = await this.uncancelledSymbolicHead(repo);
      if (after !== branchRef) return "head_moved";
      const refAfter = await this.reconcileCommitRef(repo, branchRef, candidateCommit);
      return refAfter === "exact" ? "finalized" : "head_moved";
    } finally {
      await this.releaseHeadGuard(guard);
    }
  }

  private runHook(
    repo: GitRepository,
    name: string,
    args: string[],
    gitIndexFile?: string,
    signal?: AbortSignal,
  ): Promise<GitCommandResult> {
    return this.run(
      repo.cwd,
      ["hook", "run", "--ignore-missing", name, ...(args.length ? ["--", ...args] : [])],
      {
        gitIndexFile,
        mutation: true,
        nonInteractiveCommit: true,
        signal,
      },
    );
  }

  private async reconcileCommitRef(
    repo: GitRepository,
    branchRef: string,
    candidateCommit: string,
  ): Promise<CommitRefReconciliation> {
    try {
      const result = await this.run(repo.cwd, ["show-ref", "--verify", "--hash", branchRef], {
        allowExitCodes: [1],
        timeoutMs: this.readTimeoutMs,
      });
      if (result.exitCode !== 0) return "absent";
      const current = result.stdout.trim();
      if (current === candidateCommit) return "exact";
      const ancestor = await this.run(
        repo.cwd,
        ["merge-base", "--is-ancestor", candidateCommit, current],
        {
          allowExitCodes: [1],
          timeoutMs: this.readTimeoutMs,
        },
      );
      if (ancestor.exitCode === 0) return "advanced";
      const reflog = await this.run(repo.cwd, ["reflog", "show", "--format=%H", branchRef], {
        allowExitCodes: [1],
        timeoutMs: this.readTimeoutMs,
      });
      return reflog.stdout.split(/\r?\n/).includes(candidateCommit) ? "advanced" : "absent";
    } catch {
      return "unknown";
    }
  }

  private async uncancelledSymbolicHead(repo: GitRepository): Promise<string | undefined> {
    try {
      const result = await this.run(repo.cwd, ["symbolic-ref", "--quiet", "HEAD"], {
        allowExitCodes: [1],
        timeoutMs: this.readTimeoutMs,
      });
      return result.exitCode === 0 ? result.stdout.trim() : undefined;
    } catch (error) {
      if (error instanceof GitServiceError && error.code === "aborted") throw error;
      return undefined;
    }
  }

  async commit(cwd: string, input: GitCommitInput, signal?: AbortSignal): Promise<GitCommitResult> {
    const message = input.message.trim();
    if (!message || message.includes("\u0000") || message.length > 10_000) {
      throw new GitServiceError(
        "invalid_input",
        "Enter a commit message between 1 and 10,000 characters.",
      );
    }
    if (input.mode !== "staged" && input.mode !== "all") {
      throw new GitServiceError("invalid_input", "Choose which changes to include in the commit.");
    }
    if (!/^[0-9a-f]{64}$/.test(input.expectedSnapshot)) {
      throw new GitServiceError("invalid_input", "Refresh Review before committing these changes.");
    }
    const repo = this.requireRepository(await this.repository(cwd));
    return this.enqueueMutation(repo.commonDir, async () => {
      const transaction = await this.beginIndexTransaction(repo);
      let candidateCommit: string | undefined;
      let branchRef: string | undefined;
      let refUpdateAttempted = false;
      let branch = "current branch";
      let subject = message.split(/\r?\n/, 1)[0];
      try {
        const review = await this.inspectReview(repo, signal);
        branch = review.branch ?? branch;
        if (review.commit.snapshot !== input.expectedSnapshot) {
          throw new GitServiceError(
            "stale_snapshot",
            "The working tree changed after this review. Refresh the changes before committing.",
          );
        }
        if (!review.commit.allowed) {
          const code = !review.commit.repositoryRoot
            ? "unsupported_scope"
            : review.summary.conflictedFiles > 0
              ? "conflicted"
              : "command_failed";
          throw new GitServiceError(
            code,
            review.commit.reason ?? "These changes cannot be committed from Aiden.",
          );
        }
        if (input.mode === "staged" && review.summary.stagedFiles === 0) {
          throw new GitServiceError("invalid_input", "There are no staged changes to commit.");
        }

        const [head, symbolicHead] = await Promise.all([
          this.run(repo.cwd, ["rev-parse", "--verify", "HEAD"], {
            allowExitCodes: [128],
            signal,
          }),
          this.run(repo.cwd, ["symbolic-ref", "--quiet", "HEAD"], {
            allowExitCodes: [1],
            signal,
          }),
        ]);
        if (symbolicHead.exitCode !== 0 || !symbolicHead.stdout.trim().startsWith("refs/heads/")) {
          throw new GitServiceError(
            "command_failed",
            "Switch to a local branch before committing from Aiden.",
          );
        }
        const expectedHead = head.exitCode === 0 ? head.stdout.trim() : undefined;
        branchRef = symbolicHead.stdout.trim();
        branch = branchRef.slice("refs/heads/".length);

        if (input.mode === "all") {
          await this.run(repo.cwd, ["add", "-A", "--", "."], {
            gitIndexFile: transaction.tempIndexPath,
            mutation: true,
            signal,
          });
        }
        const intendedTree = (
          await this.run(repo.cwd, ["write-tree"], {
            gitIndexFile: transaction.tempIndexPath,
            mutation: true,
            signal,
          })
        ).stdout.trim();
        const verifiedReview = await this.inspectReview(repo, signal);
        if (verifiedReview.commit.snapshot !== input.expectedSnapshot) {
          throw new GitServiceError(
            "stale_snapshot",
            "The working tree changed while Aiden prepared the commit. Refresh Review before retrying.",
          );
        }

        await fs.writeFile(transaction.messagePath, `${message}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await this.runHook(repo, "pre-commit", [], transaction.tempIndexPath, signal);
        await this.runHook(
          repo,
          "prepare-commit-msg",
          [transaction.messagePath, "message"],
          transaction.tempIndexPath,
          signal,
        );
        let finalMessage = (await fs.readFile(transaction.messagePath, "utf8")).trim();
        if (!finalMessage || finalMessage.includes("\u0000") || finalMessage.length > 10_000) {
          throw new GitServiceError(
            "invalid_input",
            "The prepared commit message must be between 1 and 10,000 characters.",
          );
        }
        await fs.writeFile(transaction.messagePath, `${finalMessage}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await this.runHook(
          repo,
          "commit-msg",
          [transaction.messagePath],
          transaction.tempIndexPath,
          signal,
        );
        finalMessage = (await fs.readFile(transaction.messagePath, "utf8")).trim();
        if (!finalMessage || finalMessage.includes("\u0000") || finalMessage.length > 10_000) {
          throw new GitServiceError(
            "invalid_input",
            "The commit-message hook produced an invalid commit message.",
          );
        }
        await fs.writeFile(transaction.messagePath, `${finalMessage}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        subject = finalMessage.split(/\r?\n/, 1)[0];

        const hookTree = (
          await this.run(repo.cwd, ["write-tree"], {
            gitIndexFile: transaction.tempIndexPath,
            mutation: true,
            signal,
          })
        ).stdout.trim();
        if (hookTree !== intendedTree) {
          throw new GitServiceError(
            "stale_snapshot",
            "A Git hook changed the selected index. Review the hook's changes before committing.",
          );
        }

        const signing = await this.run(repo.cwd, ["config", "--bool", "--get", "commit.gpgSign"], {
          allowExitCodes: [1],
          signal,
        });
        const commitArgs = ["commit-tree", intendedTree];
        if (expectedHead) commitArgs.push("-p", expectedHead);
        if (signing.exitCode === 0 && signing.stdout.trim() === "true") commitArgs.push("-S");
        commitArgs.push("-F", transaction.messagePath);
        candidateCommit = (
          await this.run(repo.cwd, commitArgs, {
            mutation: true,
            signal,
          })
        ).stdout.trim();

        const currentSymbolicHead = await this.run(repo.cwd, ["symbolic-ref", "--quiet", "HEAD"], {
          allowExitCodes: [1],
          signal,
        });
        if (currentSymbolicHead.exitCode !== 0 || currentSymbolicHead.stdout.trim() !== branchRef) {
          throw new GitServiceError(
            "stale_snapshot",
            "The current branch changed while Aiden prepared the commit. Refresh Review before retrying.",
          );
        }

        const warnings: string[] = [];
        let reconciliation: CommitRefReconciliation | undefined;
        let refUpdateConfirmed = false;
        try {
          refUpdateAttempted = true;
          await this.run(
            repo.cwd,
            [
              "update-ref",
              "-m",
              `commit: ${subject.slice(0, 240)}`,
              branchRef,
              candidateCommit,
              expectedHead ?? "",
            ],
            { mutation: true, signal },
          );
          refUpdateConfirmed = true;
        } catch (error) {
          reconciliation = await this.reconcileCommitRef(repo, branchRef, candidateCommit);
          if (reconciliation === "absent") throw error;
          if (reconciliation === "unknown") {
            throw new GitServiceError(
              "command_failed",
              "Git stopped responding while Aiden updated the branch, and the commit outcome could not be verified.",
              error,
            );
          }
          warnings.push(
            "The commit completed, but Git stopped responding before Aiden received confirmation.",
          );
        }
        reconciliation ??= await this.reconcileCommitRef(repo, branchRef, candidateCommit);
        let finalization: IndexFinalization | undefined;
        if (reconciliation === "exact") {
          finalization = await this.finalizeIndexForHead(
            repo,
            branchRef,
            candidateCommit,
            transaction,
          );
        }
        if (
          reconciliation === "absent" ||
          reconciliation === "advanced" ||
          finalization === "branch_moved"
        ) {
          warnings.push(
            "The commit was created, but the checked-out branch moved again. Aiden left the real index unchanged; refresh Review before continuing.",
          );
        } else if (reconciliation === "unknown") {
          warnings.push(
            refUpdateConfirmed
              ? "Git confirmed the commit, but Aiden could not verify the branch afterward. Aiden left the real index unchanged; refresh Review before continuing."
              : "The commit outcome could not be verified. Aiden left the real index unchanged; refresh Review before continuing.",
          );
        } else if (finalization === "head_locked") {
          warnings.push(
            "The commit was created, but another Git process locked HEAD. Aiden left the real index unchanged; refresh Review before continuing.",
          );
        } else if (finalization === "failed") {
          warnings.push(
            "The commit was created, but Aiden could not refresh Git's index. Refresh Review and restage if needed.",
          );
        } else if (finalization === "head_moved") {
          warnings.push(
            "The commit was created, but HEAD changed while Aiden finalized Git's index. Refresh Review and restage before continuing.",
          );
        }

        const indexFinalized = finalization === "finalized";
        if (indexFinalized) {
          try {
            await this.runHook(repo, "post-commit", []);
          } catch (error) {
            const detail = error instanceof Error ? error.message : "The post-commit hook failed.";
            warnings.push(
              `The commit was created, but its post-commit hook did not finish cleanly: ${detail}`,
            );
          }
        } else {
          warnings.push(
            "Aiden did not run the post-commit hook because the branch and index could not be finalized together.",
          );
        }

        let remainingChanges: number | undefined;
        try {
          remainingChanges = (await this.status(repo)).uncommitted ?? 0;
        } catch {
          warnings.push(
            "Aiden could not refresh the remaining-change count. Refresh Review to reconcile it.",
          );
        }
        return {
          commit: candidateCommit,
          branch,
          subject,
          ...(remainingChanges !== undefined ? { remainingChanges } : {}),
          ...(warnings.length ? { warning: warnings.join(" ") } : {}),
        };
      } catch (error) {
        const reconciled =
          candidateCommit && branchRef && refUpdateAttempted
            ? await this.reconcileCommitRef(repo, branchRef, candidateCommit)
            : "absent";
        if (candidateCommit && branchRef && (reconciled === "exact" || reconciled === "advanced")) {
          let warning =
            "The commit was created, but Aiden could not finish reconciling its result. Refresh Review before continuing.";
          const finalization =
            reconciled === "exact"
              ? await this.finalizeIndexForHead(repo, branchRef, candidateCommit, transaction)
              : "branch_moved";
          if (finalization === "failed" || finalization === "head_moved") {
            warning += " Git's index may need to be restaged.";
          } else if (finalization !== "finalized") {
            warning +=
              " Aiden left the real index unchanged because HEAD could not be locked to the committed branch.";
          }
          if (finalization === "finalized") {
            try {
              await this.runHook(repo, "post-commit", []);
            } catch (hookError) {
              const hookDetail =
                hookError instanceof Error ? hookError.message : "The post-commit hook failed.";
              warning += ` The post-commit hook did not finish cleanly: ${hookDetail}`;
            }
          } else {
            warning += " Aiden did not run the post-commit hook.";
          }
          return {
            commit: candidateCommit,
            branch,
            subject,
            warning,
          };
        }
        const detail =
          error instanceof GitServiceError
            ? error
            : new GitServiceError("command_failed", "Aiden could not create the commit.", error);
        if (reconciled === "unknown") {
          throw new GitServiceError(
            detail.code,
            `${detail.message} Aiden could not determine whether the branch was updated. The real Git index was left unchanged; refresh Review and inspect the branch before retrying.`,
            detail,
          );
        }
        throw new GitServiceError(
          detail.code,
          `${detail.message} No commit was created, and Aiden left the real Git index unchanged. Refresh Review before retrying because a hook or external editor may have changed files.`,
          detail,
        );
      } finally {
        await this.releaseIndexTransaction(transaction);
      }
    });
  }

  private async pushStateBlocker(
    repo: GitRepository,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const inProgress = [
      ["MERGE_HEAD", "Finish or abort the merge before pushing from Aiden."],
      ["CHERRY_PICK_HEAD", "Finish or abort the cherry-pick before pushing from Aiden."],
      ["REVERT_HEAD", "Finish or abort the revert before pushing from Aiden."],
      ["rebase-merge", "Finish or abort the rebase before pushing from Aiden."],
      ["rebase-apply", "Finish or abort the rebase before pushing from Aiden."],
    ] as const;
    for (const [gitPath, reason] of inProgress) {
      const resolvedPath = await this.repositoryGitPath(repo, gitPath, signal);
      try {
        await fs.access(resolvedPath);
        return reason;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          return "Aiden could not verify whether another Git operation is in progress.";
        }
      }
    }
    return undefined;
  }

  private async cohesivePushHead(
    repo: GitRepository,
    signal?: AbortSignal,
  ): Promise<{
    branch?: string;
    branchRef?: string;
    expectedHead?: string;
    status: GitInfo;
  }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const symbolicBefore = await this.run(repo.cwd, ["symbolic-ref", "--quiet", "HEAD"], {
        allowExitCodes: [1],
        signal,
      });
      const headBefore = await this.run(repo.cwd, ["rev-parse", "--verify", "HEAD"], {
        allowExitCodes: [128],
        signal,
      });
      const branchRef = symbolicBefore.exitCode === 0 ? symbolicBefore.stdout.trim() : undefined;
      const branch = branchRef?.startsWith("refs/heads/")
        ? branchRef.slice("refs/heads/".length)
        : undefined;
      const [status, branchHead] = await Promise.all([
        this.status(repo, signal),
        branchRef
          ? this.run(repo.cwd, ["rev-parse", "--verify", branchRef], {
              allowExitCodes: [128],
              signal,
            })
          : Promise.resolve(null),
      ]);
      const [symbolicAfter, headAfter] = await Promise.all([
        this.run(repo.cwd, ["symbolic-ref", "--quiet", "HEAD"], {
          allowExitCodes: [1],
          signal,
        }),
        this.run(repo.cwd, ["rev-parse", "--verify", "HEAD"], {
          allowExitCodes: [128],
          signal,
        }),
      ]);
      const symbolicStable =
        symbolicBefore.exitCode === symbolicAfter.exitCode &&
        symbolicBefore.stdout.trim() === symbolicAfter.stdout.trim();
      const headStable =
        headBefore.exitCode === headAfter.exitCode &&
        headBefore.stdout.trim() === headAfter.stdout.trim();
      const expectedHead = headBefore.exitCode === 0 ? headBefore.stdout.trim() : undefined;
      const branchMatchesHead = branchRef
        ? branchHead?.exitCode === headBefore.exitCode &&
          branchHead?.stdout.trim() === headBefore.stdout.trim() &&
          status.branch === branch &&
          !status.detached
        : status.detached && !status.unborn;
      const unbornBranch =
        branchRef &&
        headBefore.exitCode !== 0 &&
        branchHead?.exitCode !== 0 &&
        status.unborn &&
        status.branch === branch;
      if (symbolicStable && headStable && (branchMatchesHead || unbornBranch)) {
        return { branch, branchRef, expectedHead, status };
      }
    }
    throw new GitServiceError(
      "stale_snapshot",
      "The current branch changed while Aiden inspected push state. Refresh before pushing.",
    );
  }

  private async pushEndpoint(
    repo: GitRepository,
    remote: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const result = await this.run(repo.cwd, ["remote", "get-url", "--push", "--all", remote], {
        signal,
      });
      const endpoints = result.stdout
        .split("\n")
        .map((value) => (value.endsWith("\r") ? value.slice(0, -1) : value))
        .filter((value) => value.length > 0);
      return endpoints.length === 1 && !endpoints[0].includes("\u0000") ? endpoints[0] : undefined;
    } catch (error) {
      if (error instanceof GitServiceError && error.code === "aborted") throw error;
      return undefined;
    }
  }

  private async remoteConfigValue(
    repo: GitRepository,
    remote: string,
    key: "proxy" | "proxyAuthMethod" | "receivepack",
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const result = await this.run(repo.cwd, ["config", "--get", `remote.${remote}.${key}`], {
      allowExitCodes: [1],
      signal,
    });
    if (result.exitCode !== 0) return undefined;
    const value = result.stdout.replace(/\r?\n$/, "");
    return value.includes("\u0000") ? undefined : value;
  }

  private async pushTransport(
    repo: GitRepository,
    remote: string,
    signal?: AbortSignal,
  ): Promise<GitPushTransport | undefined> {
    const endpoint = await this.pushEndpoint(repo, remote, signal);
    if (!endpoint) return undefined;
    const [proxy, proxyAuthMethod, receivePack] = await Promise.all([
      this.remoteConfigValue(repo, remote, "proxy", signal),
      this.remoteConfigValue(repo, remote, "proxyAuthMethod", signal),
      this.remoteConfigValue(repo, remote, "receivepack", signal),
    ]);
    return {
      endpoint,
      ...(proxy !== undefined ? { proxy } : {}),
      ...(proxyAuthMethod !== undefined ? { proxyAuthMethod } : {}),
      ...(receivePack !== undefined ? { receivePack } : {}),
    };
  }

  private pushTransportIdentity(transport: GitPushTransport): string {
    return createHash("sha256")
      .update("aiden-reviewed-push-transport-v2\u0000")
      .update(
        JSON.stringify([
          transport.endpoint,
          transport.proxy ?? null,
          transport.proxyAuthMethod ?? null,
          transport.receivePack ?? null,
        ]),
      )
      .digest("hex");
  }

  private async inspectPushCapability(
    repo: GitRepository,
    signal?: AbortSignal,
  ): Promise<GitPushCapability> {
    const [{ branch, branchRef, expectedHead, status }, remotesResult, pushDefault] =
      await Promise.all([
        this.cohesivePushHead(repo, signal),
        this.run(repo.cwd, ["remote"], { signal }),
        this.run(repo.cwd, ["config", "--get", "remote.pushDefault"], {
          allowExitCodes: [1],
          signal,
        }),
      ]);
    const upstream = branchRef
      ? await this.run(
          repo.cwd,
          ["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)%00", branchRef],
          { signal },
        )
      : null;
    const [upstreamRemote, upstreamRef] = upstream?.stdout.split("\u0000") ?? [];
    const configuredRemotes = remotesResult.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    const transportEntries = await Promise.all(
      configuredRemotes.map(
        async (remote) => [remote, await this.pushTransport(repo, remote, signal)] as const,
      ),
    );
    const remoteIdentities = Object.fromEntries(
      transportEntries
        .filter((entry): entry is readonly [string, GitPushTransport] => Boolean(entry[1]))
        .map(([remote, transport]) => [remote, this.pushTransportIdentity(transport)]),
    );
    const remotes = configuredRemotes.filter((remote) => remote in remoteIdentities);
    const configuredPushDefault =
      pushDefault.exitCode === 0 ? pushDefault.stdout.trim() : undefined;
    const suggestedRemote = [
      upstreamRemote,
      configuredPushDefault,
      "origin",
      remotes.length === 1 ? remotes[0] : undefined,
      remotes[0],
    ].find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.length > 0 && remotes.includes(candidate),
    );
    const destinationBranch = upstreamRef?.startsWith("refs/heads/")
      ? upstreamRef.slice("refs/heads/".length)
      : branch;
    const repositoryRoot = path.resolve(repo.cwd) === path.resolve(repo.topLevel);
    let reason: string | undefined;
    if (!repositoryRoot)
      reason = "Push from Aiden is available only when the workspace is the repository root.";
    else if (!expectedHead || status.unborn)
      reason = "Create the repository's first commit before pushing.";
    else if (!branch || status.detached)
      reason = "Switch to a local branch before pushing from Aiden.";
    else if (configuredRemotes.length === 0) reason = "Add a Git remote before pushing from Aiden.";
    else if (remotes.length === 0)
      reason = "Configure exactly one push URL for a remote before pushing from Aiden.";
    else reason = await this.pushStateBlocker(repo, signal);
    return {
      allowed: !reason,
      reason,
      branch,
      expectedHead,
      remotes,
      remoteIdentities,
      suggestedRemote,
      destinationBranch,
      upstream: status.upstream,
      ahead: status.ahead ?? 0,
      behind: status.behind ?? 0,
      repositoryRoot,
      remoteState: "local-ref",
    };
  }

  async pushCapability(cwd: string, signal?: AbortSignal): Promise<GitPushCapability> {
    const repo = await this.repository(cwd);
    if (!repo) {
      return {
        allowed: false,
        reason: "This workspace is not a Git repository.",
        remotes: [],
        remoteIdentities: {},
        ahead: 0,
        behind: 0,
        repositoryRoot: false,
        remoteState: "local-ref",
      };
    }
    return this.stableRead(repo, () => this.inspectPushCapability(repo, signal));
  }

  private async snapshotPushedTrackingRef(
    repo: GitRepository,
    remote: string,
    destinationBranch: string,
    expectedHead: string,
    signal?: AbortSignal,
  ): Promise<GitTrackingRefSnapshot | null> {
    const trackingRef = `refs/remotes/${remote}/${destinationBranch}`;
    const valid = await this.run(repo.cwd, ["check-ref-format", trackingRef], {
      allowExitCodes: [1],
      signal,
    });
    if (valid.exitCode !== 0) return null;
    const current = await this.run(repo.cwd, ["rev-parse", "--verify", trackingRef], {
      allowExitCodes: [128],
      signal,
    });
    return {
      ref: trackingRef,
      expectedOld: current.exitCode === 0 ? current.stdout.trim() : "0".repeat(expectedHead.length),
    };
  }

  private async recordPushedTrackingRef(
    repo: GitRepository,
    snapshot: GitTrackingRefSnapshot,
    expectedHead: string,
  ): Promise<boolean> {
    try {
      await this.run(
        repo.cwd,
        [
          "update-ref",
          "-m",
          "aiden: record reviewed push",
          snapshot.ref,
          expectedHead,
          snapshot.expectedOld,
        ],
        { mutation: true },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async reconcileRemoteRef(
    repo: GitRepository,
    frozenRemoteAlias: string,
    frozenRemote: GitPushTransport,
    destinationRef: string,
    expectedHead: string,
  ): Promise<"different" | "exact" | "unknown"> {
    try {
      const remoteHead = await this.frozenRemoteRefHead(
        repo,
        frozenRemoteAlias,
        frozenRemote,
        destinationRef,
      );
      if (!remoteHead) return "different";
      return remoteHead === expectedHead ? "exact" : "different";
    } catch {
      return "unknown";
    }
  }

  private async frozenRemoteRefHead(
    repo: GitRepository,
    frozenRemoteAlias: string,
    frozenRemote: GitPushTransport,
    destinationRef: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const result = await this.run(
      repo.cwd,
      ["ls-remote", "--refs", "--exit-code", "--", frozenRemoteAlias, destinationRef],
      {
        allowExitCodes: [2],
        frozenRemoteAlias,
        frozenRemote,
        signal,
        timeoutMs: this.pushTimeoutMs,
      },
    );
    if (result.exitCode === 2) return undefined;
    return result.stdout.trim().split(/\s+/, 1)[0] || undefined;
  }

  private async prepareReviewedPrePushProxy(
    repo: GitRepository,
    input: GitPushInput,
    frozenEndpoint: string,
    signal?: AbortSignal,
  ): Promise<GitPrePushProxy> {
    const hookPathResult = await this.run(
      repo.cwd,
      ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push"],
      { signal },
    );
    const resolvedHookPath = hookPathResult.stdout.trim();
    let originalHookPath: string | undefined;
    if (resolvedHookPath && !resolvedHookPath.includes("\u0000")) {
      try {
        await fs.access(resolvedHookPath, fsConstants.X_OK);
        originalHookPath = resolvedHookPath;
      } catch {
        // Missing and non-executable hooks are ignored by native Git push.
      }
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-pre-push-"));
    const completedPath = path.join(tempDir, "completed");
    const proxyPath = path.join(tempDir, "pre-push");
    try {
      await fs.writeFile(
        proxyPath,
        [
          "#!/bin/sh",
          "completed_path=$AIDEN_PRE_PUSH_COMPLETED_PATH",
          "frozen_url=$AIDEN_PRE_PUSH_FROZEN_URL",
          "hook_path=$AIDEN_PRE_PUSH_HOOK_PATH",
          "remote=$AIDEN_PRE_PUSH_REMOTE",
          "config_count=${AIDEN_GIT_CONFIG_COUNT:-}",
          "case $config_count in ''|*[!0-9]*) exit 1 ;; esac",
          'if [ -z "$completed_path" ] || [ -z "$frozen_url" ] || [ -z "$remote" ]; then exit 1; fi',
          "unset GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS",
          "config_index=0",
          'while [ "$config_index" -lt "$config_count" ]; do',
          '  unset "GIT_CONFIG_KEY_$config_index" "GIT_CONFIG_VALUE_$config_index"',
          "  config_index=$((config_index + 1))",
          "done",
          "unset AIDEN_GIT_CONFIG_COUNT AIDEN_PRE_PUSH_COMPLETED_PATH AIDEN_PRE_PUSH_FROZEN_URL AIDEN_PRE_PUSH_HOOK_PATH AIDEN_PRE_PUSH_REMOTE",
          'if [ -n "$hook_path" ]; then',
          '  "$hook_path" "$remote" "$frozen_url"',
          "  hook_status=$?",
          '  if [ "$hook_status" -ne 0 ]; then exit "$hook_status"; fi',
          "fi",
          "umask 077",
          "printf 'complete\\n' > \"$completed_path\" || exit 1",
          "",
        ].join("\n"),
        { encoding: "utf8", mode: 0o700 },
      );
      return {
        completedPath,
        frozenEndpoint,
        hooksPath: tempDir,
        originalHookPath,
        remote: input.remote,
        tempDir,
      };
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async push(cwd: string, input: GitPushInput, signal?: AbortSignal): Promise<GitPushResult> {
    if (!/^[0-9a-f]{40,64}$/.test(input.expectedHead)) {
      throw new GitServiceError("invalid_input", "Refresh the branch state before pushing.");
    }
    if (!/^[0-9a-f]{64}$/.test(input.expectedRemoteIdentity)) {
      throw new GitServiceError("invalid_input", "Refresh the remote state before pushing.");
    }
    if (!input.remote || input.remote !== input.remote.trim() || input.remote.includes("\u0000")) {
      throw new GitServiceError("invalid_input", "Choose a configured Git remote.");
    }
    if (
      !input.expectedBranch ||
      input.expectedBranch !== input.expectedBranch.trim() ||
      input.expectedBranch.includes("\u0000")
    ) {
      throw new GitServiceError("invalid_input", "Refresh the branch state before pushing.");
    }
    if (!input.destinationBranch || input.destinationBranch !== input.destinationBranch.trim()) {
      throw new GitServiceError("invalid_ref", "Enter a valid destination branch.");
    }
    if (typeof input.setUpstream !== "boolean") {
      throw new GitServiceError("invalid_input", "Choose whether to remember the upstream branch.");
    }
    const repo = this.requireRepository(await this.repository(cwd));
    return this.enqueueMutation(repo.commonDir, async () => {
      const capability = await this.inspectPushCapability(repo, signal);
      if (!capability.allowed || !capability.branch || !capability.expectedHead) {
        throw new GitServiceError(
          "command_failed",
          capability.reason ?? "This branch cannot be pushed from Aiden.",
        );
      }
      if (capability.branch !== input.expectedBranch) {
        throw new GitServiceError(
          "stale_snapshot",
          "The current branch changed after this push was reviewed. Refresh before pushing.",
        );
      }
      if (capability.expectedHead !== input.expectedHead) {
        throw new GitServiceError(
          "stale_snapshot",
          "The branch moved after this push was reviewed. Refresh before pushing.",
        );
      }
      if (!capability.remotes.includes(input.remote)) {
        throw new GitServiceError(
          "invalid_input",
          `Remote “${input.remote}” is no longer configured.`,
        );
      }
      if (capability.remoteIdentities[input.remote] !== input.expectedRemoteIdentity) {
        throw new GitServiceError(
          "stale_snapshot",
          `Remote “${input.remote}” changed after this push was reviewed. Refresh before pushing.`,
        );
      }
      const frozenRemote = await this.pushTransport(repo, input.remote, signal);
      if (
        !frozenRemote ||
        this.pushTransportIdentity(frozenRemote) !== input.expectedRemoteIdentity
      ) {
        throw new GitServiceError(
          "stale_snapshot",
          `Remote “${input.remote}” changed while Aiden prepared the push. Refresh before pushing.`,
        );
      }
      const destinationRef = `refs/heads/${input.destinationBranch}`;
      const validDestination = await this.run(repo.cwd, ["check-ref-format", destinationRef], {
        allowExitCodes: [1],
        signal,
      });
      if (validDestination.exitCode !== 0) {
        throw new GitServiceError("invalid_ref", "Enter a valid destination branch.");
      }
      const trackingRefSnapshot = await this.snapshotPushedTrackingRef(
        repo,
        input.remote,
        input.destinationBranch,
        input.expectedHead,
        signal,
      );

      let warning: string | undefined;
      const frozenRemoteAlias = `aiden-reviewed-${randomUUID()}`;
      const prePushProxy = await this.prepareReviewedPrePushProxy(
        repo,
        input,
        frozenRemote.endpoint,
        signal,
      );
      try {
        try {
          await this.run(
            repo.cwd,
            [
              "push",
              "--porcelain",
              "--no-force",
              "--no-mirror",
              "--no-prune",
              "--no-follow-tags",
              "--no-recurse-submodules",
              "--",
              frozenRemoteAlias,
              `${input.expectedHead}:${destinationRef}`,
            ],
            {
              frozenRemoteAlias,
              frozenRemote,
              mutation: true,
              prePushProxy,
              signal,
              timeoutMs: this.pushTimeoutMs,
            },
          );
        } catch (error) {
          if (
            !(error instanceof GitServiceError) ||
            (error.code !== "timeout" && error.code !== "aborted" && error.code !== "output_limit")
          ) {
            throw error;
          }
          const hookCompleted = await fs.access(prePushProxy.completedPath).then(
            () => true,
            () => false,
          );
          if (!hookCompleted) throw error;
          const reconciliation = await this.reconcileRemoteRef(
            repo,
            frozenRemoteAlias,
            frozenRemote,
            destinationRef,
            input.expectedHead,
          );
          if (reconciliation === "different") {
            throw new GitServiceError(
              error.code,
              "Git stopped before Aiden received confirmation, and the remote no longer points to the reviewed commit. Inspect the remote before retrying.",
              error,
            );
          }
          if (reconciliation === "unknown") {
            throw new GitServiceError(
              error.code,
              "Aiden could not determine whether the remote branch was updated. Refresh or inspect the remote before retrying.",
              error,
            );
          }
          warning =
            error.code === "output_limit"
              ? "The push completed, but Git produced more output than Aiden could retain."
              : "The push completed, but Git stopped responding before Aiden received confirmation.";
        }
      } finally {
        await fs.rm(prePushProxy.tempDir, { recursive: true, force: true }).catch(() => undefined);
      }

      let trackingRecorded = false;
      let remoteStillMatches = false;
      try {
        const currentTransport = await this.pushTransport(repo, input.remote);
        remoteStillMatches =
          currentTransport !== undefined &&
          this.pushTransportIdentity(currentTransport) === input.expectedRemoteIdentity;
        if (remoteStillMatches && trackingRefSnapshot) {
          trackingRecorded = await this.recordPushedTrackingRef(
            repo,
            trackingRefSnapshot,
            input.expectedHead,
          );
        }
      } catch {
        trackingRecorded = false;
      }
      if (!trackingRecorded) {
        warning = [
          warning,
          remoteStillMatches
            ? "The push completed, but Aiden could not safely update its local tracking ref."
            : "The push completed, but the remote configuration changed before Aiden could update its local tracking ref.",
        ]
          .filter(Boolean)
          .join(" ");
      }

      let upstreamSet = capability.upstream === `${input.remote}/${input.destinationBranch}`;
      if (input.setUpstream && !upstreamSet) {
        if (signal?.aborted) {
          warning = [
            warning,
            "The push completed, but the cancelled request did not change the local upstream setting.",
          ]
            .filter(Boolean)
            .join(" ");
        } else {
          const [headAfter, symbolicAfter] = await Promise.all([
            this.run(repo.cwd, ["rev-parse", "--verify", "HEAD"], {
              allowExitCodes: [128],
            }),
            this.run(repo.cwd, ["symbolic-ref", "--quiet", "HEAD"], {
              allowExitCodes: [1],
            }),
          ]);
          if (signal?.aborted) {
            warning = [
              warning,
              "The push completed, but the cancelled request did not change the local upstream setting.",
            ]
              .filter(Boolean)
              .join(" ");
          } else if (!remoteStillMatches) {
            warning = [
              warning,
              "The push completed, but the remote configuration changed before Aiden could remember its upstream.",
            ]
              .filter(Boolean)
              .join(" ");
          } else if (
            headAfter.exitCode === 0 &&
            headAfter.stdout.trim() === input.expectedHead &&
            symbolicAfter.exitCode === 0 &&
            symbolicAfter.stdout.trim() === `refs/heads/${input.expectedBranch}`
          ) {
            if (!trackingRecorded) {
              warning = [
                warning,
                signal?.aborted
                  ? "The push completed, but the cancelled request did not change the local upstream setting."
                  : "The push completed, but Aiden could not safely update its local tracking ref or upstream setting.",
              ]
                .filter(Boolean)
                .join(" ");
            } else {
              try {
                await this.run(
                  repo.cwd,
                  [
                    "branch",
                    `--set-upstream-to=${input.remote}/${input.destinationBranch}`,
                    "--",
                    input.expectedBranch,
                  ],
                  { mutation: true, signal },
                );
                upstreamSet = true;
              } catch (error) {
                if (signal?.aborted) {
                  warning = [
                    warning,
                    "The push completed, but the cancelled request did not change the local upstream setting.",
                  ]
                    .filter(Boolean)
                    .join(" ");
                } else {
                  const detail =
                    error instanceof Error
                      ? error.message
                      : "Git could not set the upstream branch.";
                  warning = [
                    warning,
                    `The push completed, but Aiden could not remember its upstream: ${detail}`,
                  ]
                    .filter(Boolean)
                    .join(" ");
                }
              }
            }
          } else {
            warning = [
              warning,
              "The push completed, but the local branch moved before Aiden could remember its upstream.",
            ]
              .filter(Boolean)
              .join(" ");
          }
        }
      }
      return {
        branch: input.expectedBranch,
        commit: input.expectedHead,
        destinationBranch: input.destinationBranch,
        remote: input.remote,
        upstreamSet,
        ...(warning ? { warning } : {}),
      };
    });
  }

  private async validateComparisonTarget(
    repo: GitRepository,
    targetRef: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      targetRef.includes("\u0000") ||
      (!targetRef.startsWith("refs/heads/") && !targetRef.startsWith("refs/remotes/"))
    ) {
      throw new GitServiceError("invalid_ref", "Choose a local or last-fetched branch to compare.");
    }
    const valid = await this.run(repo.cwd, ["check-ref-format", targetRef], {
      allowExitCodes: [1],
      signal,
    });
    if (valid.exitCode !== 0) {
      throw new GitServiceError(
        "invalid_ref",
        "Choose a valid local or last-fetched branch to compare.",
      );
    }
  }

  private async comparisonRefs(
    repo: GitRepository,
    targetRef: string,
    signal?: AbortSignal,
  ): Promise<{ head: string; target: string; branch?: string }> {
    const [head, target, symbolicHead] = await Promise.all([
      this.run(repo.cwd, ["rev-parse", "--verify", "HEAD"], {
        allowExitCodes: [128],
        signal,
      }),
      this.run(repo.cwd, ["show-ref", "--verify", "--hash", targetRef], {
        allowExitCodes: [1],
        signal,
      }),
      this.run(repo.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
        allowExitCodes: [1],
        signal,
      }),
    ]);
    if (head.exitCode !== 0)
      throw new GitServiceError("unborn", "Create the first commit before comparing branches.");
    if (target.exitCode !== 0)
      throw new GitServiceError("invalid_ref", "That comparison branch no longer exists locally.");
    return {
      head: head.stdout.trim(),
      target: target.stdout.trim(),
      branch: symbolicHead.exitCode === 0 ? symbolicHead.stdout.trim() : undefined,
    };
  }

  private async inspectComparison(
    repo: GitRepository,
    targetRef: string,
    signal?: AbortSignal,
  ): Promise<GitComparison> {
    await this.validateComparisonTarget(repo, targetRef, signal);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await this.comparisonRefs(repo, targetRef, signal);
      const mergeBaseResult = await this.run(repo.cwd, ["merge-base", before.target, before.head], {
        allowExitCodes: [1],
        signal,
      });
      if (mergeBaseResult.exitCode !== 0) {
        throw new GitServiceError("invalid_ref", "These branches do not share a common commit.");
      }
      const mergeBase = mergeBaseResult.stdout.trim();
      const [counts, names, numstat] = await Promise.all([
        this.run(
          repo.cwd,
          ["rev-list", "--left-right", "--count", `${before.target}...${before.head}`],
          { signal },
        ),
        this.run(
          repo.cwd,
          [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-status",
            "-z",
            "--find-renames",
            "--relative",
            `${mergeBase}..${before.head}`,
            "--",
            ".",
          ],
          { signal },
        ),
        this.run(
          repo.cwd,
          [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--numstat",
            "-z",
            "--find-renames",
            "--relative",
            `${mergeBase}..${before.head}`,
            "--",
            ".",
          ],
          { signal },
        ),
      ]);
      const after = await this.comparisonRefs(repo, targetRef, signal);
      if (before.head !== after.head || before.target !== after.target) continue;
      const files = parseGitNameStatus(names.stdout);
      const stats = new Map(
        parseGitNumstat(numstat.stdout).map((entry) => [entry.path, entry] as const),
      );
      files.forEach((file) => {
        const stat = stats.get(file.path);
        if (!stat) return;
        file.additions = stat.additions;
        file.deletions = stat.deletions;
        file.binary = stat.binary;
      });
      const [behindText = "0", aheadText = "0"] = counts.stdout.trim().split(/\s+/);
      const summary: GitReviewSummary = {
        fileCount: files.length,
        additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
        deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
        unavailableStats: files.filter(
          (file) => file.additions === undefined || file.deletions === undefined,
        ).length,
        stagedFiles: 0,
        unstagedFiles: 0,
        conflictedFiles: 0,
      };
      const targetLabel = targetRef.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
      const snapshot = createHash("sha256")
        .update(
          [before.head, before.target, targetRef, mergeBase, JSON.stringify(files)].join("\u0000"),
        )
        .digest("hex");
      return {
        currentBranch: before.branch,
        expectedHead: before.head,
        expectedTarget: before.target,
        targetRef,
        targetLabel,
        mergeBase,
        ahead: Number(aheadText) || 0,
        behind: Number(behindText) || 0,
        files,
        summary,
        snapshot,
        remoteState: "local-ref",
      };
    }
    throw new GitServiceError(
      "stale_snapshot",
      "The branch moved while Aiden prepared this comparison. Refresh and try again.",
    );
  }

  async compare(cwd: string, targetRef: string, signal?: AbortSignal): Promise<GitComparison> {
    const repo = this.requireRepository(await this.repository(cwd));
    return this.stableRead(repo, () => this.inspectComparison(repo, targetRef, signal));
  }

  async comparisonDiff(
    cwd: string,
    input: GitComparisonDiffInput,
    signal?: AbortSignal,
  ): Promise<GitFileDiff> {
    for (const value of [input.expectedHead, input.expectedTarget, input.mergeBase]) {
      if (!/^[0-9a-f]{40,64}$/.test(value)) {
        throw new GitServiceError(
          "invalid_input",
          "Refresh the branch comparison before opening this diff.",
        );
      }
    }
    const repo = this.requireRepository(await this.repository(cwd));
    lexicalWorkspacePath(repo.cwd, input.path);
    const comparison = await this.stableRead(repo, () =>
      this.inspectComparison(repo, input.targetRef, signal),
    );
    if (
      comparison.expectedHead !== input.expectedHead ||
      comparison.expectedTarget !== input.expectedTarget ||
      comparison.mergeBase !== input.mergeBase
    ) {
      throw new GitServiceError(
        "stale_snapshot",
        "The comparison changed. Refresh before opening this diff.",
      );
    }
    const file = comparison.files.find((candidate) => candidate.path === input.path);
    if (!file)
      throw new GitServiceError(
        "stale_snapshot",
        "That file is no longer part of this comparison.",
      );
    const pathspecs = file.previousPath ? [file.previousPath, file.path] : [file.path];
    pathspecs.forEach((pathspec) => lexicalWorkspacePath(repo.cwd, pathspec));
    const result = await this.run(
      repo.cwd,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--find-renames",
        "--unified=3",
        "--relative",
        `${input.mergeBase}..${input.expectedHead}`,
        "--",
        ...pathspecs,
      ],
      { signal, allowTruncatedOutput: true },
    );
    const binary = /^(?:Binary files .* differ|GIT binary patch)$/mu.test(result.stdout);
    return {
      path: input.path,
      patch: result.stdout,
      binary,
      truncated: result.truncated === true,
    };
  }

  private async validateBranchName(repo: GitRepository, name: string): Promise<void> {
    const result = await this.run(repo.cwd, ["check-ref-format", "--branch", name], {
      allowExitCodes: [1, 128],
    });
    if (result.exitCode !== 0)
      throw new GitServiceError("invalid_ref", "Enter a valid Git branch name.");
  }

  private async requireHead(repo: GitRepository): Promise<string> {
    const head = await this.run(repo.cwd, ["rev-parse", "--verify", "HEAD"], {
      allowExitCodes: [128],
    });
    if (head.exitCode !== 0) {
      throw new GitServiceError(
        "unborn",
        "Create the repository's first commit before creating another branch or worktree.",
      );
    }
    return head.stdout.trim();
  }

  async checkout(cwd: string, name: string, signal?: AbortSignal): Promise<void> {
    const repo = this.requireRepository(await this.repository(cwd));
    await this.validateBranchName(repo, name);
    await this.enqueueMutation(repo.commonDir, async () => {
      const exists = await this.run(
        repo.cwd,
        ["show-ref", "--verify", "--quiet", `refs/heads/${name}`],
        {
          allowExitCodes: [1],
        },
      );
      if (exists.exitCode !== 0)
        throw new GitServiceError("invalid_ref", `Local branch “${name}” no longer exists.`);
      await this.run(repo.cwd, ["switch", "--no-guess", "--", name], {
        mutation: true,
        signal,
      });
    });
  }

  async createBranch(cwd: string, name: string, signal?: AbortSignal): Promise<void> {
    const repo = this.requireRepository(await this.repository(cwd));
    await this.validateBranchName(repo, name);
    await this.enqueueMutation(repo.commonDir, async () => {
      await this.requireHead(repo);
      await this.run(repo.cwd, ["switch", "-c", name, "--"], {
        mutation: true,
        signal,
      });
    });
  }

  private async inspectWorktrees(
    repo: GitRepository,
    currentPath: string,
    signal?: AbortSignal,
  ): Promise<GitWorktree[]> {
    const result = await this.run(repo.cwd, ["worktree", "list", "--porcelain", "-z"], {
      signal,
    });
    return parseGitWorktrees(result.stdout, currentPath);
  }

  async worktrees(cwd: string, signal?: AbortSignal): Promise<GitWorktree[]> {
    const repo = this.requireRepository(await this.repository(cwd, signal));
    return this.stableRead(repo, () => this.inspectWorktrees(repo, repo.topLevel, signal), signal);
  }

  private validatedWorktreeGitDir(repo: GitRepository, value: string): string {
    const candidate = path.resolve(value);
    const registrationsRoot = path.resolve(repo.commonDir, "worktrees");
    if (path.dirname(candidate) !== registrationsRoot || path.basename(candidate).length === 0) {
      throw new GitServiceError("command_failed", "The managed worktree identity is invalid.");
    }
    return candidate;
  }

  private validatedWorktreeOwnershipToken(value: string): string {
    if (!WORKTREE_OWNER_TOKEN.test(value)) {
      throw new GitServiceError("command_failed", "The managed worktree ownership is invalid.");
    }
    return value;
  }

  private async persistWorktreeOwnership(
    worktreeGitDir: string,
    ownershipToken: string,
  ): Promise<void> {
    const token = this.validatedWorktreeOwnershipToken(ownershipToken);
    const markerPath = path.join(worktreeGitDir, WORKTREE_OWNER_MARKER);
    const handle = await fs.open(markerPath, "wx", 0o600);
    try {
      await handle.writeFile(`${token}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await fs.open(worktreeGitDir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async managedWorktreeRegistration(
    repo: GitRepository,
    worktrees: readonly GitWorktree[],
    worktreePath: string,
    branch: string,
    worktreeGitDir?: string,
    ownershipToken?: string,
  ): Promise<GitWorktree | undefined> {
    // New records carry a marker inside Git's administrative directory. The
    // directory survives a legitimate move, while Git removes the marker when
    // the original registration is removed—even if it later reuses the same
    // administrative path for a replacement checkout.
    if (worktreeGitDir || ownershipToken) {
      if (!worktreeGitDir || !ownershipToken) {
        throw new GitServiceError(
          "command_failed",
          "The managed worktree ownership could not be verified.",
        );
      }
      const candidate = this.validatedWorktreeGitDir(repo, worktreeGitDir);
      const expectedToken = this.validatedWorktreeOwnershipToken(ownershipToken);
      try {
        const ownerPath = path.join(candidate, WORKTREE_OWNER_MARKER);
        const [directory, gitMarker, ownerMarker] = await Promise.all([
          fs.lstat(candidate),
          fs.lstat(path.join(candidate, "gitdir")),
          fs.lstat(ownerPath),
        ]);
        if (
          !directory.isDirectory() ||
          directory.isSymbolicLink() ||
          !gitMarker.isFile() ||
          gitMarker.isSymbolicLink() ||
          gitMarker.size <= 0 ||
          gitMarker.size > 4_096 ||
          !ownerMarker.isFile() ||
          ownerMarker.isSymbolicLink() ||
          ownerMarker.size <= 0 ||
          ownerMarker.size > 128
        ) {
          throw new GitServiceError(
            "command_failed",
            "The managed worktree identity could not be verified.",
          );
        }
        const [gitFileContents, actualToken] = await Promise.all([
          fs.readFile(path.join(candidate, "gitdir"), "utf8"),
          fs.readFile(ownerPath, "utf8"),
        ]);
        if (actualToken.trim() !== expectedToken) {
          throw new GitServiceError(
            "command_failed",
            "The managed worktree ownership could not be verified.",
          );
        }
        const gitFile = gitFileContents.trim();
        if (path.basename(gitFile) !== ".git") {
          throw new GitServiceError(
            "command_failed",
            "The managed worktree identity could not be verified.",
          );
        }
        const absoluteGitFile = path.isAbsolute(gitFile)
          ? path.resolve(gitFile)
          : path.resolve(candidate, gitFile);
        const registeredPath = path.dirname(absoluteGitFile);
        return worktrees.find(
          (worktree) => path.resolve(worktree.path) === path.resolve(registeredPath),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }

    const staleIdentityMatch = worktrees.find(
      (worktree) =>
        path.resolve(worktree.path) === path.resolve(worktreePath) || worktree.branch === branch,
    );
    if (staleIdentityMatch) return staleIdentityMatch;

    // Legacy records predate the stable Git administrative identity. When any
    // linked checkout remains after both stale hints changed, preserve ownership
    // rather than guessing that an irreversible deletion completed.
    return worktrees.find(
      (worktree) => !worktree.bare && path.resolve(worktree.path) !== path.resolve(repo.topLevel),
    );
  }

  private async worktreeAdministrativeRegistrationExists(
    repo: GitRepository,
    worktrees: readonly GitWorktree[],
    worktreeGitDir: string,
  ): Promise<boolean> {
    const candidate = this.validatedWorktreeGitDir(repo, worktreeGitDir);
    try {
      const directory = await fs.lstat(candidate);
      const gitMarkerPath = path.join(candidate, "gitdir");
      const gitMarker = await fs.lstat(gitMarkerPath);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        !gitMarker.isFile() ||
        gitMarker.isSymbolicLink() ||
        gitMarker.size <= 0 ||
        gitMarker.size > 4_096
      ) {
        throw new GitServiceError(
          "command_failed",
          "The managed worktree administrative identity could not be verified.",
        );
      }
      const gitFile = (await fs.readFile(gitMarkerPath, "utf8")).trim();
      if (path.basename(gitFile) !== ".git") {
        throw new GitServiceError(
          "command_failed",
          "The managed worktree administrative identity could not be verified.",
        );
      }
      const absoluteGitFile = path.isAbsolute(gitFile)
        ? path.resolve(gitFile)
        : path.resolve(candidate, gitFile);
      const registeredPath = path.dirname(absoluteGitFile);
      return worktrees.some(
        (worktree) => path.resolve(worktree.path) === path.resolve(registeredPath),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async managedWorktreeRegistered(
    cwd: string,
    worktreePath: string,
    branch: string,
    worktreeGitDir?: string,
    ownershipToken?: string,
  ): Promise<boolean> {
    const repo = this.requireRepository(await this.repository(cwd));
    return this.stableRead(repo, async () => {
      const worktrees = await this.inspectWorktrees(repo, repo.cwd);
      const registered = await this.managedWorktreeRegistration(
        repo,
        worktrees,
        worktreePath,
        branch,
        worktreeGitDir,
        ownershipToken,
      );
      if (registered) return true;
      if (
        worktreeGitDir &&
        ownershipToken &&
        ((await this.worktreeAdministrativeRegistrationExists(repo, worktrees, worktreeGitDir)) ||
          worktrees.some(
            (worktree) =>
              path.resolve(worktree.path) === path.resolve(worktreePath) ||
              worktree.branch === branch,
          ))
      ) {
        throw new GitServiceError(
          "command_failed",
          "The managed worktree remains registered, but Aiden ownership could not be verified.",
        );
      }
      return false;
    });
  }

  async managedWorktreeUsable(
    cwd: string,
    worktreePath: string,
    branch: string,
    worktreeGitDir?: string,
    ownershipToken?: string,
    worktreeDevice?: number,
    worktreeInode?: number,
  ): Promise<boolean> {
    // Capability admission is deliberately stricter than deletion recovery:
    // no legacy inference, moved checkout, or branch drift may inherit a
    // persisted workspace's file, terminal, or generation authority.
    if (
      !worktreeGitDir ||
      !ownershipToken ||
      !Number.isSafeInteger(worktreeDevice) ||
      !Number.isSafeInteger(worktreeInode)
    ) {
      return false;
    }
    const repo = this.requireRepository(await this.repository(cwd));
    return this.stableRead(repo, async () => {
      const registered = await this.managedWorktreeRegistration(
        repo,
        await this.inspectWorktrees(repo, repo.cwd),
        worktreePath,
        branch,
        worktreeGitDir,
        ownershipToken,
      );
      if (
        registered === undefined ||
        path.resolve(registered.path) !== path.resolve(worktreePath) ||
        registered.branch !== branch
      ) {
        return false;
      }
      return this.managedWorktreeCheckoutMatches(
        worktreePath,
        worktreeGitDir,
        worktreeDevice!,
        worktreeInode!,
      );
    });
  }

  private async managedWorktreeCheckoutMatches(
    worktreePath: string,
    worktreeGitDir: string,
    worktreeDevice: number,
    worktreeInode: number,
  ): Promise<boolean> {
    try {
      const checkoutGitDir = await this.managedWorktreeCheckoutGitDir(
        worktreePath,
        worktreeDevice,
        worktreeInode,
      );
      if (!checkoutGitDir || checkoutGitDir !== path.resolve(worktreeGitDir)) return false;
      const [canonicalCheckoutGitDir, canonicalRecordedGitDir] = await Promise.all([
        fs.realpath(checkoutGitDir),
        fs.realpath(worktreeGitDir),
      ]);
      return canonicalCheckoutGitDir === canonicalRecordedGitDir;
    } catch {
      return false;
    }
  }

  private async managedWorktreeCheckoutGitDir(
    worktreePath: string,
    worktreeDevice: number,
    worktreeInode: number,
  ): Promise<string | undefined> {
    try {
      const checkout = await fs.lstat(worktreePath);
      const checkoutGitFile = path.join(worktreePath, ".git");
      const gitFileStat = await fs.lstat(checkoutGitFile);
      if (
        !checkout.isDirectory() ||
        checkout.isSymbolicLink() ||
        checkout.dev !== worktreeDevice ||
        checkout.ino !== worktreeInode ||
        !gitFileStat.isFile() ||
        gitFileStat.isSymbolicLink() ||
        gitFileStat.size <= 0 ||
        gitFileStat.size > 4_096
      ) {
        return undefined;
      }
      const contents = (await fs.readFile(checkoutGitFile, "utf8")).trim();
      const match = /^gitdir:\s*(.+)$/u.exec(contents);
      if (!match) return undefined;
      return path.isAbsolute(match[1]!)
        ? path.resolve(match[1]!)
        : path.resolve(worktreePath, match[1]!);
    } catch {
      return undefined;
    }
  }

  private async managedWorktreeCheckoutRootMatches(
    worktreePath: string,
    worktreeDevice: number,
    worktreeInode: number,
  ): Promise<boolean> {
    try {
      const checkout = await fs.lstat(worktreePath);
      return (
        checkout.isDirectory() &&
        !checkout.isSymbolicLink() &&
        checkout.dev === worktreeDevice &&
        checkout.ino === worktreeInode
      );
    } catch {
      return false;
    }
  }

  private managedWorktreeRemovalPaths(
    worktreePath: string,
    worktreeGitDir: string,
    ownershipToken: string,
  ): {
    checkout: string;
    checkoutAuthorization: string;
    gitDir: string;
    gitDirAuthorization: string;
    journal: string;
  } {
    const token = this.validatedWorktreeOwnershipToken(ownershipToken);
    return {
      checkout: path.join(path.dirname(worktreePath), `.aiden-removing-${token}`),
      checkoutAuthorization: path.join(path.dirname(worktreePath), `.aiden-authorizing-${token}`),
      gitDir: path.join(path.dirname(worktreeGitDir), `.aiden-removing-${token}`),
      gitDirAuthorization: path.join(path.dirname(worktreeGitDir), `.aiden-authorizing-${token}`),
      journal: path.join(path.dirname(worktreePath), `.aiden-removing-${token}.json`),
    };
  }

  private async syncDirectory(directoryPath: string): Promise<void> {
    const directory = await fs.open(directoryPath, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private parsedWorktreeRemovalJournal(value: unknown): GitWorktreeRemovalJournal {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new GitServiceError(
        "command_failed",
        "The managed worktree deletion journal could not be verified.",
      );
    }
    const journal = value as Partial<GitWorktreeRemovalJournal>;
    const keys = Object.keys(journal).sort();
    const expectedKeys = [
      "adminDevice",
      "adminGitdirContents",
      "adminInode",
      "adminManifestDigest",
      "branch",
      "checkoutDevice",
      "checkoutInode",
      "checkoutManifestDigest",
      "checkoutPath",
      "checkoutAuthorization",
      "checkoutQuarantine",
      "createdFromHead",
      "gitDir",
      "gitDirAuthorization",
      "gitDirQuarantine",
      "ownershipToken",
      "phase",
      "repositoryPath",
      "version",
    ].sort();
    if (
      JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
      journal.version !== 3 ||
      (journal.phase !== "prepared" &&
        journal.phase !== "quarantined" &&
        journal.phase !== "checkout_cleanup_started" &&
        journal.phase !== "checkout_complete" &&
        journal.phase !== "admin_cleanup_started" &&
        journal.phase !== "needs_review" &&
        journal.phase !== "filesystem_complete") ||
      !Number.isSafeInteger(journal.adminDevice) ||
      !Number.isSafeInteger(journal.adminInode) ||
      !Number.isSafeInteger(journal.checkoutDevice) ||
      !Number.isSafeInteger(journal.checkoutInode) ||
      journal.adminDevice! < 0 ||
      journal.adminInode! < 0 ||
      journal.checkoutDevice! < 0 ||
      journal.checkoutInode! < 0 ||
      typeof journal.adminGitdirContents !== "string" ||
      (journal.adminManifestDigest !== null &&
        (typeof journal.adminManifestDigest !== "string" ||
          !/^[0-9a-f]{64}$/u.test(journal.adminManifestDigest))) ||
      typeof journal.branch !== "string" ||
      (journal.checkoutManifestDigest !== null &&
        (typeof journal.checkoutManifestDigest !== "string" ||
          !/^[0-9a-f]{64}$/u.test(journal.checkoutManifestDigest))) ||
      typeof journal.checkoutPath !== "string" ||
      typeof journal.checkoutAuthorization !== "string" ||
      typeof journal.checkoutQuarantine !== "string" ||
      typeof journal.createdFromHead !== "string" ||
      typeof journal.gitDir !== "string" ||
      typeof journal.gitDirAuthorization !== "string" ||
      typeof journal.gitDirQuarantine !== "string" ||
      typeof journal.ownershipToken !== "string" ||
      typeof journal.repositoryPath !== "string" ||
      !path.isAbsolute(journal.checkoutPath) ||
      !path.isAbsolute(journal.checkoutAuthorization) ||
      !path.isAbsolute(journal.checkoutQuarantine) ||
      !path.isAbsolute(journal.gitDir) ||
      !path.isAbsolute(journal.gitDirAuthorization) ||
      !path.isAbsolute(journal.gitDirQuarantine) ||
      !path.isAbsolute(journal.repositoryPath)
    ) {
      throw new GitServiceError(
        "command_failed",
        "The managed worktree deletion journal could not be verified.",
      );
    }
    this.validatedWorktreeOwnershipToken(journal.ownershipToken);
    return journal as GitWorktreeRemovalJournal;
  }

  private async readWorktreeRemovalJournal(
    journalPath: string,
    expected?: GitWorktreeRemovalJournal,
  ): Promise<GitWorktreeRemovalJournal | undefined> {
    try {
      const stat = await fs.lstat(journalPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size <= 0 ||
        stat.size > 64 * 1024 ||
        (stat.mode & 0o077) !== 0
      ) {
        throw new GitServiceError(
          "command_failed",
          "The managed worktree deletion journal could not be verified.",
        );
      }
      const journal = this.parsedWorktreeRemovalJournal(
        JSON.parse(await fs.readFile(journalPath, "utf8")),
      );
      if (expected && JSON.stringify(journal) !== JSON.stringify(expected)) {
        throw new GitServiceError(
          "command_failed",
          "The managed worktree deletion journal could not be verified.",
        );
      }
      return journal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof GitServiceError) throw error;
      throw new GitServiceError(
        "command_failed",
        "The managed worktree deletion journal could not be verified.",
        error,
      );
    }
  }

  private async persistWorktreeRemovalJournal(
    journalPath: string,
    journal: GitWorktreeRemovalJournal,
  ): Promise<void> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(journalPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        await this.readWorktreeRemovalJournal(journalPath, journal);
        await this.syncDirectory(path.dirname(journalPath));
        return;
      }
      throw error;
    }
    try {
      await handle.writeFile(`${JSON.stringify(journal)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectory(path.dirname(journalPath));
  }

  private async replaceWorktreeRemovalJournal(
    journalPath: string,
    expected: GitWorktreeRemovalJournal,
    phase: GitWorktreeRemovalJournal["phase"],
    updates: Partial<
      Pick<GitWorktreeRemovalJournal, "adminManifestDigest" | "checkoutManifestDigest">
    > = {},
  ): Promise<GitWorktreeRemovalJournal> {
    await this.readWorktreeRemovalJournal(journalPath, expected);
    const next = { ...expected, ...updates, phase };
    const temporaryPath = `${journalPath}.tmp-${randomUUID()}`;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(next)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, journalPath);
      await this.syncDirectory(path.dirname(journalPath));
      return next;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async clearWorktreeRemovalJournal(
    worktreePath: string,
    worktreeGitDir: string,
    ownershipToken: string,
    journal: GitWorktreeRemovalJournal,
  ): Promise<void> {
    const journalPath = this.managedWorktreeRemovalPaths(
      worktreePath,
      worktreeGitDir,
      ownershipToken,
    ).journal;
    const persisted = await this.readWorktreeRemovalJournal(journalPath, journal);
    if (persisted) await fs.unlink(journalPath);
    await this.syncDirectory(path.dirname(journalPath));
  }

  private async worktreeAdminIdentity(
    candidate: string,
    originalGitDir: string,
    worktreePath: string,
    ownershipToken: string,
    expected?: GitWorktreeAdminIdentity,
  ): Promise<GitWorktreeAdminIdentity> {
    const expectedToken = this.validatedWorktreeOwnershipToken(ownershipToken);
    const ownerPath = path.join(candidate, WORKTREE_OWNER_MARKER);
    const gitdirPath = path.join(candidate, "gitdir");
    const [directory, gitMarker, ownerMarker] = await Promise.all([
      fs.lstat(candidate),
      fs.lstat(gitdirPath),
      fs.lstat(ownerPath),
    ]);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !gitMarker.isFile() ||
      gitMarker.isSymbolicLink() ||
      gitMarker.size <= 0 ||
      gitMarker.size > 4_096 ||
      !ownerMarker.isFile() ||
      ownerMarker.isSymbolicLink() ||
      ownerMarker.size <= 0 ||
      ownerMarker.size > 128
    ) {
      throw new GitServiceError(
        "command_failed",
        "The managed worktree administrative identity could not be verified.",
      );
    }
    const [gitdirContents, actualToken] = await Promise.all([
      fs.readFile(gitdirPath, "utf8"),
      fs.readFile(ownerPath, "utf8"),
    ]);
    if (actualToken.trim() !== expectedToken) {
      throw new GitServiceError(
        "command_failed",
        "The managed worktree ownership could not be verified.",
      );
    }
    const gitFile = gitdirContents.trim();
    if (path.basename(gitFile) !== ".git") {
      throw new GitServiceError(
        "command_failed",
        "The managed worktree administrative identity could not be verified.",
      );
    }
    const registeredGitFile = path.isAbsolute(gitFile)
      ? path.resolve(gitFile)
      : path.resolve(originalGitDir, gitFile);
    if (registeredGitFile !== path.resolve(worktreePath, ".git")) {
      throw new GitServiceError(
        "command_failed",
        "The managed worktree administrative identity could not be verified.",
      );
    }
    const identity = {
      device: directory.dev,
      gitdirContents,
      inode: directory.ino,
    };
    if (
      expected &&
      (identity.device !== expected.device ||
        identity.inode !== expected.inode ||
        identity.gitdirContents !== expected.gitdirContents)
    ) {
      throw new GitServiceError(
        "command_failed",
        "The managed worktree administrative identity changed during deletion.",
      );
    }
    return identity;
  }

  private async pathExists(candidate: string): Promise<boolean> {
    try {
      await fs.lstat(candidate);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async finalizeMissingWorktreeRemovalRoot(
    targetPath: string,
    manifestDigest: string | null,
    journalPath: string,
    journal: GitWorktreeRemovalJournal,
  ): Promise<GitWorktreeRemovalJournal> {
    try {
      if (manifestDigest === null) {
        if (await this.worktreeRemovalManifestInspector(targetPath)) {
          await this.replaceWorktreeRemovalJournal(journalPath, journal, "needs_review");
          throw new GitServiceError(
            "command_failed",
            "An unjournaled managed worktree removal manifest was preserved for review.",
          );
        }
      } else {
        await this.worktreeRemovalManifestFinalizer(targetPath, manifestDigest);
      }
      return journal;
    } catch (error) {
      if (error instanceof GitServiceError) throw error;
      if (
        error instanceof ManagedWorktreeRemoverError &&
        (error.failure === "identity_changed" || error.failure === "mutation_detected")
      ) {
        await this.replaceWorktreeRemovalJournal(journalPath, journal, "needs_review");
      }
      if (error instanceof ManagedWorktreeRemoverError) {
        throw new GitServiceError("command_failed", error.message, error);
      }
      throw error;
    }
  }

  private async restoreQuarantinedPath(quarantine: string, original: string): Promise<boolean> {
    try {
      if (await this.pathExists(original)) return false;
      await fs.rename(quarantine, original);
      await this.syncDirectory(path.dirname(original));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Capture the exact owned checkout before removing it. A path-bearing
   * `git worktree remove` command leaves a check-to-exec window in which an
   * unrelated replacement can be moved into the registered pathname and
   * deleted by Git. Renaming first is atomic; the post-rename inode/admin
   * checks make the captured directory, rather than its former name, the
   * deletion authority.
   */
  private async quarantineAndRemoveManagedWorktree(
    repo: GitRepository,
    worktreePath: string,
    worktreeGitDir: string,
    ownershipToken: string,
    worktreeDevice: number,
    worktreeInode: number,
    branch: string,
    createdFromHead: string,
    signal: AbortSignal | undefined,
    onDestructiveMutation: () => void,
  ): Promise<GitWorktreeRemovalJournal> {
    const originalGitDir = this.validatedWorktreeGitDir(repo, worktreeGitDir);
    const removal = this.managedWorktreeRemovalPaths(worktreePath, originalGitDir, ownershipToken);
    let checkoutMovedThisCall = false;
    let adminMovedThisCall = false;
    const [checkoutQuarantineExists, checkoutAuthorizationExists] = await Promise.all([
      this.pathExists(removal.checkout),
      this.pathExists(removal.checkoutAuthorization),
    ]);
    const [adminQuarantineExists, adminAuthorizationExists] = await Promise.all([
      this.pathExists(removal.gitDir),
      this.pathExists(removal.gitDirAuthorization),
    ]);
    if (
      (checkoutQuarantineExists && checkoutAuthorizationExists) ||
      (adminQuarantineExists && adminAuthorizationExists)
    ) {
      throw new GitServiceError(
        "command_failed",
        "Conflicting managed worktree recovery paths were preserved for review.",
      );
    }
    let checkoutRemovalPath = checkoutAuthorizationExists
      ? removal.checkoutAuthorization
      : checkoutQuarantineExists
        ? removal.checkout
        : undefined;
    let adminRemovalPath = adminAuthorizationExists
      ? removal.gitDirAuthorization
      : adminQuarantineExists
        ? removal.gitDir
        : undefined;
    let checkoutQuarantined = checkoutRemovalPath !== undefined;
    let adminQuarantined = adminRemovalPath !== undefined;
    if (signal?.aborted) {
      throw new GitServiceError("aborted", "Git operation was cancelled.");
    }
    let journal = await this.readWorktreeRemovalJournal(removal.journal);
    const recoveringFromJournal = journal !== undefined;
    if (journal) {
      const matchesRecord =
        journal.repositoryPath === repo.topLevel &&
        journal.checkoutPath === worktreePath &&
        journal.checkoutAuthorization === removal.checkoutAuthorization &&
        journal.checkoutQuarantine === removal.checkout &&
        journal.gitDir === originalGitDir &&
        journal.gitDirAuthorization === removal.gitDirAuthorization &&
        journal.gitDirQuarantine === removal.gitDir &&
        journal.ownershipToken === ownershipToken &&
        journal.checkoutDevice === worktreeDevice &&
        journal.checkoutInode === worktreeInode &&
        journal.branch === branch &&
        journal.createdFromHead === createdFromHead;
      if (!matchesRecord) {
        throw new GitServiceError(
          "command_failed",
          "The managed worktree deletion journal does not match this workspace.",
        );
      }
      if (journal.phase === "needs_review") {
        throw new GitServiceError(
          "command_failed",
          "The managed worktree changed during deletion and was preserved for review.",
        );
      }
      if (journal.phase === "filesystem_complete") {
        if (checkoutQuarantined || adminQuarantined) {
          journal = await this.replaceWorktreeRemovalJournal(
            removal.journal,
            journal,
            "needs_review",
          );
          throw new GitServiceError(
            "command_failed",
            "A completed managed worktree deletion still has recovery paths and was preserved for review.",
          );
        }
        return journal;
      }
      if (journal.phase === "quarantined" && (!checkoutQuarantined || !adminQuarantined)) {
        journal = await this.replaceWorktreeRemovalJournal(
          removal.journal,
          journal,
          "needs_review",
        );
        throw new GitServiceError(
          "command_failed",
          "A managed worktree recovery phase did not match its filesystem paths and was preserved for review.",
        );
      }
      if (journal.phase === "checkout_cleanup_started" && !checkoutQuarantined) {
        journal = await this.finalizeMissingWorktreeRemovalRoot(
          removal.checkout,
          journal.checkoutManifestDigest,
          removal.journal,
          journal,
        );
        journal = await this.replaceWorktreeRemovalJournal(
          removal.journal,
          journal,
          "checkout_complete",
        );
      }
      if (journal.phase === "checkout_complete" && checkoutQuarantined) {
        journal = await this.replaceWorktreeRemovalJournal(
          removal.journal,
          journal,
          "needs_review",
        );
        throw new GitServiceError(
          "command_failed",
          "A completed checkout cleanup still has a recovery path and was preserved for review.",
        );
      }
      if (journal.phase === "checkout_complete" && !checkoutQuarantined && !adminQuarantined) {
        journal = await this.replaceWorktreeRemovalJournal(
          removal.journal,
          journal,
          "needs_review",
        );
        throw new GitServiceError(
          "command_failed",
          "The managed worktree administrative recovery path disappeared before cleanup was authorized.",
        );
      }
      if (journal.phase === "admin_cleanup_started") {
        if (checkoutQuarantined) {
          journal = await this.replaceWorktreeRemovalJournal(
            removal.journal,
            journal,
            "needs_review",
          );
          throw new GitServiceError(
            "command_failed",
            "Administrative cleanup started while a checkout recovery path remained.",
          );
        }
        if (!adminQuarantined) {
          journal = await this.finalizeMissingWorktreeRemovalRoot(
            removal.gitDir,
            journal.adminManifestDigest,
            removal.journal,
            journal,
          );
          return this.replaceWorktreeRemovalJournal(
            removal.journal,
            journal,
            "filesystem_complete",
          );
        }
      }
    } else {
      if (checkoutQuarantined || adminQuarantined) {
        throw new GitServiceError(
          "command_failed",
          "An unjournaled managed worktree recovery path was preserved.",
        );
      }
      if (
        !(await this.managedWorktreeCheckoutMatches(
          worktreePath,
          originalGitDir,
          worktreeDevice,
          worktreeInode,
        ))
      ) {
        throw new GitServiceError(
          "command_failed",
          "This managed worktree moved or changed identity outside Aiden. Restore its original path and branch before deleting it from Aiden.",
        );
      }
      const initialAdminIdentity = await this.worktreeAdminIdentity(
        originalGitDir,
        originalGitDir,
        worktreePath,
        ownershipToken,
      );
      journal = {
        version: 3,
        phase: "prepared",
        adminDevice: initialAdminIdentity.device,
        adminGitdirContents: initialAdminIdentity.gitdirContents,
        adminInode: initialAdminIdentity.inode,
        adminManifestDigest: null,
        branch,
        checkoutDevice: worktreeDevice,
        checkoutInode: worktreeInode,
        checkoutManifestDigest: null,
        checkoutPath: worktreePath,
        checkoutAuthorization: removal.checkoutAuthorization,
        checkoutQuarantine: removal.checkout,
        createdFromHead,
        gitDir: originalGitDir,
        gitDirAuthorization: removal.gitDirAuthorization,
        gitDirQuarantine: removal.gitDir,
        ownershipToken,
        repositoryPath: repo.topLevel,
      };
      await this.persistWorktreeRemovalJournal(removal.journal, journal);
    }
    const journalAdminIdentity: GitWorktreeAdminIdentity = {
      device: journal.adminDevice,
      gitdirContents: journal.adminGitdirContents,
      inode: journal.adminInode,
    };

    if (checkoutQuarantined) {
      if (
        !(await this.managedWorktreeCheckoutRootMatches(
          checkoutRemovalPath!,
          worktreeDevice,
          worktreeInode,
        ))
      ) {
        throw new GitServiceError(
          "command_failed",
          "A managed worktree recovery path contains an unrelated checkout and was preserved.",
        );
      }
      onDestructiveMutation();
    } else if (adminQuarantined) {
      if (
        await this.managedWorktreeCheckoutRootMatches(worktreePath, worktreeDevice, worktreeInode)
      ) {
        throw new GitServiceError(
          "command_failed",
          "A managed worktree recovery path conflicts with the live checkout. Both were preserved.",
        );
      }
      // The exact checkout was already removed before an earlier attempt
      // stopped. The ownership marker in the quarantined administrative
      // directory is the durable authority for finishing that attempt.
      onDestructiveMutation();
    } else {
      if (
        !(await this.managedWorktreeCheckoutMatches(
          worktreePath,
          originalGitDir,
          worktreeDevice,
          worktreeInode,
        ))
      ) {
        throw new GitServiceError(
          "command_failed",
          "This managed worktree moved or changed identity outside Aiden. Restore its original path and branch before deleting it from Aiden.",
        );
      }
      await this.worktreeAdminIdentity(
        originalGitDir,
        originalGitDir,
        worktreePath,
        ownershipToken,
        journalAdminIdentity,
      );
      await fs.rename(worktreePath, removal.checkout);
      checkoutMovedThisCall = true;
      checkoutQuarantined = true;
      checkoutRemovalPath = removal.checkout;
      onDestructiveMutation();
      await this.syncDirectory(path.dirname(worktreePath));
      const checkoutGitDir = await this.managedWorktreeCheckoutGitDir(
        checkoutRemovalPath,
        worktreeDevice,
        worktreeInode,
      );
      if (checkoutGitDir !== originalGitDir) {
        await this.restoreQuarantinedPath(removal.checkout, worktreePath);
        throw new GitServiceError(
          "command_failed",
          "This managed worktree changed identity at the deletion boundary and was preserved.",
        );
      }
    }

    if (
      (await this.managedWorktreeCheckoutMatches(
        worktreePath,
        originalGitDir,
        worktreeDevice,
        worktreeInode,
      )) &&
      checkoutQuarantined
    ) {
      throw new GitServiceError(
        "command_failed",
        "A managed worktree recovery path conflicts with the live checkout. Both were preserved.",
      );
    }

    let adminIdentity: GitWorktreeAdminIdentity;
    let activeGitDir: string;
    if (adminQuarantined) {
      if (await this.pathExists(originalGitDir)) {
        throw new GitServiceError(
          "command_failed",
          "A managed worktree recovery path conflicts with its Git registration. Both were preserved.",
        );
      }
      if (
        journal.phase === "admin_cleanup_started" &&
        adminRemovalPath === removal.gitDirAuthorization
      ) {
        if (
          !(await this.managedWorktreeCheckoutRootMatches(
            adminRemovalPath,
            journalAdminIdentity.device,
            journalAdminIdentity.inode,
          ))
        ) {
          throw new GitServiceError(
            "command_failed",
            "The isolated managed worktree administrative identity changed during recovery.",
          );
        }
        adminIdentity = journalAdminIdentity;
      } else {
        adminIdentity = await this.worktreeAdminIdentity(
          adminRemovalPath!,
          originalGitDir,
          worktreePath,
          ownershipToken,
          journalAdminIdentity,
        );
      }
      activeGitDir = adminRemovalPath!;
      onDestructiveMutation();
    } else {
      adminIdentity = await this.worktreeAdminIdentity(
        originalGitDir,
        originalGitDir,
        worktreePath,
        ownershipToken,
        journalAdminIdentity,
      );
      activeGitDir = originalGitDir;
    }

    // Re-run the clean-tree guard against the captured inode. This preserves a
    // file that appeared after the first status read but before the atomic
    // rename, while the old registered pathname is no longer a deletion target.
    const checkoutCleanupHasDurableManifest =
      recoveringFromJournal &&
      journal.phase === "checkout_cleanup_started" &&
      journal.checkoutManifestDigest !== null;
    if (checkoutQuarantined && !checkoutCleanupHasDurableManifest) {
      const status = parseGitStatus(
        (
          await this.run(repo.cwd, [
            `--git-dir=${activeGitDir}`,
            `--work-tree=${checkoutRemovalPath!}`,
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
          ])
        ).stdout,
      );
      if (status.uncommitted > 0 || status.ignored > 0) {
        if (!adminQuarantined && checkoutMovedThisCall) {
          await this.restoreQuarantinedPath(removal.checkout, worktreePath);
        }
        if (recoveringFromJournal && journal.phase === "checkout_cleanup_started") {
          journal = await this.replaceWorktreeRemovalJournal(
            removal.journal,
            journal,
            "needs_review",
          );
        }
        throw new GitServiceError(
          "dirty_worktree",
          "The managed worktree contains uncommitted, untracked, or ignored files and was preserved.",
        );
      }
    }
    if (
      checkoutQuarantined &&
      !(await this.managedWorktreeCheckoutRootMatches(
        checkoutRemovalPath!,
        worktreeDevice,
        worktreeInode,
      ))
    ) {
      if (!adminQuarantined && checkoutMovedThisCall) {
        await this.restoreQuarantinedPath(removal.checkout, worktreePath);
      }
      if (recoveringFromJournal && journal.phase === "checkout_cleanup_started") {
        journal = await this.replaceWorktreeRemovalJournal(
          removal.journal,
          journal,
          "needs_review",
        );
      }
      throw new GitServiceError(
        "command_failed",
        "This managed worktree changed identity at the deletion boundary and was preserved.",
      );
    }

    if (!adminQuarantined) {
      await fs.rename(originalGitDir, removal.gitDir);
      adminMovedThisCall = true;
      adminQuarantined = true;
      adminRemovalPath = removal.gitDir;
      onDestructiveMutation();
      await this.syncDirectory(path.dirname(originalGitDir));
      try {
        await this.worktreeAdminIdentity(
          removal.gitDir,
          originalGitDir,
          worktreePath,
          ownershipToken,
          adminIdentity,
        );
      } catch (error) {
        if (adminMovedThisCall) {
          await this.restoreQuarantinedPath(removal.gitDir, originalGitDir);
        }
        if (checkoutMovedThisCall) {
          await this.restoreQuarantinedPath(removal.checkout, worktreePath);
        }
        throw error;
      }
    }

    if (
      !(
        journal.phase === "admin_cleanup_started" &&
        adminRemovalPath === removal.gitDirAuthorization
      )
    ) {
      await this.worktreeAdminIdentity(
        adminRemovalPath!,
        originalGitDir,
        worktreePath,
        ownershipToken,
        adminIdentity,
      );
    }
    if (journal.phase === "prepared") {
      journal = await this.replaceWorktreeRemovalJournal(removal.journal, journal, "quarantined");
    }
    try {
      if (checkoutQuarantined) {
        if (journal.phase === "quarantined") {
          journal = await this.replaceWorktreeRemovalJournal(
            removal.journal,
            journal,
            "checkout_cleanup_started",
          );
        }
        if (journal.phase !== "checkout_cleanup_started") {
          throw new GitServiceError(
            "command_failed",
            "The managed checkout cleanup phase could not be verified.",
          );
        }
        if (
          !(await this.managedWorktreeCheckoutRootMatches(
            checkoutRemovalPath!,
            worktreeDevice,
            worktreeInode,
          ))
        ) {
          throw new ManagedWorktreeRemoverError("identity_changed");
        }
        await this.worktreeDirectoryRemover({
          path: checkoutRemovalPath!,
          device: worktreeDevice,
          inode: worktreeInode,
          authorizedManifestDigest: journal.checkoutManifestDigest ?? undefined,
          authorize: async (scannedPath, manifestDigest) => {
            const status = parseGitStatus(
              (
                await this.run(repo.cwd, [
                  `--git-dir=${adminRemovalPath!}`,
                  `--work-tree=${scannedPath}`,
                  "status",
                  "--porcelain=v2",
                  "--branch",
                  "-z",
                  "--untracked-files=all",
                  "--ignored=matching",
                ])
              ).stdout,
            );
            if (status.uncommitted > 0 || status.ignored > 0) {
              throw new GitServiceError(
                "dirty_worktree",
                "The managed worktree changed after its deletion scan and was preserved for review.",
              );
            }
            journal = await this.replaceWorktreeRemovalJournal(
              removal.journal,
              journal!,
              journal!.phase,
              { checkoutManifestDigest: manifestDigest },
            );
          },
        });
        checkoutQuarantined = false;
        checkoutRemovalPath = undefined;
      }
      if (journal.phase === "checkout_cleanup_started") {
        journal = await this.replaceWorktreeRemovalJournal(
          removal.journal,
          journal,
          "checkout_complete",
        );
      }
      if (journal.phase === "checkout_complete") {
        journal = await this.replaceWorktreeRemovalJournal(
          removal.journal,
          journal,
          "admin_cleanup_started",
        );
      }
      if (journal.phase !== "admin_cleanup_started") {
        throw new GitServiceError(
          "command_failed",
          "The managed worktree administrative cleanup phase could not be verified.",
        );
      }
      if (adminQuarantined) {
        if (adminRemovalPath === removal.gitDir) {
          await this.worktreeAdminIdentity(
            adminRemovalPath,
            originalGitDir,
            worktreePath,
            ownershipToken,
            adminIdentity,
          );
        } else if (
          !(await this.managedWorktreeCheckoutRootMatches(
            adminRemovalPath!,
            adminIdentity.device,
            adminIdentity.inode,
          ))
        ) {
          throw new ManagedWorktreeRemoverError("identity_changed");
        }
        await this.worktreeDirectoryRemover({
          path: adminRemovalPath!,
          device: adminIdentity.device,
          inode: adminIdentity.inode,
          authorizedManifestDigest: journal.adminManifestDigest ?? undefined,
          authorize: async (scannedPath, manifestDigest) => {
            await this.worktreeAdminIdentity(
              scannedPath,
              originalGitDir,
              worktreePath,
              ownershipToken,
              adminIdentity,
            );
            journal = await this.replaceWorktreeRemovalJournal(
              removal.journal,
              journal!,
              journal!.phase,
              { adminManifestDigest: manifestDigest },
            );
          },
        });
        adminQuarantined = false;
        adminRemovalPath = undefined;
      }
    } catch (error) {
      const requiresReview =
        (error instanceof ManagedWorktreeRemoverError &&
          (error.failure === "identity_changed" || error.failure === "mutation_detected")) ||
        (error instanceof GitServiceError &&
          (error.code === "dirty_worktree" ||
            /changed|conflict|identity|preserved|could not be verified/u.test(error.message)));
      if (requiresReview) {
        await this.replaceWorktreeRemovalJournal(removal.journal, journal, "needs_review").catch(
          () => undefined,
        );
      }
      if (error instanceof ManagedWorktreeRemoverError) {
        throw new GitServiceError("command_failed", error.message, error);
      }
      throw error;
    }
    return this.replaceWorktreeRemovalJournal(removal.journal, journal, "filesystem_complete");
  }

  private async rollbackCreatedWorktree(
    repo: GitRepository,
    worktreePath: string,
    branch: string,
    createdFromHead: string,
    createdByCommand: boolean,
    identity?: GitWorktreeRollbackIdentity,
  ): Promise<unknown | undefined> {
    let rollbackError: unknown;
    let removalJournal: GitWorktreeRemovalJournal | undefined;
    let worktrees: GitWorktree[];
    try {
      worktrees = await this.inspectWorktrees(repo, repo.cwd);
    } catch (error) {
      return error;
    }
    const registrationHint = worktrees.find(
      (worktree) =>
        worktree.branch === branch && path.resolve(worktree.path) === path.resolve(worktreePath),
    );

    if (!registrationHint) {
      // A failed command may leave an unrelated directory at the randomized
      // target. With no exact Git registration, Aiden has no filesystem
      // deletion authority. A command that definitely returned success still
      // owns its unchanged branch ref, which can be removed atomically.
      if (createdByCommand) {
        try {
          await this.deleteBranchRefIfMatches(repo, branch, createdFromHead);
        } catch (error) {
          return error;
        }
      }
      return undefined;
    }
    if (!identity) {
      return new GitServiceError(
        "command_failed",
        "The partially created worktree has no stable ownership identity and was preserved.",
      );
    }

    let registration: GitWorktree | undefined;
    try {
      registration = await this.managedWorktreeRegistration(
        repo,
        worktrees,
        worktreePath,
        branch,
        identity.worktreeGitDir,
        identity.ownershipToken,
      );
    } catch (error) {
      return error;
    }
    if (
      !registration ||
      registration.branch !== branch ||
      path.resolve(registration.path) !== path.resolve(worktreePath)
    ) {
      return new GitServiceError(
        "command_failed",
        "The partially created worktree changed ownership before rollback.",
      );
    }
    if (registration.head !== createdFromHead) {
      return new GitServiceError(
        "command_failed",
        "The partially created worktree changed identity before rollback.",
      );
    }

    if (
      !(await this.managedWorktreeCheckoutMatches(
        worktreePath,
        identity.worktreeGitDir,
        identity.worktreeDevice,
        identity.worktreeInode,
      ))
    ) {
      return new GitServiceError(
        "command_failed",
        "The partially created worktree checkout identity could not be verified.",
      );
    }

    try {
      const status = parseGitStatus(
        (
          await this.run(worktreePath, [
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
          ])
        ).stdout,
      );
      if (status.uncommitted > 0 || status.ignored > 0) {
        return new GitServiceError(
          "dirty_worktree",
          "The partially created worktree contains uncommitted, untracked, or ignored files and was preserved for inspection.",
        );
      }
      if (
        !(await this.managedWorktreeCheckoutMatches(
          worktreePath,
          identity.worktreeGitDir,
          identity.worktreeDevice,
          identity.worktreeInode,
        ))
      ) {
        return new GitServiceError(
          "command_failed",
          "The partially created worktree changed identity at the rollback boundary.",
        );
      }
      removalJournal = await this.quarantineAndRemoveManagedWorktree(
        repo,
        worktreePath,
        identity.worktreeGitDir,
        identity.ownershipToken,
        identity.worktreeDevice,
        identity.worktreeInode,
        branch,
        createdFromHead,
        undefined,
        () => undefined,
      );
    } catch (error) {
      rollbackError ??= error;
    }
    try {
      const remaining = await this.inspectWorktrees(repo, repo.cwd);
      const registrationRemains = remaining.some(
        (worktree) =>
          worktree.branch === branch && path.resolve(worktree.path) === path.resolve(worktreePath),
      );
      const branchInUse = remaining.some((worktree) => worktree.branch === branch);
      if (!rollbackError && !registrationRemains && !branchInUse) {
        await this.deleteBranchRefIfMatches(repo, branch, createdFromHead);
      } else if (!rollbackError) {
        rollbackError = new GitServiceError(
          "command_failed",
          "The partially created worktree remained registered after rollback.",
        );
      }
    } catch (error) {
      rollbackError ??= error;
    }
    if (!rollbackError && removalJournal) {
      try {
        await this.clearWorktreeRemovalJournal(
          worktreePath,
          identity!.worktreeGitDir,
          identity!.ownershipToken,
          removalJournal,
        );
      } catch (error) {
        rollbackError = error;
      }
    }
    return rollbackError;
  }

  private async deleteBranchRefIfMatches(
    repo: GitRepository,
    branch: string,
    expectedHead: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const refName = `refs/heads/${branch}`;
    try {
      // The expected old object makes deletion one compare-and-swap operation.
      // A preceding show-ref cannot provide this authority because an external
      // Git process may advance or recreate the branch before deletion.
      await this.run(repo.cwd, ["update-ref", "-d", refName, expectedHead], {
        mutation: true,
        signal,
      });
      return true;
    } catch (error) {
      if (
        error instanceof GitServiceError &&
        (error.code === "aborted" || error.code === "output_limit" || error.code === "timeout")
      ) {
        throw error;
      }
      const current = await this.run(repo.cwd, ["show-ref", "--verify", "--hash", refName], {
        allowExitCodes: [1],
        signal,
      });
      if (current.exitCode !== 0 || current.stdout.trim() !== expectedHead) return false;
      throw error;
    }
  }

  async createWorktree(
    cwd: string,
    root: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<GitCreatedWorktree> {
    const repo = this.requireRepository(await this.repository(cwd));
    await this.validateBranchName(repo, branch);
    return this.enqueueMutation(repo.commonDir, async () => {
      const createdFromHead = await this.requireHead(repo);
      const exists = await this.run(
        repo.cwd,
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        {
          allowExitCodes: [1],
        },
      );
      if (exists.exitCode === 0)
        throw new GitServiceError("invalid_ref", `Branch “${branch}” already exists.`);

      const repositoryId = createHash("sha256").update(repo.commonDir).digest("hex").slice(0, 12);
      const repositoryName =
        path.basename(repo.topLevel).replace(/[^a-zA-Z0-9._-]+/g, "-") || "repository";
      const branchSlug =
        branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const managedRoot = await fs.realpath(root);
      const repositoryRoot = path.join(managedRoot, `${repositoryName}-${repositoryId}`);
      await fs.mkdir(repositoryRoot, { recursive: true, mode: 0o700 });
      const worktreePath = path.join(repositoryRoot, `${branchSlug}-${randomUUID().slice(0, 8)}`);
      let createdByCommand = false;
      let rollbackIdentity: GitWorktreeRollbackIdentity | undefined;
      try {
        await this.run(repo.cwd, ["worktree", "add", "-b", branch, "--", worktreePath, "HEAD"], {
          mutation: true,
          signal,
        });
        createdByCommand = true;
        const created = (await this.inspectWorktrees(repo, worktreePath)).find(
          (worktree) => worktree.branch === branch,
        );
        if (!created)
          throw new GitServiceError(
            "command_failed",
            "Git created the worktree but Aiden could not inspect it.",
          );
        const gitDirResult = await this.run(created.path, [
          "rev-parse",
          "--path-format=absolute",
          "--git-dir",
        ]);
        const worktreeGitDir = this.validatedWorktreeGitDir(
          repo,
          await fs.realpath(gitDirResult.stdout.trim()),
        );
        const ownershipToken = randomUUID();
        await this.persistWorktreeOwnership(worktreeGitDir, ownershipToken);
        const checkoutIdentity = await fs.lstat(created.path);
        if (!checkoutIdentity.isDirectory() || checkoutIdentity.isSymbolicLink()) {
          throw new GitServiceError(
            "command_failed",
            "The managed worktree checkout identity could not be verified.",
          );
        }
        rollbackIdentity = {
          worktreeGitDir,
          ownershipToken,
          worktreeDevice: checkoutIdentity.dev,
          worktreeInode: checkoutIdentity.ino,
        };
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
          worktreeGitDir,
          ownershipToken,
          worktreeDevice: checkoutIdentity.dev,
          worktreeInode: checkoutIdentity.ino,
          createdFromHead,
        };
      } catch (error) {
        const rollbackError = await this.rollbackCreatedWorktree(
          repo,
          worktreePath,
          branch,
          createdFromHead,
          createdByCommand,
          rollbackIdentity,
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
        {
          worktreeGitDir: created.worktreeGitDir,
          ownershipToken: created.ownershipToken,
          worktreeDevice: created.worktreeDevice,
          worktreeInode: created.worktreeInode,
        },
      );
      if (rollbackError) {
        throw new GitServiceError(
          "command_failed",
          "Aiden could not fully roll back the managed worktree.",
          rollbackError,
        );
      }
    });
  }

  async deleteManagedWorktree(
    cwd: string,
    worktreePath: string,
    branch: string,
    createdFromHead: string,
    signal?: AbortSignal,
    worktreeGitDir?: string,
    ownershipToken?: string,
    worktreeDevice?: number,
    worktreeInode?: number,
    retainRemovalJournal = false,
  ): Promise<GitDeleteWorktreeResult> {
    let destructiveMutationAttempted = false;
    try {
      const repo = this.requireRepository(await this.repository(cwd));
      return await this.enqueueMutation(repo.commonDir, async () => {
        if (!worktreeGitDir || !ownershipToken) {
          throw new GitServiceError(
            "command_failed",
            "This legacy managed worktree has no verifiable Aiden ownership marker and cannot be deleted automatically.",
          );
        }
        if (
          !Number.isSafeInteger(worktreeDevice) ||
          !Number.isSafeInteger(worktreeInode) ||
          worktreeDevice! < 0 ||
          worktreeInode! < 0
        ) {
          throw new GitServiceError(
            "command_failed",
            "This legacy managed worktree has no verifiable checkout identity and cannot be deleted automatically.",
          );
        }
        const removal = this.managedWorktreeRemovalPaths(
          worktreePath,
          this.validatedWorktreeGitDir(repo, worktreeGitDir),
          ownershipToken,
        );
        const journalPending = await this.pathExists(removal.journal);
        const recoveryPending =
          (await this.pathExists(removal.checkout)) ||
          (await this.pathExists(removal.checkoutAuthorization)) ||
          (await this.pathExists(removal.gitDir)) ||
          (await this.pathExists(removal.gitDirAuthorization)) ||
          journalPending;
        if (journalPending) destructiveMutationAttempted = true;
        if (!recoveryPending) {
          const worktrees = await this.inspectWorktrees(repo, repo.cwd);
          const registered = await this.managedWorktreeRegistration(
            repo,
            worktrees,
            worktreePath,
            branch,
            worktreeGitDir,
            ownershipToken,
          );
          if (!registered) {
            throw new GitServiceError(
              "command_failed",
              "This managed worktree is no longer registered.",
            );
          }
          if (path.resolve(registered.path) !== path.resolve(worktreePath)) {
            throw new GitServiceError(
              "command_failed",
              "This managed worktree moved or changed identity outside Aiden. Restore its original path and branch before deleting it from Aiden.",
            );
          }
          if (registered.branch !== branch) {
            throw new GitServiceError(
              "command_failed",
              "This managed worktree changed branches or became detached. Restore its original branch before deleting it from Aiden.",
            );
          }
          const status = parseGitStatus(
            (
              await this.run(worktreePath, [
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
                "--ignored=matching",
              ])
            ).stdout,
          );
          if (status.uncommitted > 0 || status.ignored > 0) {
            throw new GitServiceError(
              "dirty_worktree",
              "Remove, commit, stash, or discard every uncommitted, untracked, and ignored file before deleting this worktree.",
            );
          }
          // Re-check the checkout itself at the destructive boundary. Git's
          // registration and Aiden's administrative marker can both remain valid
          // after the original directory is renamed and an unrelated replacement
          // copies its checkout-side .git pointer into the stale path.
          if (
            !(await this.managedWorktreeCheckoutMatches(
              worktreePath,
              worktreeGitDir,
              worktreeDevice!,
              worktreeInode!,
            ))
          ) {
            throw new GitServiceError(
              "command_failed",
              "This managed worktree moved or changed identity outside Aiden. Restore its original path and branch before deleting it from Aiden.",
            );
          }
        }
        const removalJournal = await this.quarantineAndRemoveManagedWorktree(
          repo,
          worktreePath,
          worktreeGitDir,
          ownershipToken,
          worktreeDevice!,
          worktreeInode!,
          branch,
          createdFromHead,
          signal,
          () => {
            destructiveMutationAttempted = true;
          },
        );
        const branchDeleted = await this.deleteBranchRefIfMatches(
          repo,
          branch,
          createdFromHead,
          signal,
        );
        if (!retainRemovalJournal) {
          await this.clearWorktreeRemovalJournal(
            worktreePath,
            worktreeGitDir,
            ownershipToken,
            removalJournal,
          );
        }
        return { branchDeleted };
      });
    } catch (error) {
      if (error instanceof GitManagedWorktreeDeleteError) throw error;
      if (error instanceof GitServiceError) {
        throw new GitManagedWorktreeDeleteError(error, destructiveMutationAttempted);
      }
      throw new GitManagedWorktreeDeleteError(
        new GitServiceError(
          "command_failed",
          "Aiden could not delete the managed worktree.",
          error,
        ),
        destructiveMutationAttempted,
      );
    }
  }

  async finalizeManagedWorktreeDeletion(
    worktreePath: string,
    worktreeGitDir: string,
    ownershipToken: string,
  ): Promise<void> {
    const removal = this.managedWorktreeRemovalPaths(worktreePath, worktreeGitDir, ownershipToken);
    const journal = await this.readWorktreeRemovalJournal(removal.journal);
    if (!journal) return;
    if (
      journal.checkoutPath !== worktreePath ||
      journal.checkoutAuthorization !== removal.checkoutAuthorization ||
      journal.checkoutQuarantine !== removal.checkout ||
      journal.gitDir !== worktreeGitDir ||
      journal.gitDirAuthorization !== removal.gitDirAuthorization ||
      journal.gitDirQuarantine !== removal.gitDir ||
      journal.ownershipToken !== ownershipToken
    ) {
      throw new GitServiceError(
        "command_failed",
        "The managed worktree deletion journal does not match this workspace.",
      );
    }
    if (journal.phase !== "filesystem_complete") {
      throw new GitServiceError(
        "command_failed",
        "The managed worktree deletion has not completed its filesystem transaction.",
      );
    }
    if (
      (await this.pathExists(removal.checkout)) ||
      (await this.pathExists(removal.checkoutAuthorization)) ||
      (await this.pathExists(removal.gitDir)) ||
      (await this.pathExists(removal.gitDirAuthorization))
    ) {
      throw new GitServiceError(
        "command_failed",
        "The managed worktree deletion is not ready to finalize.",
      );
    }
    await this.clearWorktreeRemovalJournal(worktreePath, worktreeGitDir, ownershipToken, journal);
  }

  async finalizeOrphanedManagedWorktreeDeletionJournals(
    worktreeRoot: string,
    referencedOwnershipTokens: ReadonlySet<string> = new Set(),
    onError: (error: unknown) => void = () => undefined,
  ): Promise<number> {
    const canonicalRoot = await fs.realpath(worktreeRoot);
    const rootStat = await fs.lstat(canonicalRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new GitServiceError(
        "command_failed",
        "Aiden's managed worktree root could not be verified.",
      );
    }

    const repositoryEntries = await fs.readdir(canonicalRoot, { withFileTypes: true });
    if (repositoryEntries.length > 4_096) {
      throw new GitServiceError(
        "command_failed",
        "Aiden's managed worktree root contains too many entries to reconcile safely.",
      );
    }

    let finalized = 0;
    for (const repositoryEntry of repositoryEntries) {
      if (!repositoryEntry.isDirectory() || repositoryEntry.isSymbolicLink()) continue;
      const repositoryRoot = path.join(canonicalRoot, repositoryEntry.name);
      try {
        const [repositoryStat, canonicalRepositoryRoot] = await Promise.all([
          fs.lstat(repositoryRoot),
          fs.realpath(repositoryRoot),
        ]);
        if (
          !repositoryStat.isDirectory() ||
          repositoryStat.isSymbolicLink() ||
          canonicalRepositoryRoot !== repositoryRoot
        ) {
          continue;
        }
        const entries = await fs.readdir(repositoryRoot, { withFileTypes: true });
        if (entries.length > 4_096) {
          throw new GitServiceError(
            "command_failed",
            "A managed worktree repository contains too many entries to reconcile safely.",
          );
        }
        for (const entry of entries) {
          const match =
            entry.isFile() &&
            !entry.isSymbolicLink() &&
            /^\.aiden-removing-([0-9a-f-]+)\.json$/u.exec(entry.name);
          if (!match) continue;
          const journalPath = path.join(repositoryRoot, entry.name);
          try {
            const ownershipToken = this.validatedWorktreeOwnershipToken(match[1]!);
            if (referencedOwnershipTokens.has(ownershipToken)) continue;
            const journal = await this.readWorktreeRemovalJournal(journalPath);
            if (!journal) continue;
            const removal = this.managedWorktreeRemovalPaths(
              journal.checkoutPath,
              journal.gitDir,
              ownershipToken,
            );
            if (
              journalPath !== removal.journal ||
              journal.ownershipToken !== ownershipToken ||
              journal.checkoutAuthorization !== removal.checkoutAuthorization ||
              journal.checkoutQuarantine !== removal.checkout ||
              journal.gitDirAuthorization !== removal.gitDirAuthorization ||
              journal.gitDirQuarantine !== removal.gitDir
            ) {
              throw new GitServiceError(
                "command_failed",
                "The orphaned managed worktree deletion journal could not be verified.",
              );
            }
            if (journal.phase !== "filesystem_complete") continue;
            const remainingPath = await Promise.all([
              this.pathExists(journal.checkoutPath),
              this.pathExists(journal.checkoutAuthorization),
              this.pathExists(journal.checkoutQuarantine),
              this.pathExists(journal.gitDir),
              this.pathExists(journal.gitDirAuthorization),
              this.pathExists(journal.gitDirQuarantine),
            ]);
            if (remainingPath.some(Boolean)) continue;
            await this.clearWorktreeRemovalJournal(
              journal.checkoutPath,
              journal.gitDir,
              ownershipToken,
              journal,
            );
            finalized += 1;
          } catch (error) {
            onError(error);
          }
        }
      } catch (error) {
        onError(error);
      }
    }
    return finalized;
  }

  async managedWorktreeDeletionPending(
    worktreePath: string,
    worktreeGitDir: string,
    ownershipToken: string,
  ): Promise<boolean> {
    const removal = this.managedWorktreeRemovalPaths(worktreePath, worktreeGitDir, ownershipToken);
    const journal = await this.readWorktreeRemovalJournal(removal.journal);
    if (!journal) return false;
    if (
      journal.checkoutPath !== worktreePath ||
      journal.checkoutAuthorization !== removal.checkoutAuthorization ||
      journal.checkoutQuarantine !== removal.checkout ||
      journal.gitDir !== worktreeGitDir ||
      journal.gitDirAuthorization !== removal.gitDirAuthorization ||
      journal.gitDirQuarantine !== removal.gitDir ||
      journal.ownershipToken !== ownershipToken
    ) {
      throw new GitServiceError(
        "command_failed",
        "The managed worktree deletion journal does not match this workspace.",
      );
    }
    return true;
  }
}

const gitService = new GitService();

export const gitInfo = (folderPath: string, signal?: AbortSignal) =>
  gitService.info(folderPath, signal);
export const gitBranches = (folderPath: string, signal?: AbortSignal) =>
  gitService.branches(folderPath, signal);
export const gitReview = (folderPath: string, signal?: AbortSignal) =>
  gitService.review(folderPath, signal);
export const gitDiff = (folderPath: string, input: GitDiffInput, signal?: AbortSignal) =>
  gitService.diff(folderPath, input, signal);
export const gitCommit = (folderPath: string, input: GitCommitInput, signal?: AbortSignal) =>
  gitService.commit(folderPath, input, signal);
export const gitPushCapability = (folderPath: string, signal?: AbortSignal) =>
  gitService.pushCapability(folderPath, signal);
export const gitPush = (folderPath: string, input: GitPushInput, signal?: AbortSignal) =>
  gitService.push(folderPath, input, signal);
export const gitCompare = (folderPath: string, targetRef: string, signal?: AbortSignal) =>
  gitService.compare(folderPath, targetRef, signal);
export const gitComparisonDiff = (
  folderPath: string,
  input: GitComparisonDiffInput,
  signal?: AbortSignal,
) => gitService.comparisonDiff(folderPath, input, signal);
export const gitCheckout = (folderPath: string, name: string, signal?: AbortSignal) =>
  gitService.checkout(folderPath, name, signal);
export const gitCreateBranch = (folderPath: string, name: string, signal?: AbortSignal) =>
  gitService.createBranch(folderPath, name, signal);
export const gitWorktrees = (folderPath: string, signal?: AbortSignal) =>
  gitService.worktrees(folderPath, signal);
export const gitManagedWorktreeRegistered = (
  folderPath: string,
  worktreePath: string,
  branch: string,
  worktreeGitDir?: string,
  ownershipToken?: string,
) =>
  gitService.managedWorktreeRegistered(
    folderPath,
    worktreePath,
    branch,
    worktreeGitDir,
    ownershipToken,
  );
export const gitManagedWorktreeUsable = (
  folderPath: string,
  worktreePath: string,
  branch: string,
  worktreeGitDir?: string,
  ownershipToken?: string,
  worktreeDevice?: number,
  worktreeInode?: number,
) =>
  gitService.managedWorktreeUsable(
    folderPath,
    worktreePath,
    branch,
    worktreeGitDir,
    ownershipToken,
    worktreeDevice,
    worktreeInode,
  );
export const gitFinalizeManagedWorktreeDeletion = (
  worktreePath: string,
  worktreeGitDir: string,
  ownershipToken: string,
) => gitService.finalizeManagedWorktreeDeletion(worktreePath, worktreeGitDir, ownershipToken);
export const gitFinalizeOrphanedManagedWorktreeDeletionJournals = (
  worktreeRoot: string,
  referencedOwnershipTokens?: ReadonlySet<string>,
  onError?: (error: unknown) => void,
) =>
  gitService.finalizeOrphanedManagedWorktreeDeletionJournals(
    worktreeRoot,
    referencedOwnershipTokens,
    onError,
  );
export const gitManagedWorktreeDeletionPending = (
  worktreePath: string,
  worktreeGitDir: string,
  ownershipToken: string,
) => gitService.managedWorktreeDeletionPending(worktreePath, worktreeGitDir, ownershipToken);
export const gitCreateWorktree = (
  folderPath: string,
  root: string,
  branch: string,
  signal?: AbortSignal,
) => gitService.createWorktree(folderPath, root, branch, signal);
export const gitRollbackWorktree = (folderPath: string, created: GitCreatedWorktree) =>
  gitService.rollbackWorktree(folderPath, created);
export const gitDeleteManagedWorktree = (
  folderPath: string,
  worktreePath: string,
  branch: string,
  createdFromHead: string,
  signal?: AbortSignal,
  worktreeGitDir?: string,
  ownershipToken?: string,
  worktreeDevice?: number,
  worktreeInode?: number,
) =>
  gitService.deleteManagedWorktree(
    folderPath,
    worktreePath,
    branch,
    createdFromHead,
    signal,
    worktreeGitDir,
    ownershipToken,
    worktreeDevice,
    worktreeInode,
    true,
  );
