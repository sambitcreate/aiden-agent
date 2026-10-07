// GitHub pull request/check status for workspace repositories. Reads go
// straight to GitHub's GraphQL API through the shared rate-limit gate, using
// the token `gh` (or GH_TOKEN) already holds on this Mac; the repository and
// head are worked out from local git configuration. Only `gh pr create` still
// shells out. Renderer-facing fields are bounded.

import { execFile, type ExecFileException } from "child_process";
import * as os from "os";
import { promisify } from "util";
import { redactUrlCredentials } from "../shared/redaction.js";
import {
  normalizeGitHubHost,
  parseGitHubPullRequestUrl,
} from "../../renderer/shared/chat-pull-requests.js";
import { githubCliEnvironment, resolveGitHubCliBinary } from "./github/github-credentials.js";
import type { LocalRepositoryResult } from "./github/github-local-repository.js";
import {
  BRANCH_LOOKUP_LIMIT,
  type PullRequestEntryReader,
  type PullRequestEntryResult,
  type PullRequestHeadSummary,
  type PullRequestListState,
  type PullRequestQueryEntry,
} from "./github/github-pull-request-graphql.js";
import { boundedString } from "./github/github-pull-request-parse.js";
import type {
  GitHubPullRequestAvailability,
  GitHubPullRequestCreateInput,
  GitHubPullRequestCreateResult,
  GitHubPullRequestListStatus,
  GitHubPullRequestStatus,
  GitHubPullRequestSummary,
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
export {
  dedupeGitHubChecks,
  normalizeGitHubCheckStatus,
  parseGitHubPullRequest,
  parseGitHubPullRequestList,
  pullRequestIdentityFromSummary,
  rollupGitHubChecksState,
} from "./github/github-pull-request-parse.js";
export { githubCliEnvironment } from "./github/github-credentials.js";

const execFileAsync = promisify(execFile);

const DEFAULT_CREATE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const RATE_LIMITED_MESSAGE = "GitHub's API rate limit was reached. Pull request status will refresh after it resets.";

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

export type GitHubCliRunner = (cwd: string, args: string[], options: CommandOptions) => Promise<CommandResult>;

export interface GitHubPullRequestReadOptions {
  /** A user-initiated read; may spend the GraphQL reserve kept for interactive work. */
  interactive?: boolean;
}

export interface GitHubPullRequestServiceOptions {
  reader: PullRequestEntryReader;
  repositories: { resolve(cwd: string, signal?: AbortSignal): Promise<LocalRepositoryResult> };
  /** `gh pr create` only. */
  runner?: GitHubCliRunner;
  resolveBinary?: () => Promise<string>;
  createTimeoutMs?: number;
  maxBufferBytes?: number;
}

interface RepositoryTarget {
  host: string;
  owner: string;
  name: string;
}

type Failure = { availability: Exclude<GitHubPullRequestAvailability, "ready">; message: string; retryAt?: number };

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return search ? value.split(search).join(replacement) : value;
}

