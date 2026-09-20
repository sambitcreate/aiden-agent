// Chat ↔ pull request relationship contract shared between the Electron main
// process and the renderer. A pull request is an external development resource
// linked to a chat; the link is never the identity of a chat, workspace,
// branch, or worktree.

export const CHAT_PULL_REQUEST_SCHEMA_VERSION = 1;
export const MAX_CHAT_PULL_REQUEST_LINKS = 64;
export const MAX_CHAT_PULL_REQUEST_STRING_CHARS = 2_048;
export const MAX_CHAT_PULL_REQUEST_BRANCH_CHARS = 256;
export const MAX_CHAT_PULL_REQUEST_TITLE_CHARS = 512;
export const MAX_CHAT_PULL_REQUEST_HOST_CHARS = 253;
export const MAX_CHAT_PULL_REQUEST_REPOSITORY_CHARS = 200;

export type ChatPullRequestSource = "created" | "manual" | "branch-discovered";
export type ChatPullRequestState = "open" | "closed" | "merged";
export type ChatPullRequestChecksState = "passing" | "failing" | "pending";
export type ChatPullRequestReviewDecision = "approved" | "changes-requested" | "review-required";

/** Canonical identity of a linked pull request: (host, repository, number). */
export interface ChatPullRequestRef {
  /** Lowercase GitHub host, e.g. `github.com` or a GHES hostname. */
  host: string;
  /** Normalized `owner/repo`, lowercase, without a `.git` suffix. */
  repository: string;
  number: number;
}

/** Cached display state. GitHub remains authoritative; tolerate staleness. */
export interface ChatPullRequestSnapshot {
  title: string;
  state: ChatPullRequestState;
  isDraft?: boolean;
  headBranch: string;
  baseBranch: string;
  headSha?: string;
  author?: string;
  reviewDecision?: ChatPullRequestReviewDecision | null;
  mergeable?: boolean | null;
  checksState?: ChatPullRequestChecksState | null;
  syncedAt: number;
}

/** Durable chat ↔ pull request relationship record. Never carries credentials. */
export interface ChatPullRequestLink extends ChatPullRequestRef {
  url: string;
  source: ChatPullRequestSource;
  linkedAt: number;
  snapshot?: ChatPullRequestSnapshot;
}

/**
 * Renderer-facing view of a pull request attached to a chat — either a durable
 * link or a workspace-branch discovery that has not been linked yet.
 */
export interface ChatPullRequestView extends ChatPullRequestRef {
  url: string;
  linked: boolean;
  source?: ChatPullRequestSource;
  linkedAt?: number;
  title?: string;
  state?: ChatPullRequestState;
  isDraft?: boolean;
  headBranch?: string;
  baseBranch?: string;
  headSha?: string;
  author?: string;
  reviewDecision?: ChatPullRequestReviewDecision | null;
  mergeable?: boolean | null;
  checksState?: ChatPullRequestChecksState | null;
  syncedAt?: number;
}

export type ChatPullRequestCurrentReason =
  | "workspace-branch"
  | "created"
  | "recent-open"
  | "recent-linked"
  | "discovered"
  | "none";

export interface ChatPullRequestCurrent {
  pullRequest: ChatPullRequestView | null;
  reason: ChatPullRequestCurrentReason;
  /** Set when repository/discovery reads were unavailable. */
  message?: string;
}

/**
 * Persisted intent for `gh pr create` while its remote outcome is unknown.
 * No `number` — the PR's number does not exist until GitHub creates it.
 */
export interface ChatPullRequestCreateIntent {
  operationId: string;
  host: string;
  repository: string;
  headBranch: string;
  baseBranch: string;
  expectedHeadSha?: string;
  title: string;
  requestedAt: number;
}

export interface ChatPullRequestCreateCandidate {
  ref: ChatPullRequestRef;
  url: string;
  title: string;
  state: ChatPullRequestState;
  headSha?: string;
}

export interface ChatPullRequestPendingCreate {
  intent: ChatPullRequestCreateIntent;
  /** Present when reconciliation found more than one matching pull request. */
  candidates?: ChatPullRequestCreateCandidate[];
}

/** Mirrors GitHubPullRequestAvailability — kept local so the renderer never imports main/ types. */
export type ChatPullRequestAvailability =
  | "ready"
  | "not-repo"
  | "missing-tool"
  | "unauthenticated"
  | "no-pull-request"
  | "not-github"
  | "unsupported"
  | "error";

export interface ChatPullRequestListResult {
  links: ChatPullRequestView[];
}

export interface ChatPullRequestCandidatesResult {
  availability: ChatPullRequestAvailability;
  message?: string;
  pullRequests: ChatPullRequestView[];
}

