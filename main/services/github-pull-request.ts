// GitHub pull request/check status reads for workspace repositories. The service
// intentionally shells out through GitHub CLI (`gh`) instead of embedding a
// token-bearing API client so Aiden reuses the user's existing GitHub setup on
// this Mac. Outputs and renderer-facing fields are bounded.

import { execFile, type ExecFileException } from "child_process";
import { constants as fsConstants } from "fs";
import { access } from "fs/promises";
import * as os from "os";
import { promisify } from "util";
import {
  normalizeGitHubHost,
  normalizeGitHubRepositoryIdentity,
  parseGitHubPullRequestUrl,
} from "../../renderer/shared/chat-pull-requests.js";
import type {
  GitHubPullRequestCheck,
  GitHubPullRequestCheckStatus,
  GitHubPullRequestChecksState,
  GitHubPullRequestCreateInput,
  GitHubPullRequestCreateResult,
  GitHubPullRequestListStatus,
  GitHubPullRequestReviewDecision,
  GitHubPullRequestStatus,
  GitHubPullRequestSummary,
  GitHubPullRequestAvailability,
  GitHubRepositoryStatus,
} from "./types.js";

export type {
  GitHubPullRequestCheck,
  GitHubPullRequestCheckStatus,
  GitHubPullRequestChecksState,
  GitHubPullRequestCreateInput,
  GitHubPullRequestCreateResult,
  GitHubPullRequestListStatus,
  GitHubPullRequestStatus,
  GitHubPullRequestSummary,
  GitHubPullRequestAvailability,
  GitHubRepositoryStatus,
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
  headRefOid?: unknown;
  author?: unknown;
  reviewDecision?: unknown;
  mergeable?: unknown;
  updatedAt?: unknown;
  statusCheckRollup?: unknown;
}

const PR_JSON_FIELDS = [
  "number",
  "title",
  "url",
  "state",
  "isDraft",
  "headRefName",
  "baseRefName",
  "headRefOid",
  "author",
  "reviewDecision",
  "mergeable",
  "updatedAt",
  "statusCheckRollup",
].join(",");

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
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
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
  return (
    redactAbsolutePaths(withoutHome)
      .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, "$1***@")
      .replace(
        /([?&](?:access_token|auth|key|password|private_token|signature|token)=)[^&\s]+/gi,
        "$1***",
      )
      .replace(/\p{Cc}+/gu, " ")
      .trim()
      .slice(0, 600) || "GitHub CLI failed."
  );
}

function isAbortError(error: unknown): boolean {
  const err = error as { code?: unknown; name?: unknown } | undefined;
  return err?.code === "ABORT_ERR" || err?.name === "AbortError";
}

function commandFailureKind(
  error: unknown,
): Exclude<GitHubPullRequestAvailability, "ready" | "not-repo"> {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "missing-tool";
  const execError = error as ExecFileException | undefined;
  const combined = `${execError?.stdout ?? ""}\n${execError?.stderr ?? ""}\n${execError?.message ?? ""}`;
  if (/gh(?:.*?)not found|spawn .*gh ENOENT|ENOENT/u.test(combined)) return "missing-tool";
  if (
    /none of the git remotes|no git remotes|not a github repository|point to a known github host/iu.test(
      combined,
    )
  ) {
    return "not-github";
  }
  if (
    /auth login|not logged into|authentication required|HTTP 401|unauthorized|could not authenticate/iu.test(
      combined,
    )
  ) {
    return "unauthenticated";
  }
  if (/unknown flag: --json|unknown (?:json )?field|available fields/iu.test(combined))
    return "unsupported";
  if (
    /no pull requests? found|no open pull requests? found|could not find any pull requests?/iu.test(
      combined,
    )
  ) {
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
  const value =
    boundedString(node.conclusion)?.toUpperCase() ?? boundedString(node.state)?.toUpperCase();
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
  const nodes =
    isRecord(value) && isRecord(value.contexts) && Array.isArray(value.contexts.nodes)
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
  const isUnstartedPending = (entry: { check: GitHubPullRequestCheck; timestamp: number }) =>
    entry.timestamp === 0 &&
    (entry.check.status === "pending" || entry.check.status === "action-required");
  if (isUnstartedPending(next)) return true;
  if (isUnstartedPending(previous)) return false;
  return next.timestamp >= previous.timestamp;
}

export function dedupeGitHubChecks(rawChecks: RawStatusCheckNode[]): GitHubPullRequestCheck[] {
  const entries = new Map<
    string,
    { check: GitHubPullRequestCheck; workflow?: string; timestamp: number }
  >();
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
    name:
      workflow && (nameCounts.get(check.name) ?? 0) > 1
        ? `${workflow} / ${check.name}`
        : check.name,
  }));
}

