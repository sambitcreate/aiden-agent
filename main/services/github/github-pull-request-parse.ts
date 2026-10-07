// Normalization of GitHub pull request payloads into the bounded summaries the
// renderer receives. Shared by every read path; nothing here does I/O.

import {
  canonicalGitHubPullRequestUrl,
  parseGitHubPullRequestUrl,
} from "../../../renderer/shared/chat-pull-requests.js";
import type {
  GitHubPullRequestCheck,
  GitHubPullRequestCheckStatus,
  GitHubPullRequestChecksState,
  GitHubPullRequestReviewDecision,
  GitHubPullRequestSummary,
} from "../types.js";

const MAX_RENDERER_STRING_CHARS = 2_048;
const MAX_CHECKS = 100;
const CHECK_IDENTITY_SEPARATOR = "\u0000";

export interface RawStatusCheckNode {
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

export interface RawPullRequest {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function boundedString(
  value: unknown,
  maxLength = MAX_RENDERER_STRING_CHARS,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\p{Cc}+/gu, " ").trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : undefined;
}

export function safeHttpUrl(value: unknown): string | undefined {
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

function checkTimestamp(value: unknown): number {
  if (typeof value !== "string" || value === "0001-01-01T00:00:00Z") return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function normalizeGitHubCheckStatus(
  node: RawStatusCheckNode,
): GitHubPullRequestCheckStatus {
  const status = boundedString(node.status)?.toUpperCase();
  if (status && status !== "COMPLETED") return "pending";
  const value =
    boundedString(node.conclusion)?.toUpperCase() ??
    boundedString(node.state)?.toUpperCase();
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
    isRecord(value) &&
    isRecord(value.contexts) &&
    Array.isArray(value.contexts.nodes)
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
  const isUnstartedPending = (entry: {
    check: GitHubPullRequestCheck;
    timestamp: number;
  }) =>
    entry.timestamp === 0 &&
    (entry.check.status === "pending" ||
      entry.check.status === "action-required");
  if (isUnstartedPending(next)) return true;
  if (isUnstartedPending(previous)) return false;
  return next.timestamp >= previous.timestamp;
}

export function dedupeGitHubChecks(
  rawChecks: RawStatusCheckNode[],
): GitHubPullRequestCheck[] {
  const entries = new Map<
    string,
    { check: GitHubPullRequestCheck; workflow?: string; timestamp: number }
  >();
  for (const raw of rawChecks) {
    const name = rawCheckName(raw);
    if (!name) continue;
    const workflow = boundedString(raw.workflowName);
    const key = `${workflow ?? ""}${CHECK_IDENTITY_SEPARATOR}${name}`;
    const timestamp = Math.max(
      checkTimestamp(raw.completedAt),
      checkTimestamp(raw.startedAt),
    );
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
    nameCounts.set(
      entry.check.name,
      (nameCounts.get(entry.check.name) ?? 0) + 1,
    );
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
  if (
    checks.some(
      (check) => check.status === "failure" || check.status === "cancelled",
    )
  )
    return "failing";
  if (
    checks.some(
      (check) =>
        check.status === "pending" || check.status === "action-required",
    )
  ) {
    return "pending";
  }
  if (checks.some((check) => check.status === "success")) return "passing";
  return null;
}

function normalizeReviewDecision(
  value: unknown,
): GitHubPullRequestReviewDecision | null {
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

export function parseRawPullRequest(parsed: unknown): GitHubPullRequestSummary {
  if (!isRecord(parsed))
    throw new Error("GitHub returned an invalid pull request response.");
  const raw = parsed as RawPullRequest;
  const number =
    typeof raw.number === "number" && Number.isInteger(raw.number)
      ? raw.number
      : 0;
  const title = boundedString(raw.title);
  const url = safeHttpUrl(raw.url);
  const stateValue = boundedString(raw.state)?.toUpperCase();
  const headBranch = boundedString(raw.headRefName);
  const baseBranch = boundedString(raw.baseRefName);
  if (!number || !title || !url || !headBranch || !baseBranch) {
    throw new Error("GitHub returned an incomplete pull request response.");
  }
  const state =
    stateValue === "MERGED"
      ? "merged"
      : stateValue === "CLOSED"
        ? "closed"
        : "open";
  const allChecks = dedupeGitHubChecks(extractRawChecks(raw.statusCheckRollup));
  const headSha = boundedString(raw.headRefOid, 64)?.toLowerCase();
  const author = isRecord(raw.author)
    ? boundedString(raw.author.login, 128)
    : undefined;
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

export function parseGitHubPullRequest(
  rawJson: string,
): GitHubPullRequestSummary {
  return parseRawPullRequest(JSON.parse(rawJson) as unknown);
}

export function parseGitHubPullRequestList(
  rawJson: string,
): GitHubPullRequestSummary[] {
  const parsed = JSON.parse(rawJson) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(
      "GitHub returned an invalid pull request list response.",
    );
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
):
  | { host: string; repository: string; number: number; url: string }
  | undefined {
  const ref = parseGitHubPullRequestUrl(summary.url);
  return ref && ref.number === summary.number
    ? { ...ref, url: canonicalGitHubPullRequestUrl(ref) }
    : undefined;
}
