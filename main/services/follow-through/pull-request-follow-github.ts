// GitHub reads for a followed pull request: one GraphQL read for the pull
// request, its checks, comments and reviews; the end of a failed Actions job's
// log; and who may write to the repository. Comment authors are trusted only
// when they own the repository or GitHub says they can write to it.

import type { GitHubApi, GitHubApiResult } from "../github/github-api.js";
import { PULL_REQUEST_FRAGMENT, pullRequestFromGraphQl } from "../github/github-pull-request-graphql.js";
import { boundedString, isRecord, safeHttpUrl } from "../github/github-pull-request-parse.js";
import { tailText } from "../../../renderer/shared/agent-notices.js";
import { normalizeSubagentModelText } from "../subagents/model-text.js";
import type { FollowedCheck, FollowedComment, PullRequestObservation } from "./pull-request-follow.js";

const MAX_BODY_CHARS = 20_000;
export const FOLLOW_LOG_TAIL_CHARS = 3_000;
const PERMISSION_TTL_MS = 60 * 60_000;
const WRITE_ROLES = new Set(["admin", "maintain", "write"]);
/** Associations that can come with write access; GitHub is asked to be sure. */
const MAYBE_WRITE = new Set(["MEMBER", "COLLABORATOR"]);

const FOLLOW_QUERY = `query AidenFollowPullRequest($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    owner { login }
    pullRequest(number: $number) {
      ...AidenPullRequest
      comments(last: 30) { nodes { id author { login } authorAssociation body createdAt url } }
      reviews(last: 30) { nodes { id author { login } authorAssociation state body submittedAt url
        comments(first: 20) { nodes { id author { login } authorAssociation body createdAt url path } } } }
    }
  }
}
${PULL_REQUEST_FRAGMENT}`;

export type FollowReadResult =
  | { kind: "ok"; observation: PullRequestObservation; viewer?: string }
  /** The pull request or repository is gone, or this account cannot see it. */
  | { kind: "gone"; message: string }
  | { kind: "retry"; message: string; retryAt?: number };

interface RawComment {
  id: string;
  kind: FollowedComment["kind"];
  author: string;
  association: string;
  body: string;
  url?: string;
  createdAt: number;
  path?: string;
  reviewState?: string;
}

/** Comment text keeps its lines; other control characters go. */
export function commentBody(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/gu, "\n").replace(/[^\P{Cc}\n\t]+/gu, "").slice(0, MAX_BODY_CHARS);
}