function redactAbsolutePaths(value: string): string {
  return value.replace(/(^|[\s"'`=(:])\/(?:[\w.-]+\/)+[\w.-]+/gu, "$1[path]");
}

function publicCommandMessage(error: unknown, cwd: string): string {
  const raw = error instanceof Error ? error.message : String(error || "GitHub CLI failed.");
  const withoutWorkspace = replaceAllLiteral(raw, cwd, "the workspace");
  const withoutHome = replaceAllLiteral(withoutWorkspace, os.homedir(), "~");
  return (
    redactUrlCredentials(redactAbsolutePaths(withoutHome))
      .replace(/\p{Cc}+/gu, " ")
      .trim()
      .slice(0, 600) || "GitHub CLI failed."
  );
}

function isAbortError(error: unknown): boolean {
  const err = error as { code?: unknown; name?: unknown } | undefined;
  return err?.code === "ABORT_ERR" || err?.name === "AbortError";
}

function createFailureKind(error: unknown): "missing-tool" | "unauthenticated" | "other" {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "missing-tool";
  const execError = error as ExecFileException | undefined;
  const combined = `${execError?.stdout ?? ""}\n${execError?.stderr ?? ""}\n${execError?.message ?? ""}`;
  if (/spawn .*gh ENOENT/u.test(combined)) return "missing-tool";
  if (/auth login|not logged into|authentication required|HTTP 401|could not authenticate/iu.test(combined)) {
    return "unauthenticated";
  }
  return "other";
}

async function defaultRunner(cwd: string, args: string[], options: CommandOptions): Promise<CommandResult> {
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

/** `owner/repo` on github.com, or `host/owner/repo`. */
export function parseRepositorySelector(selector: string): RepositoryTarget | undefined {
  const parts = selector.trim().split("/");
  const [host, owner, name] =
    parts.length === 2 ? ["github.com", parts[0], parts[1]] : parts.length === 3 ? parts : [];
  const normalizedHost = normalizeGitHubHost(host);
  if (!normalizedHost || !owner || !name) return undefined;
  return { host: normalizedHost, owner: owner.toLowerCase(), name: name.replace(/\.git$/iu, "").toLowerCase() };
}

function failureFrom(result: Exclude<PullRequestEntryResult, { kind: "ok" }>, host: string): Failure {
  switch (result.kind) {
    case "rate-limited":
      return {
        availability: "rate-limited",
        message: RATE_LIMITED_MESSAGE,
        ...(result.retryAt !== undefined ? { retryAt: result.retryAt } : {}),
      };
    case "unauthorized":
      return {
        availability: "unauthenticated",
        message: `GitHub rejected the saved credential. Run \`gh auth login --hostname ${host}\` on this Mac, or update GH_TOKEN, then refresh.`,
      };
    case "unavailable":
      return { availability: result.reason, message: result.message };
    case "not-found":
    case "failed":
      return { availability: "error", message: result.message };
  }
}

function toSummary(pullRequest: PullRequestHeadSummary): GitHubPullRequestSummary {
  const { headOwner: _headOwner, ...summary } = pullRequest;
  return summary;
}

function stateFilter(state: "open" | "closed" | "merged" | "all"): PullRequestListState[] {
  switch (state) {
    case "open":
      return ["OPEN"];
    case "closed":
      return ["CLOSED"];
    case "merged":
      return ["MERGED"];
    case "all":
      return ["OPEN", "CLOSED", "MERGED"];
  }
}

export class GitHubPullRequestService {
  private readonly reader: PullRequestEntryReader;
  private readonly repositories: GitHubPullRequestServiceOptions["repositories"];
  private readonly runner: GitHubCliRunner;
  private readonly resolveBinary: () => Promise<string>;
  private readonly createTimeoutMs: number;
  private readonly maxBufferBytes: number;

  constructor(options: GitHubPullRequestServiceOptions) {
    this.reader = options.reader;
    this.repositories = options.repositories;
    this.runner = options.runner ?? defaultRunner;
    this.resolveBinary = options.resolveBinary ?? resolveGitHubCliBinary;
    this.createTimeoutMs = options.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS;
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  }

  private async local(cwd: string, signal?: AbortSignal) {
    const local = await this.repositories.resolve(cwd, signal);
    if (!local.ok) return { ok: false as const, failure: { availability: local.availability, message: local.message } };
    return { ok: true as const, repository: local.repository };
  }

  private async target(
    cwd: string,
    selector: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ ok: true; target: RepositoryTarget } | { ok: false; failure: Failure }> {
    if (selector) {
      const target = parseRepositorySelector(selector);
      return target
        ? { ok: true, target }
        : { ok: false, failure: { availability: "error", message: "The GitHub repository is invalid." } };
    }
    const local = await this.local(cwd, signal);
    if (!local.ok) return local;
    const { host, owner, name } = local.repository;
    return { ok: true, target: { host, owner, name } };
  }

  private read(
    target: RepositoryTarget,
    entry: PullRequestQueryEntry,
    operation: string,
    signal: AbortSignal | undefined,
    options: GitHubPullRequestReadOptions & { version?: string; fresh?: boolean },
  ): Promise<PullRequestEntryResult> {
    return this.reader.read(target.host, entry, {
      operation,
      signal,
      ...(options.interactive ? { interactive: true } : {}),
      ...(options.version ? { version: options.version } : {}),
      ...(options.fresh ? { fresh: true } : {}),
    });
  }

  /** The pull request for the workspace's checked-out branch, as `gh pr view` finds it. */
  async currentPullRequest(
    cwd: string,
    signal?: AbortSignal,
    options: GitHubPullRequestReadOptions = {},
  ): Promise<GitHubPullRequestStatus> {
    const local = await this.local(cwd, signal);
    if (!local.ok) return local.failure;
    const repository = local.repository;
    if (!repository.headBranch) {
      return { availability: "no-pull-request", message: "Check out a branch to see its GitHub pull request." };
    }
    const result = await this.read(
      repository,
      { kind: "head", owner: repository.owner, name: repository.name, headBranch: repository.headBranch },
      "pr.current",
      signal,
      { ...options, ...(repository.headSha ? { version: repository.headSha } : {}) },
    );
    if (result.kind !== "ok") return failureFrom(result, repository.host);
    const fromHead = result.pullRequests.filter(
      (pullRequest) => !repository.headOwner || !pullRequest.headOwner || pullRequest.headOwner === repository.headOwner,
    );
    const chosen = fromHead.find((pullRequest) => pullRequest.state === "open") ?? fromHead[0];
    if (!chosen) {
      return { availability: "no-pull-request", message: "No GitHub pull request is linked to the current branch." };
    }
    return { availability: "ready", pullRequest: toSummary(chosen) };
  }

  /**
   * The GitHub repository a workspace's remote (or an explicit
   * `host/owner/repo` selector) points at, with GitHub's canonical name.
   */
  async resolveRepository(
    cwd: string,
    signal?: AbortSignal,
    repository?: string,
    options: GitHubPullRequestReadOptions = {},
  ): Promise<GitHubRepositoryStatus> {
    const resolved = await this.target(cwd, repository, signal);
    if (!resolved.ok) return resolved.failure;
    const { target } = resolved;
    const result = await this.read(target, { kind: "repository", owner: target.owner, name: target.name }, "repo.resolve", signal, options);
    if (result.kind === "ok") return { availability: "ready", repository: result.repository };
    if (result.kind === "not-found") {
      return { availability: "error", message: `GitHub could not find ${target.owner}/${target.name}.` };
    }
    return failureFrom(result, target.host);
  }

  /**
   * Read one pull request by number. `repoSelector` is `owner/repo` on
   * github.com, `host/owner/repo` elsewhere.
   */
  async getPullRequest(
    cwd: string,
    repoSelector: string,
    number: number,
    signal?: AbortSignal,
    options: GitHubPullRequestReadOptions = {},
  ): Promise<GitHubPullRequestStatus> {
    const resolved = await this.target(cwd, repoSelector, signal);
    if (!resolved.ok) return resolved.failure;
    return this.readNumber(resolved.target, number, signal, options);
  }

  private async readNumber(
    target: RepositoryTarget,
    number: number,
    signal: AbortSignal | undefined,
    options: GitHubPullRequestReadOptions,
  ): Promise<GitHubPullRequestStatus> {
    const result = await this.read(target, { kind: "number", owner: target.owner, name: target.name, number }, "pr.read", signal, options);
    if (result.kind !== "ok") {
      if (result.kind === "not-found") {
        return { availability: "error", message: `GitHub could not find pull request #${number} in ${target.owner}/${target.name}.` };
      }
      return failureFrom(result, target.host);
    }
    const pullRequest = result.pullRequests[0];
    return pullRequest
      ? { availability: "ready", pullRequest: toSummary(pullRequest) }
      : { availability: "error", message: "GitHub returned an empty pull request response." };
  }

  /**
   * Read one pull request from its GitHub URL. Identity comes from the URL
   * GitHub reports back in the summary, never from the pasted input.
   */
  async getPullRequestByUrl(
    _cwd: string,
    url: string,
    signal?: AbortSignal,
    options: GitHubPullRequestReadOptions = {},
  ): Promise<GitHubPullRequestStatus> {
    const ref = parseGitHubPullRequestUrl(url);
    const target = ref ? parseRepositorySelector(`${ref.host}/${ref.repository}`) : undefined;
    if (!ref || !target) return { availability: "error", message: "That is not a GitHub pull request URL." };
    return this.readNumber(target, ref.number, signal, options);
  }

  /**
   * Pull requests whose head branch matches exactly, including closed and
   * merged ones so callers can tell "no PR" from "closed PR". Always read
   * fresh: post-push detection and create reconciliation must see a PR that
   * was opened moments ago.
   */
  async findForBranch(
    cwd: string,
    branch: string,
    signal?: AbortSignal,
    repository?: string,
    options: GitHubPullRequestReadOptions = {},
  ): Promise<GitHubPullRequestListStatus> {
    const resolved = await this.target(cwd, repository, signal);
    if (!resolved.ok) return resolved.failure;
    const { target } = resolved;
    const result = await this.read(
      target,
      { kind: "head", owner: target.owner, name: target.name, headBranch: branch },
      "pr.branch",
      signal,
      { ...options, fresh: true },
    );
    if (result.kind !== "ok") return failureFrom(result, target.host);
    if (result.pullRequests.length >= BRANCH_LOOKUP_LIMIT) {
      return {
        availability: "error",
        message: "The branch lookup reached its result limit. Check GitHub before retrying creation.",
      };
    }
    return { availability: "ready", pullRequests: result.pullRequests.map(toSummary) };
  }

  /** List repository pull requests for the link chooser. Defaults to open. */
  async listPullRequests(
    cwd: string,
    options: {
      state?: "open" | "closed" | "merged" | "all";
      limit?: number;
      headBranch?: string;
      interactive?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestListStatus> {
    const resolved = await this.target(cwd, undefined, signal);
    if (!resolved.ok) return resolved.failure;
    const { target } = resolved;
    const states = stateFilter(options.state ?? "open");
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 50);
    const entry: PullRequestQueryEntry = options.headBranch
      ? { kind: "head", owner: target.owner, name: target.name, headBranch: options.headBranch }
      : { kind: "list", owner: target.owner, name: target.name, states, first: limit };
    const result = await this.read(target, entry, "pr.list", signal, options);
    if (result.kind !== "ok") return failureFrom(result, target.host);
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    return {
      availability: "ready",
      pullRequests: result.pullRequests
        .filter((pullRequest) => wanted.has(pullRequest.state))
        .slice(0, limit)
        .map(toSummary),
    };
  }

  /**
   * Create a pull request via `gh pr create`, then read the canonical summary
   * back from the URL it prints so stored links never carry local identity.
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
    if (input.repository) args.push("-R", input.repository);
    try {
      const result = await this.runner(cwd, args, {
        binary: await this.resolveBinary(),
        signal,
        timeoutMs: this.createTimeoutMs,
        maxBuffer: this.maxBufferBytes,
      });
      const createdUrl = boundedString(result.stdout)
        ?.split(/\s+/u)
        .find((token) => parseGitHubPullRequestUrl(token) !== undefined);
      if (!createdUrl) {
        return { kind: "unknown", message: "GitHub CLI finished without reporting the new pull request URL." };
      }
      const resolved = await this.getPullRequestByUrl(cwd, createdUrl, signal, { interactive: true });
      if (resolved.availability === "ready" && resolved.pullRequest) {
        return { kind: "created", pullRequest: resolved.pullRequest };
      }
      return {
        kind: "unknown",
        message: resolved.message ?? "GitHub created the pull request but its details could not be read back.",
      };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      // Deterministic pre-request failures cannot have created anything: the
      // CLI never talked to GitHub (missing binary/auth). Everything else —
      // timeouts, kills, network flakes, ambiguous exit codes — is unknown and
      // must be reconciled.
      const kind = createFailureKind(error);
      if (kind === "missing-tool") {
        return { kind: "failed", availability: kind, message: "Install GitHub CLI, then run `gh auth login`." };
      }
      if (kind === "unauthenticated") {
        return { kind: "failed", availability: kind, message: "Run `gh auth login` on this Mac, then try again." };
      }
      const timedOut = (error as { killed?: unknown } | undefined)?.killed === true;
      return {
        kind: "unknown",
        message: timedOut
          ? `GitHub CLI did not answer within ${Math.max(1, Math.round(this.createTimeoutMs / 1000))} seconds.`
          : publicCommandMessage(error, cwd),
      };
    }
  }
}
