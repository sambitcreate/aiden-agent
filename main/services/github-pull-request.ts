// GitHub pull request/check status reads for workspace repositories. The service
// intentionally shells out through GitHub CLI (`gh`) instead of embedding a
// token-bearing API client so Aiden reuses the user's existing GitHub setup on
// this Mac. Outputs and renderer-facing fields are bounded.

import { execFile, type ExecFileException } from "child_process";
import { constants as fsConstants } from "fs";
import { access } from "fs/promises";
import * as os from "os";
import { promisify } from "util";
import type {
  GitHubPullRequestCheck,
  GitHubPullRequestCheckStatus,
  GitHubPullRequestChecksState,
  GitHubPullRequestStatus,
  GitHubPullRequestSummary,
  GitHubPullRequestAvailability,
} from "./types.js";

export type {
  GitHubPullRequestCheck,
  GitHubPullRequestCheckStatus,
  GitHubPullRequestChecksState,
  GitHubPullRequestStatus,
  GitHubPullRequestSummary,
  GitHubPullRequestAvailability,
} from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_RENDERER_STRING_CHARS = 2_048;
const MAX_CHECKS = 100;
const CHECK_IDENTITY_SEPARATOR = "\u0000";
const GH_BINARY_CANDIDATES = [
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
  "/opt/local/bin/gh",
  "/usr/bin/gh",
] as const;
const GIT_ROUTING_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
] as const;

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CommandOptions {
  binary: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxBuffer: number;
}

export interface GitHubPullRequestServiceOptions {
  runner?: (cwd: string, args: string[], options: CommandOptions) => Promise<CommandResult>;
  resolveBinary?: () => Promise<string>;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

interface RawStatusCheckNode {
  name?: unknown;
  context?: unknown;
  state?: unknown;
  status?: unknown;
  conclusion?: unknown;
  description?: unknown;
  detailsUrl?: unknown;
  targetUrl?: unknown;
  workflowName?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
}

interface RawPullRequest {
  number?: unknown;
  title?: unknown;
  url?: unknown;
  state?: unknown;
  isDraft?: unknown;
  headRefName?: unknown;
  baseRefName?: unknown;
  statusCheckRollup?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength = MAX_RENDERER_STRING_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\p{Cc}+/gu, " ").trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : undefined;
}

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return search ? value.split(search).join(replacement) : value;
}

function safeHttpUrl(value: unknown): string | undefined {
  const candidate = boundedString(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) {
      return undefined;
    }
    return url.toString().slice(0, MAX_RENDERER_STRING_CHARS);
  } catch {
    return undefined;
  }
}