export function rollupGitHubChecksState(
  checks: readonly GitHubPullRequestCheck[],
): GitHubPullRequestChecksState | null {
  if (checks.some((check) => check.status === "failure" || check.status === "cancelled"))
    return "failing";
  if (checks.some((check) => check.status === "pending" || check.status === "action-required")) {
    return "pending";
  }
  if (checks.some((check) => check.status === "success")) return "passing";
  return null;
}

function normalizeReviewDecision(value: unknown): GitHubPullRequestReviewDecision | null {
  switch (boundedString(value)?.toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "REVIEW_REQUIRED":
      return "review-required";
    default:
      return null;
  }
}

function normalizeMergeable(value: unknown): boolean | null {
  switch (boundedString(value)?.toUpperCase()) {
    case "MERGEABLE":
      return true;
    case "CONFLICTING":
      return false;
    default:
      return null;
  }
}

function parseRawPullRequest(parsed: unknown): GitHubPullRequestSummary {
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
  const headSha = boundedString(raw.headRefOid, 64)?.toLowerCase();
  const author = isRecord(raw.author) ? boundedString(raw.author.login, 128) : undefined;
  const updatedAt = checkTimestamp(raw.updatedAt);
  return {
    number,
    title,
    url,
    state,
    ...(raw.isDraft === true ? { isDraft: true } : {}),
    headBranch,
    baseBranch,
    ...(headSha ? { headSha } : {}),
    ...(author ? { author } : {}),
    reviewDecision: normalizeReviewDecision(raw.reviewDecision),
    mergeable: normalizeMergeable(raw.mergeable),
    ...(updatedAt > 0 ? { updatedAt } : {}),
    checks: allChecks.slice(0, MAX_CHECKS),
    checksState: rollupGitHubChecksState(allChecks),
  };
}

export function parseGitHubPullRequest(rawJson: string): GitHubPullRequestSummary {
  return parseRawPullRequest(JSON.parse(rawJson) as unknown);
}

export function parseGitHubPullRequestList(rawJson: string): GitHubPullRequestSummary[] {
  const parsed = JSON.parse(rawJson) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("GitHub CLI returned an invalid pull request list response.");
  }
  return parsed.map((entry) => parseRawPullRequest(entry));
}

/**
 * Derive the canonical (host, repository, number) identity from a `gh`
 * pull request payload. `gh` echoes the PR's canonical URL; parsing it is
 * the one place we trust for the remote identity — never the pasted URL or
 * the local git remote, which may use a redirect/rename.
 */
export function pullRequestIdentityFromSummary(
  summary: GitHubPullRequestSummary,
): { host: string; repository: string; number: number; url: string } | undefined {
  const ref = parseGitHubPullRequestUrl(summary.url);
  return ref ? { ...ref, url: summary.url } : undefined;
}

