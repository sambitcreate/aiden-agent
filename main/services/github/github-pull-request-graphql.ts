// GraphQL documents for pull request reads. Several reads can share one
// document: each entry becomes an aliased `repository` field with its own
// variables, and each alias is answered (or fails) on its own.

import { normalizeGitHubRepositoryIdentity } from "../../../renderer/shared/chat-pull-requests.js";
import type { GitHubPullRequestSummary, GitHubRepositoryRef } from "../types.js";
import type { GitHubApi, GitHubApiResult, GitHubGraphQlFieldError } from "./github-api.js";
import { boundedString, isRecord, parseRawPullRequest } from "./github-pull-request-parse.js";

/** Head-branch lookups read this many PRs; a full page means the answer may be truncated. */
export const BRANCH_LOOKUP_LIMIT = 30;

const PULL_REQUEST_FRAGMENT = `fragment AidenPullRequest on PullRequest {
  number title url state isDraft headRefName baseRefName headRefOid
  author { login } reviewDecision mergeable updatedAt
  headRepositoryOwner { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion detailsUrl startedAt completedAt checkSuite { workflowRun { workflow { name } } } }
    ... on StatusContext { context state description targetUrl createdAt }
  } } } } } }
}`;

export type PullRequestListState = "OPEN" | "CLOSED" | "MERGED";

export type PullRequestQueryEntry =
  | { kind: "number"; owner: string; name: string; number: number }
  | { kind: "head"; owner: string; name: string; headBranch: string }
  | { kind: "list"; owner: string; name: string; states: PullRequestListState[]; first: number }
  | { kind: "repository"; owner: string; name: string };

export interface PullRequestHeadSummary extends GitHubPullRequestSummary {
  /** Login of the account whose repository holds the head branch. */
  headOwner?: string;
}

export type PullRequestEntryResult =
  | {
      kind: "ok";
      repository: GitHubRepositoryRef;
      /** One entry for `number`, the page for `head`/`list`, none for `repository`. */
      pullRequests: PullRequestHeadSummary[];
    }
  | { kind: "not-found"; message: string }
  | Exclude<GitHubApiResult<never>, { kind: "ok" } | { kind: "not-found" } | { kind: "not-modified" }>;

/** Stable identity of an entry, used to share in-flight reads and cache answers. */
export function pullRequestEntryKey(host: string, entry: PullRequestQueryEntry): string {
  const repository = `${host}/${entry.owner.toLowerCase()}/${entry.name.toLowerCase()}`;
  switch (entry.kind) {
    case "number":
      return `${repository}#${entry.number}`;
    case "head":
      return `${repository}@${entry.headBranch}`;
    case "list":
      return `${repository}?${entry.states.join(",")}:${entry.first}`;
    case "repository":
      return repository;
  }
}

function selection(entry: PullRequestQueryEntry, index: number): { fields: string; variables: string[] } {
  switch (entry.kind) {
    case "number":
      return { fields: `pullRequest(number: $p${index}) { ...AidenPullRequest }`, variables: [`$p${index}: Int!`] };
    case "head":
      return {
        fields: `pullRequests(headRefName: $h${index}, first: ${BRANCH_LOOKUP_LIMIT}, states: [OPEN, CLOSED, MERGED], orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ...AidenPullRequest } }`,
        variables: [`$h${index}: String!`],
      };
    case "list":
      return {
        fields: `pullRequests(states: $s${index}, first: $f${index}, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...AidenPullRequest } }`,
        variables: [`$s${index}: [PullRequestState!]`, `$f${index}: Int!`],
      };
    case "repository":
      return { fields: "", variables: [] };
  }
}

/** One document for every entry; values travel as variables, never inlined. */
export function buildPullRequestDocument(entries: readonly PullRequestQueryEntry[]): {
  query: string;
  variables: Record<string, unknown>;
} {
  const declarations: string[] = [];
  const fields: string[] = [];
  const variables: Record<string, unknown> = {};
  let needsFragment = false;
  entries.forEach((entry, index) => {
    const part = selection(entry, index);
    declarations.push(`$o${index}: String!`, `$n${index}: String!`, ...part.variables);
    variables[`o${index}`] = entry.owner;
    variables[`n${index}`] = entry.name;
    if (entry.kind === "number") variables[`p${index}`] = entry.number;
    if (entry.kind === "head") variables[`h${index}`] = entry.headBranch;
    if (entry.kind === "list") {
      variables[`s${index}`] = entry.states;
      variables[`f${index}`] = entry.first;
    }
    if (part.fields) needsFragment = true;
    fields.push(`e${index}: repository(owner: $o${index}, name: $n${index}) { nameWithOwner ${part.fields} }`);
  });
  const query = `query AidenPullRequests(${declarations.join(", ")}) { ${fields.join(" ")} }${needsFragment ? `\n${PULL_REQUEST_FRAGMENT}` : ""}`;
  return { query, variables };
}

type GraphQlFieldError = GitHubGraphQlFieldError;

function checkNode(node: unknown): Record<string, unknown> | undefined {
  if (!isRecord(node)) return undefined;
  if (node.__typename === "StatusContext") {
    return {
      context: node.context,
      state: node.state,
      description: node.description,
      targetUrl: node.targetUrl,
      startedAt: node.createdAt,
    };
  }
  const suite = isRecord(node.checkSuite) ? node.checkSuite : undefined;
  const run = suite && isRecord(suite.workflowRun) ? suite.workflowRun : undefined;
  const workflow = run && isRecord(run.workflow) ? run.workflow : undefined;
  return {
    name: node.name,
    status: node.status,
    conclusion: node.conclusion,
    detailsUrl: node.detailsUrl,
    startedAt: node.startedAt,
    completedAt: node.completedAt,
    workflowName: workflow?.name,
  };
}