function redactAbsolutePaths(value: string): string {
  return value.replace(/(^|[\s"'`=(:])\/(?:[\w.-]+\/)+[\w.-]+/gu, "$1[path]");
}

function publicCommandMessage(error: unknown, cwd: string): string {
  const raw = error instanceof Error ? error.message : String(error || "GitHub CLI failed.");
  const withoutWorkspace = replaceAllLiteral(raw, cwd, "the workspace");
  const withoutHome = replaceAllLiteral(withoutWorkspace, os.homedir(), "~");
  return redactAbsolutePaths(withoutHome)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, "$1***@")
    .replace(/([?&](?:access_token|auth|key|password|private_token|signature|token)=)[^&\s]+/gi, "$1***")
    .replace(/\p{Cc}+/gu, " ")
    .trim()
    .slice(0, 600) || "GitHub CLI failed.";
}

function isAbortError(error: unknown): boolean {
  const err = error as { code?: unknown; name?: unknown } | undefined;
  return err?.code === "ABORT_ERR" || err?.name === "AbortError";
}

function commandFailureKind(error: unknown): Exclude<GitHubPullRequestAvailability, "ready" | "not-repo"> {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "missing-tool";
  const execError = error as ExecFileException | undefined;
  const combined = `${execError?.stdout ?? ""}\n${execError?.stderr ?? ""}\n${execError?.message ?? ""}`;
  if (/gh(?:.*?)not found|spawn .*gh ENOENT|ENOENT/u.test(combined)) return "missing-tool";
  if (/none of the git remotes|no git remotes|not a github repository|point to a known github host/iu.test(combined)) {
    return "not-github";
  }
  if (/auth login|not logged into|authentication required|HTTP 401|unauthorized|could not authenticate/iu.test(combined)) {
    return "unauthenticated";
  }
  if (/unknown flag: --json|unknown (?:json )?field|available fields/iu.test(combined)) return "unsupported";
  if (/no pull requests? found|no open pull requests? found|could not find any pull requests?/iu.test(combined)) {
    return "no-pull-request";
  }
  return "error";
}

function checkTimestamp(value: unknown): number {
  if (typeof value !== "string" || value === "0001-01-01T00:00:00Z") return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function normalizeGitHubCheckStatus(node: RawStatusCheckNode): GitHubPullRequestCheckStatus {
  const status = boundedString(node.status)?.toUpperCase();
  if (status && status !== "COMPLETED") return "pending";
  const value = boundedString(node.conclusion)?.toUpperCase() ?? boundedString(node.state)?.toUpperCase();
  switch (value) {
    case "SUCCESS":
      return "success";
    case "ACTION_REQUIRED":
      return "action-required";
    case "FAILURE":
    case "ERROR":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
      return "failure";
    case "CANCELLED":
      return "cancelled";
    case "SKIPPED":
      return "skipped";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "neutral";
  }
}

function rawCheckName(node: RawStatusCheckNode): string | undefined {
  return boundedString(node.name) ?? boundedString(node.context);
}

function rawCheckUrl(node: RawStatusCheckNode): string | undefined {
  return safeHttpUrl(node.detailsUrl) ?? safeHttpUrl(node.targetUrl);
}

function extractRawChecks(value: unknown): RawStatusCheckNode[] {
  const nodes = isRecord(value) && isRecord(value.contexts) && Array.isArray(value.contexts.nodes)
    ? value.contexts.nodes
    : isRecord(value) && Array.isArray(value.contexts)
      ? value.contexts
      : isRecord(value) && Array.isArray(value.nodes)
        ? value.nodes
        : Array.isArray(value)
          ? value
          : [];
  return nodes.filter(isRecord) as RawStatusCheckNode[];
}

function shouldReplaceCheck(
  previous: { check: GitHubPullRequestCheck; timestamp: number } | undefined,
  next: { check: GitHubPullRequestCheck; timestamp: number },
): boolean {
  if (!previous) return true;
  if (next.timestamp > previous.timestamp) return true;
  if (next.timestamp === previous.timestamp) return true;
  return next.timestamp === 0 && (next.check.status === "pending" || next.check.status === "action-required");
}

export function dedupeGitHubChecks(rawChecks: RawStatusCheckNode[]): GitHubPullRequestCheck[] {
  const entries = new Map<string, { check: GitHubPullRequestCheck; workflow?: string; timestamp: number }>();
  for (const raw of rawChecks) {
    const name = rawCheckName(raw);
    if (!name) continue;
    const workflow = boundedString(raw.workflowName);
    const key = `${workflow ?? ""}${CHECK_IDENTITY_SEPARATOR}${name}`;
    const timestamp = Math.max(checkTimestamp(raw.completedAt), checkTimestamp(raw.startedAt));
    const url = rawCheckUrl(raw);
    const description = boundedString(raw.description);
    const check: GitHubPullRequestCheck = {
      name,
      status: normalizeGitHubCheckStatus(raw),
      ...(description ? { description } : {}),
      ...(url ? { url } : {}),
    };
    const next = { check, workflow, timestamp };
    if (shouldReplaceCheck(entries.get(key), next)) entries.set(key, next);
  }

  const nameCounts = new Map<string, number>();
  for (const entry of entries.values()) {
    nameCounts.set(entry.check.name, (nameCounts.get(entry.check.name) ?? 0) + 1);
  }

  return [...entries.values()].map(({ check, workflow }) => ({
    ...check,
    name: workflow && (nameCounts.get(check.name) ?? 0) > 1 ? `${workflow} / ${check.name}` : check.name,
  }));
}

export function rollupGitHubChecksState(
  checks: readonly GitHubPullRequestCheck[],
): GitHubPullRequestChecksState | null {
  if (checks.some((check) => check.status === "failure")) return "failing";
  if (checks.some((check) => check.status === "pending" || check.status === "action-required")) {
    return "pending";
  }
  if (checks.some((check) => check.status === "success")) return "passing";
  return null;
}

export function parseGitHubPullRequest(rawJson: string): GitHubPullRequestSummary {
  const parsed = JSON.parse(rawJson) as unknown;
  if (!isRecord(parsed)) throw new Error("GitHub CLI returned an invalid pull request response.");
  const raw = parsed as RawPullRequest;
  const number = typeof raw.number === "number" && Number.isInteger(raw.number) ? raw.number : 0;
  const title = boundedString(raw.title);
  const url = safeHttpUrl(raw.url);
  const stateValue = boundedString(raw.state)?.toUpperCase();
  const headBranch = boundedString(raw.headRefName);
  const baseBranch = boundedString(raw.baseRefName);
  if (!number || !title || !url || !headBranch || !baseBranch) {
    throw new Error("GitHub CLI returned an incomplete pull request response.");
  }
  const state = stateValue === "MERGED" ? "merged" : stateValue === "CLOSED" ? "closed" : "open";
  const allChecks = dedupeGitHubChecks(extractRawChecks(raw.statusCheckRollup));
  return {
    number,
    title,
    url,
    state,
    ...(raw.isDraft === true ? { isDraft: true } : {}),
    headBranch,
    baseBranch,
    checks: allChecks.slice(0, MAX_CHECKS),
    checksState: rollupGitHubChecksState(allChecks),
  };
}

export function githubCliEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_ROUTING_ENV) delete env[key];
  delete env.GIT_CONFIG_COUNT;
  delete env.GIT_CONFIG_PARAMETERS;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" };
}

async function resolveGitHubCliBinary(): Promise<string> {
  for (const candidate of GH_BINARY_CANDIDATES) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next well-known macOS install location before falling back to PATH.
    }
  }
  return "gh";
}