export function githubCliEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_ROUTING_ENV) delete env[key];
  delete env.GIT_CONFIG_COUNT;
  delete env.GIT_CONFIG_PARAMETERS;
  delete env.GH_HOST;
  delete env.GH_REPO;
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

  private async run(cwd: string, args: string[], signal?: AbortSignal): Promise<CommandResult> {
    return this.runner(cwd, args, {
      binary: await this.resolveBinary(),
      signal,
      timeoutMs: this.timeoutMs,
      maxBuffer: this.maxBufferBytes,
    });
  }

  private fallbackMessage(
    availability: Exclude<GitHubPullRequestAvailability, "ready" | "not-repo">,
    error: unknown,
    cwd: string,
  ): string {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const messages: Record<typeof availability, string> = {
      "missing-tool": "Install GitHub CLI, then run `gh auth login`.",
      unauthenticated: "Run `gh auth login` on this Mac, then refresh source control.",
      "no-pull-request": "No GitHub pull request is linked to the current branch.",
      "not-github": "This repository's remote is not hosted on GitHub.",
      unsupported: "Update GitHub CLI so Aiden can read pull request status.",
      error:
        code === "ETIMEDOUT" ||
        code === "ERR_CHILD_PROCESS_TIMEOUT" ||
        (error as { killed?: unknown } | undefined)?.killed === true
          ? `GitHub CLI did not answer within ${Math.max(1, Math.round(this.timeoutMs / 1000))} seconds.`
          : error instanceof SyntaxError
            ? "GitHub CLI returned an invalid pull request response."
            : publicCommandMessage(error, cwd),
    };
    return messages[availability];
  }

  async currentPullRequest(cwd: string, signal?: AbortSignal): Promise<GitHubPullRequestStatus> {
    try {
      const result = await this.run(cwd, ["pr", "view", "--json", PR_JSON_FIELDS], signal);
      return { availability: "ready", pullRequest: parseGitHubPullRequest(result.stdout) };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      const availability = commandFailureKind(error);
      return { availability, message: this.fallbackMessage(availability, error, cwd) };
    }
  }

  /**
   * Resolve the GitHub repository the workspace's remote points at. Works for
   * github.com and GHES hosts; returns "not-github"/"missing-tool" etc. for
   * non-GitHub remotes or unavailable CLI setups.
   */
  async resolveRepository(cwd: string, signal?: AbortSignal): Promise<GitHubRepositoryStatus> {
    try {
      const result = await this.run(cwd, ["repo", "view", "--json", "nameWithOwner,url"], signal);
      const parsed = JSON.parse(result.stdout) as unknown;
      if (!isRecord(parsed)) throw new Error("GitHub CLI returned an invalid repository response.");
      const nameWithOwner = normalizeGitHubRepositoryIdentity(parsed.nameWithOwner);
      if (!nameWithOwner) {
        throw new Error("GitHub CLI returned an invalid repository response.");
      }
      let host: string | undefined;
      const url = boundedString(parsed.url);
      if (url) {
        try {
          host = normalizeGitHubHost(new URL(url).hostname);
        } catch {
          host = undefined;
        }
      }
      return {
        availability: "ready",
        repository: { host: host ?? "github.com", nameWithOwner },
      };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      const availability = commandFailureKind(error);
      return { availability, message: this.fallbackMessage(availability, error, cwd) };
    }
  }

  /**
   * Read one pull request by number in an explicit repository. `repoSelector`
   * is the gh `-R` value: `owner/repo` on github.com, `HOST/owner/repo` on GHES.
   */
  async getPullRequest(
    cwd: string,
    repoSelector: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestStatus> {
    try {
      const result = await this.run(
        cwd,
        ["pr", "view", String(number), "-R", repoSelector, "--json", PR_JSON_FIELDS],
        signal,
      );
      return { availability: "ready", pullRequest: parseGitHubPullRequest(result.stdout) };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      const availability = commandFailureKind(error);
      return { availability, message: this.fallbackMessage(availability, error, cwd) };
    }
  }

  /**
   * Read one pull request from its GitHub URL. `gh` resolves repository and
   * host from the URL itself; the canonical (host, repository, number) is then
   * taken from the URL `gh` reports back — the caller must not trust the pasted
   * input for identity.
   */
  async getPullRequestByUrl(
    cwd: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestStatus> {
    try {
      const result = await this.run(cwd, ["pr", "view", url, "--json", PR_JSON_FIELDS], signal);
      return { availability: "ready", pullRequest: parseGitHubPullRequest(result.stdout) };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      const availability = commandFailureKind(error);
      return { availability, message: this.fallbackMessage(availability, error, cwd) };
    }
  }

  /**
   * Find pull requests on the repository whose head branch matches exactly —
   * the lookup reconciliation and post-push detection both use. Includes closed
   * and merged PRs so callers can distinguish "no PR" from "closed PR".
   */
  async findForBranch(
    cwd: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestListStatus> {
    try {
      const result = await this.run(
        cwd,
        [
          "pr",
          "list",
          "--head",
          branch,
          "--state",
          "all",
          "--limit",
          "30",
          "--json",
          PR_JSON_FIELDS,
        ],
        signal,
      );
      return { availability: "ready", pullRequests: parseGitHubPullRequestList(result.stdout) };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      const availability = commandFailureKind(error);
      return { availability, message: this.fallbackMessage(availability, error, cwd) };
    }
  }

  /** List repository pull requests for the link chooser. Defaults to open. */
  async listPullRequests(
    cwd: string,
    options: { state?: "open" | "closed" | "merged" | "all"; limit?: number; headBranch?: string },
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestListStatus> {
    const args = [
      "pr",
      "list",
      "--state",
      options.state ?? "open",
      "--limit",
      String(Math.min(Math.max(options.limit ?? 30, 1), 50)),
    ];
    if (options.headBranch) args.push("--head", options.headBranch);
    args.push("--json", PR_JSON_FIELDS);
    try {
      const result = await this.run(cwd, args, signal);
      return { availability: "ready", pullRequests: parseGitHubPullRequestList(result.stdout) };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      const availability = commandFailureKind(error);
      return { availability, message: this.fallbackMessage(availability, error, cwd) };
    }
  }

  /**
   * Create a pull request via `gh pr create`. The CLI prints the new PR URL on
   * success; we then resolve the canonical summary through `getPullRequestByUrl`
   * so stored links never carry identity taken from local state.
   *
   * Outcome triage matters: a timeout, kill, or network error can mean GitHub
   * created the PR anyway. Those return "unknown" — the caller must reconcile
   * via `findForBranch` before retrying or reporting failure.
   */
  async createPullRequest(
    cwd: string,
    input: GitHubPullRequestCreateInput,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestCreateResult> {
    const args = ["pr", "create", "--title", input.title];
    args.push("--body", input.body ?? "");
    if (input.baseBranch) args.push("--base", input.baseBranch);
    if (input.headBranch) args.push("--head", input.headBranch);
    if (input.draft) args.push("--draft");
    try {
      const result = await this.run(cwd, args, signal);
      const createdUrl = boundedString(result.stdout)
        ?.split(/\s+/u)
        .find((token) => parseGitHubPullRequestUrl(token) !== undefined);
      if (!createdUrl) {
        return {
          kind: "unknown",
          message: "GitHub CLI finished without reporting the new pull request URL.",
        };
      }
      const resolved = await this.getPullRequestByUrl(cwd, createdUrl, signal);
      if (resolved.availability === "ready" && resolved.pullRequest) {
        return { kind: "created", pullRequest: resolved.pullRequest };
      }
      return {
        kind: "unknown",
        message:
          resolved.message ??
          "GitHub created the pull request but its details could not be read back.",
      };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      const availability = commandFailureKind(error);
      // Deterministic pre-request failures cannot have created anything: the
      // CLI never talked to GitHub (missing binary/auth) or GitHub rejected
      // the inputs before mutation. Everything else — timeouts, kills, network
      // flakes, ambiguous exit codes — is unknown and must be reconciled.
      if (availability === "missing-tool" || availability === "unauthenticated") {
        return {
          kind: "failed",
          availability,
          message: this.fallbackMessage(availability, error, cwd),
        };
      }
      return { kind: "unknown", message: this.fallbackMessage(availability, error, cwd) };
    }
  }
}

const githubPullRequestService = new GitHubPullRequestService();

export const githubCurrentPullRequest = (folderPath: string, signal?: AbortSignal) =>
  githubPullRequestService.currentPullRequest(folderPath, signal);

export const githubPullRequests = githubPullRequestService;