function rollupNodes(node: Record<string, unknown>): unknown[] {
  const commits = isRecord(node.commits) && Array.isArray(node.commits.nodes) ? node.commits.nodes : [];
  const last = commits.at(-1);
  const commit = isRecord(last) && isRecord(last.commit) ? last.commit : undefined;
  const rollup = commit && isRecord(commit.statusCheckRollup) ? commit.statusCheckRollup : undefined;
  const contexts = rollup && isRecord(rollup.contexts) && Array.isArray(rollup.contexts.nodes) ? rollup.contexts.nodes : [];
  return contexts.map(checkNode).filter((entry) => entry !== undefined);
}

export function pullRequestFromGraphQl(node: unknown): PullRequestHeadSummary {
  if (!isRecord(node)) throw new Error("GitHub returned an invalid pull request response.");
  const summary = parseRawPullRequest({ ...node, statusCheckRollup: rollupNodes(node) });
  const owner = isRecord(node.headRepositoryOwner) ? boundedString(node.headRepositoryOwner.login, 128) : undefined;
  return owner ? { ...summary, headOwner: owner.toLowerCase() } : summary;
}

function aliasErrors(errors: readonly GraphQlFieldError[], alias: string): GraphQlFieldError[] {
  return errors.filter((error) => Array.isArray(error.path) && error.path[0] === alias);
}

function entryFromData(
  host: string,
  entry: PullRequestQueryEntry,
  value: unknown,
  errors: readonly GraphQlFieldError[],
): PullRequestEntryResult {
  const message = boundedString(errors[0]?.message, 600);
  const missing = errors.length > 0 && errors.every((error) => error.type === "NOT_FOUND");
  if (!isRecord(value)) {
    if (missing || errors.length === 0) {
      return { kind: "not-found", message: message ?? `GitHub could not find ${entry.owner}/${entry.name}.` };
    }
    return { kind: "failed", message: message ?? "GitHub could not read the repository." };
  }
  const nameWithOwner = normalizeGitHubRepositoryIdentity(value.nameWithOwner) ?? `${entry.owner}/${entry.name}`.toLowerCase();
  const repository = { host, nameWithOwner };
  try {
    if (entry.kind === "repository") return { kind: "ok", repository, pullRequests: [] };
    if (entry.kind === "number") {
      if (!isRecord(value.pullRequest)) {
        return missing || errors.length === 0
          ? { kind: "not-found", message: message ?? `GitHub could not find pull request #${entry.number} in ${nameWithOwner}.` }
          : { kind: "failed", message: message ?? "GitHub could not read the pull request." };
      }
      return { kind: "ok", repository, pullRequests: [pullRequestFromGraphQl(value.pullRequest)] };
    }
    const connection = isRecord(value.pullRequests) && Array.isArray(value.pullRequests.nodes) ? value.pullRequests.nodes : undefined;
    if (!connection) return { kind: "failed", message: message ?? "GitHub could not list pull requests." };
    return { kind: "ok", repository, pullRequests: connection.filter(isRecord).map(pullRequestFromGraphQl) };
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : "GitHub returned an invalid pull request response." };
  }
}

/** Split one document's answer back into per-entry results, in entry order. */
export function pullRequestEntryResults(
  host: string,
  entries: readonly PullRequestQueryEntry[],
  result: GitHubApiResult<unknown>,
): PullRequestEntryResult[] {
  if (result.kind !== "ok" && result.kind !== "not-found") {
    const failure: PullRequestEntryResult =
      result.kind === "not-modified" ? { kind: "failed", message: "GitHub returned an unexpected response." } : result;
    return entries.map(() => failure);
  }
  const data = result.data;
  const errors = result.errors ?? [];
  if (!isRecord(data)) {
    return entries.map(() => ({ kind: "not-found" as const, message: result.kind === "not-found" ? result.message : "GitHub returned no data." }));
  }
  return entries.map((entry, index) => entryFromData(host, entry, data[`e${index}`], aliasErrors(errors, `e${index}`)));
}

export interface PullRequestReadOptions {
  /** Usage label, e.g. `pr.current`. */
  operation: string;
  interactive?: boolean;
  signal?: AbortSignal;
  /**
   * Local knowledge that changes the expected answer, such as the head sha
   * last pushed. A cached answer read for a different version is not reused.
   */
  version?: string;
  /** Skip cached answers; interactive reads always do. */
  fresh?: boolean;
}

/** Reads one entry; implementations may batch, share, or cache reads. */
export interface PullRequestEntryReader {
  read(host: string, entry: PullRequestQueryEntry, options: PullRequestReadOptions): Promise<PullRequestEntryResult>;
}

/** One GraphQL request per entry, without sharing or caching. */
export class DirectPullRequestReader implements PullRequestEntryReader {
  private readonly api: Pick<GitHubApi, "graphql">;

  constructor(api: Pick<GitHubApi, "graphql">) {
    this.api = api;
  }

  async read(host: string, entry: PullRequestQueryEntry, options: PullRequestReadOptions): Promise<PullRequestEntryResult> {
    const document = buildPullRequestDocument([entry]);
    const result = await this.api.graphql({
      host,
      operation: options.operation,
      interactive: options.interactive,
      signal: options.signal,
      ...document,
    });
    return pullRequestEntryResults(host, [entry], result)[0]!;
  }
}