function timestamp(value: unknown): number {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function nodes(connection: unknown): unknown[] {
  return isRecord(connection) && Array.isArray(connection.nodes) ? connection.nodes : [];
}

function rawComment(node: unknown, kind: FollowedComment["kind"], timeField: string): RawComment | undefined {
  if (!isRecord(node)) return undefined;
  const id = boundedString(node.id, 200);
  const author = isRecord(node.author) ? boundedString(node.author.login, 128) : undefined;
  if (!id || !author) return undefined;
  const path = boundedString(node.path, 500);
  const reviewState = boundedString(node.state, 40);
  const url = safeHttpUrl(node.url);
  return {
    id,
    kind,
    author,
    association: boundedString(node.authorAssociation, 40) ?? "NONE",
    body: commentBody(node.body),
    ...(url ? { url } : {}),
    createdAt: timestamp(node[timeField]),
    ...(path ? { path } : {}),
    ...(reviewState && kind === "review" ? { reviewState } : {}),
  };
}

/** Every comment, review and review comment the read returned. */
export function commentsFromPullRequest(pullRequest: Record<string, unknown>): RawComment[] {
  const comments: RawComment[] = [];
  for (const node of nodes(pullRequest.comments)) {
    const comment = rawComment(node, "comment", "createdAt");
    if (comment) comments.push(comment);
  }
  for (const node of nodes(pullRequest.reviews)) {
    const review = rawComment(node, "review", "submittedAt");
    // An approval or a change request is news even without a body; an empty
    // "commented" review only wraps the inline comments below.
    if (review && (review.body.trim() || (review.reviewState && review.reviewState !== "COMMENTED"))) {
      comments.push(review.body.trim() ? review : { ...review, body: `(${review.reviewState!.toLowerCase().replace(/_/gu, " ")})` });
    }
    if (!isRecord(node)) continue;
    for (const inner of nodes(node.comments)) {
      const comment = rawComment(inner, "review-comment", "createdAt");
      if (comment) comments.push(comment);
    }
  }
  return comments;
}

/** `https://github.com/o/r/actions/runs/1/job/2` → `2`; other check URLs have no job log. */
export function actionsJobId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const match = /\/actions\/runs\/\d+\/job\/(\d+)(?:\/|$)/u.exec(new URL(url).pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** Strip ANSI colours, other control characters and the timestamp Actions puts on every line. */
export function cleanJobLog(text: string): string {
  return normalizeSubagentModelText(text.replace(/^\uFEFF/u, "")).replace(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/gmu,
    "",
  );
}

function retryable(result: GitHubApiResult<unknown>): FollowReadResult {
  switch (result.kind) {
    case "rate-limited":
      return { kind: "retry", message: "GitHub's rate limit was reached; Aiden will try again later.", ...(result.retryAt ? { retryAt: result.retryAt } : {}) };
    case "unavailable":
    case "unauthorized":
      return { kind: "retry", message: "Aiden is not signed in to GitHub. Sign in with the gh command-line tool." };
    case "not-found":
      return { kind: "gone", message: "GitHub could not find this pull request." };
    default:
      return { kind: "retry", message: "message" in result && result.message ? result.message : "GitHub could not be read." };
  }
}

export class PullRequestFollowReader {
  private readonly permissions = new Map<string, { write: boolean; at: number }>();

  constructor(
    private readonly api: Pick<GitHubApi, "graphql" | "rest">,
    private readonly now: () => number = Date.now,
  ) {}

  async read(
    follow: { host: string; repository: string; number: number },
    signal?: AbortSignal,
  ): Promise<FollowReadResult> {
    const [owner, name] = follow.repository.split("/");
    if (!owner || !name) return { kind: "gone", message: "The repository name is invalid." };
    const result = await this.api.graphql<Record<string, unknown>>({
      host: follow.host,
      operation: "pr.follow",
      query: FOLLOW_QUERY,
      variables: { owner, name, number: follow.number },
      ...(signal ? { signal } : {}),
    });
    if (result.kind !== "ok") return retryable(result);
    const data = result.data;
    const repository = isRecord(data.repository) ? data.repository : undefined;
    const raw = repository && isRecord(repository.pullRequest) ? repository.pullRequest : undefined;
    if (!repository || !raw) return { kind: "gone", message: "GitHub could not find this pull request." };
    let summary;
    try {
      summary = pullRequestFromGraphQl(raw);
    } catch (error) {
      return { kind: "retry", message: error instanceof Error ? error.message : "GitHub returned an invalid pull request." };
    }
    const repositoryOwner = isRecord(repository.owner) ? boundedString(repository.owner.login, 128)?.toLowerCase() : undefined;
    const viewer = isRecord(data.viewer) ? boundedString(data.viewer.login, 128) : undefined;
    const comments: FollowedComment[] = [];
    for (const comment of commentsFromPullRequest(raw)) {
      const trusted = await this.trusted(follow.host, follow.repository, comment, repositoryOwner, viewer, signal);
      comments.push({
        id: comment.id,
        kind: comment.kind,
        author: comment.author,
        trusted,
        ...(viewer && comment.author.toLowerCase() === viewer.toLowerCase() ? { byViewer: true } : {}),
        body: comment.body,
        ...(comment.url ? { url: comment.url } : {}),
        createdAt: comment.createdAt,
        ...(comment.path ? { path: comment.path } : {}),
        ...(comment.reviewState ? { reviewState: comment.reviewState } : {}),
      });
    }
    const checks: FollowedCheck[] = summary.checks.map((check) => ({
      name: check.name,
      status: check.status,
      ...(check.url ? { url: check.url } : {}),
    }));
    return {
      kind: "ok",
      ...(viewer ? { viewer } : {}),
      observation: {
        title: summary.title,
        url: summary.url,
        state: summary.state,
        ...(summary.headSha ? { headSha: summary.headSha } : {}),
        mergeable: summary.mergeable ?? null,
        checksState: summary.checksState ?? null,
        checks,
        comments,
      },
    };
  }

  /** The end of a failed Actions job's log, or undefined when it cannot be read. */
  async jobLogTail(
    follow: { host: string; repository: string },
    check: FollowedCheck,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const jobId = actionsJobId(check.url);
    if (!jobId) return undefined;
    const result = await this.api.rest<string>({
      host: follow.host,
      operation: "pr.follow.log",
      path: `/repos/${follow.repository}/actions/jobs/${jobId}/logs`,
      accept: "application/vnd.github+json",
      text: true,
      ...(signal ? { signal } : {}),
    });
    if (result.kind !== "ok" || typeof result.data !== "string") return undefined;
    return tailText(cleanJobLog(result.data).trimEnd(), FOLLOW_LOG_TAIL_CHARS).text;
  }

  private async trusted(
    host: string,
    repository: string,
    comment: RawComment,
    repositoryOwner: string | undefined,
    viewer: string | undefined,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const login = comment.author.toLowerCase();
    if (comment.association === "OWNER" || login === repositoryOwner) return true;
    // The signed-in account's own comments: the person writing on GitHub.
    if (viewer && login === viewer.toLowerCase()) return true;
    if (!MAYBE_WRITE.has(comment.association)) return false;
    const key = `${host}/${repository}/${login}`;
    const cached = this.permissions.get(key);
    if (cached && this.now() - cached.at < PERMISSION_TTL_MS) return cached.write;
    const result = await this.api.rest<Record<string, unknown>>({
      host,
      operation: "pr.follow.permission",
      path: `/repos/${repository}/collaborators/${encodeURIComponent(comment.author)}/permission`,
      ...(signal ? { signal } : {}),
    });
    if (result.kind !== "ok") return false;
    const permission = boundedString(result.data.permission, 40)?.toLowerCase();
    const role = boundedString(result.data.role_name, 40)?.toLowerCase();
    const write = WRITE_ROLES.has(permission ?? "") || WRITE_ROLES.has(role ?? "");
    this.permissions.set(key, { write, at: this.now() });
    return write;
  }
}