async function defaultRunner(
  cwd: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const result = await execFileAsync(options.binary, args, {
    cwd,
    encoding: "utf8",
    env: githubCliEnvironment(),
    maxBuffer: options.maxBuffer,
    signal: options.signal,
    timeout: options.timeoutMs,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

export class GitHubPullRequestService {
  private readonly runner: NonNullable<GitHubPullRequestServiceOptions["runner"]>;
  private readonly resolveBinary: NonNullable<GitHubPullRequestServiceOptions["resolveBinary"]>;
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;

  constructor(options: GitHubPullRequestServiceOptions = {}) {
    this.runner = options.runner ?? defaultRunner;
    this.resolveBinary = options.resolveBinary ?? resolveGitHubCliBinary;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  }

  async currentPullRequest(cwd: string, signal?: AbortSignal): Promise<GitHubPullRequestStatus> {
    try {
      const result = await this.runner(
        cwd,
        [
          "pr",
          "view",
          "--json",
          "number,title,url,state,isDraft,headRefName,baseRefName,statusCheckRollup",
        ],
        {
          binary: await this.resolveBinary(),
          signal,
          timeoutMs: this.timeoutMs,
          maxBuffer: this.maxBufferBytes,
        },
      );
      return { availability: "ready", pullRequest: parseGitHubPullRequest(result.stdout) };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      const availability = commandFailureKind(error);
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      const fallbackMessages: Record<typeof availability, string> = {
        "missing-tool": "Install GitHub CLI, then run `gh auth login`.",
        "unauthenticated": "Run `gh auth login` on this Mac, then refresh source control.",
        "no-pull-request": "No GitHub pull request is linked to the current branch.",
        "not-github": "This repository's remote is not hosted on GitHub.",
        "unsupported": "Update GitHub CLI so Aiden can read pull request status.",
        "error":
          code === "ETIMEDOUT" ||
          code === "ERR_CHILD_PROCESS_TIMEOUT" ||
          (error as { killed?: unknown } | undefined)?.killed === true
            ? `GitHub CLI did not answer within ${Math.max(1, Math.round(this.timeoutMs / 1000))} seconds.`
            : error instanceof SyntaxError
              ? "GitHub CLI returned an invalid pull request response."
              : publicCommandMessage(error, cwd),
      };
      return { availability, message: fallbackMessages[availability] };
    }
  }
}

const githubPullRequestService = new GitHubPullRequestService();

export const githubCurrentPullRequest = (folderPath: string, signal?: AbortSignal) =>
  githubPullRequestService.currentPullRequest(folderPath, signal);