export type ChatPullRequestLinkResult =
  | { ok: true; pullRequest: ChatPullRequestView }
  | { ok: false; message: string };

export type ChatPullRequestCreateResult =
  | { kind: "created"; pullRequest: ChatPullRequestView }
  | { kind: "failed"; message: string }
  | { kind: "pending"; message: string }
  | { kind: "ambiguous"; candidates: ChatPullRequestCreateCandidate[] };

export interface ChatPullRequestDetectResult {
  availability: ChatPullRequestAvailability;
  message?: string;
  matches: ChatPullRequestView[];
  refreshed: ChatPullRequestView[];
}

const GITHUB_OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/u;
const GITHUB_REPO_PATTERN = /^[a-z0-9._-]{1,100}$/u;
const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const BRANCH_PATTERN = /^[^\s~^:?*[\]\\]{1,256}$/u;
const SHA_PATTERN = /^[0-9a-f]{4,64}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\p{Cc}+/gu, " ").trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : undefined;
}

/** Lowercase and normalize a GitHub `owner/repo` identity, dropping `.git`. */
export function normalizeGitHubRepositoryIdentity(value: unknown): string | undefined {
  const text = boundedText(value, MAX_CHAT_PULL_REQUEST_REPOSITORY_CHARS);
  if (!text) return undefined;
  const lowered = text
    .toLowerCase()
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "");
  const slash = lowered.indexOf("/");
  if (slash <= 0 || slash !== lowered.lastIndexOf("/")) return undefined;
  const owner = lowered.slice(0, slash);
  const repo = lowered.slice(slash + 1);
  if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(repo)) return undefined;
  return `${owner}/${repo}`;
}

export function normalizeGitHubHost(value: unknown): string | undefined {
  const text = boundedText(value, MAX_CHAT_PULL_REQUEST_HOST_CHARS);
  if (!text) return undefined;
  const lowered = text.toLowerCase();
  return HOSTNAME_PATTERN.test(lowered) ? lowered : undefined;
}

export function normalizeGitHubPullRequestNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function normalizeBranch(value: unknown): string | undefined {
  const text = boundedText(value, MAX_CHAT_PULL_REQUEST_BRANCH_CHARS);
  return text && BRANCH_PATTERN.test(text) ? text : undefined;
}

function normalizeSha(value: unknown): string | undefined {
  const text = boundedText(value, 64);
  return text && SHA_PATTERN.test(text) ? text.toLowerCase() : undefined;
}

/**
 * Validate and canonicalize a pull request URL to `https://host/owner/repo/pull/N`.
 * Only http(s) URLs without credentials are accepted; the returned repository
 * identity is normalized (lowercase, no `.git`).
 */
export function parseGitHubPullRequestUrl(value: unknown): ChatPullRequestRef | undefined {
  const text = boundedText(value, MAX_CHAT_PULL_REQUEST_STRING_CHARS);
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    return undefined;
  }
  const host = normalizeGitHubHost(url.hostname);
  if (!host) return undefined;
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 4) return undefined;
  const [owner, repo, marker, rawNumber] = segments;
  if (marker !== "pull" && marker !== "pulls") return undefined;
  if (!/^\d{1,9}$/u.test(rawNumber)) return undefined;
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || number <= 0) return undefined;
  const repository = normalizeGitHubRepositoryIdentity(`${owner}/${repo}`);
  if (!repository) return undefined;
  return { host, repository, number };
}

/** Canonical display URL for a pull request reference. */
export function canonicalGitHubPullRequestUrl(ref: ChatPullRequestRef): string {
  return `https://${ref.host}/${ref.repository}/pull/${ref.number}`;
}

export function pullRequestRefKey(ref: ChatPullRequestRef): string {
  return `${ref.host}/${ref.repository}#${ref.number}`;
}

export function samePullRequestRef(a: ChatPullRequestRef, b: ChatPullRequestRef): boolean {
  return pullRequestRefKey(a) === pullRequestRefKey(b);
}

export function normalizePullRequestRef(value: unknown): ChatPullRequestRef | undefined {
  if (!isRecord(value)) return undefined;
  const host = normalizeGitHubHost(value.host);
  const repository = normalizeGitHubRepositoryIdentity(value.repository);
  const number = normalizeGitHubPullRequestNumber(value.number);
  return host && repository && number ? { host, repository, number } : undefined;
}

export function normalizeChatPullRequestSource(value: unknown): ChatPullRequestSource {
  return value === "created" || value === "manual" || value === "branch-discovered"
    ? value
    : "manual";
}

export function normalizeChatPullRequestSnapshot(
  value: unknown,
): ChatPullRequestSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const title = boundedText(value.title, MAX_CHAT_PULL_REQUEST_TITLE_CHARS);
  const headBranch = normalizeBranch(value.headBranch);
  const baseBranch = normalizeBranch(value.baseBranch);
  const syncedAt =
    typeof value.syncedAt === "number" && Number.isFinite(value.syncedAt) && value.syncedAt > 0
      ? Math.floor(value.syncedAt)
      : undefined;
  if (!title || !headBranch || !baseBranch || !syncedAt) return undefined;
  const state: ChatPullRequestState =
    value.state === "merged" || value.state === "closed" ? value.state : "open";
  const checksState: ChatPullRequestChecksState | null | undefined =
    value.checksState === "passing" ||
    value.checksState === "failing" ||
    value.checksState === "pending" ||
    value.checksState === null
      ? (value.checksState as ChatPullRequestChecksState | null)
      : undefined;
  const reviewDecision: ChatPullRequestReviewDecision | null | undefined =
    value.reviewDecision === "approved" ||
    value.reviewDecision === "changes-requested" ||
    value.reviewDecision === "review-required" ||
    value.reviewDecision === null
      ? (value.reviewDecision as ChatPullRequestReviewDecision | null)
      : undefined;
  const author = boundedText(value.author, 128);
  const headSha = normalizeSha(value.headSha);
  return {
    title,
    state,
    ...(value.isDraft === true ? { isDraft: true } : {}),
    headBranch,
    baseBranch,
    ...(headSha ? { headSha } : {}),
    ...(author ? { author } : {}),
    ...(reviewDecision !== undefined ? { reviewDecision } : {}),
    ...(typeof value.mergeable === "boolean" || value.mergeable === null
      ? { mergeable: value.mergeable as boolean | null }
      : {}),
    ...(checksState !== undefined ? { checksState } : {}),
    syncedAt,
  };
}

/**
 * Tolerant reader for a stored link record: drops records that cannot be
 * normalized, and drops only the snapshot when just the snapshot is malformed.
 */
export function normalizeChatPullRequestLink(value: unknown): ChatPullRequestLink | undefined {
  if (!isRecord(value)) return undefined;
  const ref = normalizePullRequestRef(value);
  if (!ref) return undefined;
  const linkedAt =
    typeof value.linkedAt === "number" && Number.isFinite(value.linkedAt) && value.linkedAt > 0
      ? Math.floor(value.linkedAt)
      : 0;
  if (!linkedAt) return undefined;
  const url = boundedText(value.url, MAX_CHAT_PULL_REQUEST_STRING_CHARS);
  const canonicalUrl =
    url && parseGitHubPullRequestUrl(url) ? url : canonicalGitHubPullRequestUrl(ref);
  const snapshot = normalizeChatPullRequestSnapshot(value.snapshot);
  return {
    ...ref,
    url: canonicalUrl,
    source: normalizeChatPullRequestSource(value.source),
    linkedAt,
    ...(snapshot ? { snapshot } : {}),
  };
}

const SAFE_CHAT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

/** Chat ids become store file names; keep them path-safe and bounded. */
export function isSafeChatPullRequestChatId(value: unknown): value is string {
  return typeof value === "string" && SAFE_CHAT_ID_PATTERN.test(value);
}

const OPERATION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/u;

export function normalizeChatPullRequestCreateIntent(
  value: unknown,
): ChatPullRequestCreateIntent | undefined {
  if (!isRecord(value)) return undefined;
  const host = normalizeGitHubHost(value.host);
  const repository = normalizeGitHubRepositoryIdentity(value.repository);
  const headBranch = normalizeBranch(value.headBranch);
  const baseBranch = normalizeBranch(value.baseBranch);
  const title = boundedText(value.title, MAX_CHAT_PULL_REQUEST_TITLE_CHARS);
  const requestedAt =
    typeof value.requestedAt === "number" &&
    Number.isFinite(value.requestedAt) &&
    value.requestedAt > 0
      ? Math.floor(value.requestedAt)
      : undefined;
  const operationId = boundedText(value.operationId, 64);
  if (
    !host ||
    !repository ||
    !headBranch ||
    !baseBranch ||
    !title ||
    !requestedAt ||
    !operationId ||
    !OPERATION_ID_PATTERN.test(operationId)
  ) {
    return undefined;
  }
  const expectedHeadSha = normalizeSha(value.expectedHeadSha);
  return {
    operationId,
    host,
    repository,
    headBranch,
    baseBranch,
    ...(expectedHeadSha ? { expectedHeadSha } : {}),
    title,
    requestedAt,
  };
}
