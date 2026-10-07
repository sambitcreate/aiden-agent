// Test support: an in-memory GitHub that answers Aiden's pull request
// GraphQL documents the way api.github.com does, and counts what it served.

import { jsonResponse, type RecordedGitHubRequest, type ScriptedResponder } from "./github-test-fetch.js";

export interface FakeCheck {
  name: string;
  status: "QUEUED" | "IN_PROGRESS" | "COMPLETED";
  conclusion?: "SUCCESS" | "FAILURE" | "CANCELLED" | "SKIPPED";
}

export interface FakePullRequest {
  /** `owner/name` of the base repository. */
  repository: string;
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft?: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  /** Owner of the repository the head branch lives in. */
  headOwner: string;
  checks: FakeCheck[];
  createdAt: number;
  updatedAt: number;
}

export interface FakeGitHubOptions {
  host?: string;
  repositories: string[];
  pullRequests?: FakePullRequest[];
  /** GraphQL points per hour. */
  limit?: number;
  now?: () => number;
}

/**
 * Answers `repository(owner, name)` aliases that select `pullRequest(number)`,
 * `pullRequests(headRefName)`, `pullRequests(states, first)`, or nothing, keyed
 * off the variables each alias declares. `script` lets a test answer a request
 * itself (a rate limit, an outage) before the fake does.
 */
export class FakeGitHub {
  readonly host: string;
  readonly repositories: Set<string>;
  readonly pullRequests: FakePullRequest[];
  readonly served: RecordedGitHubRequest[] = [];
  script: ((request: RecordedGitHubRequest) => Response | undefined) | undefined;
  private readonly limit: number;
  private remaining: number;
  private readonly now: () => number;

  constructor(options: FakeGitHubOptions) {
    this.host = options.host ?? "github.com";
    this.repositories = new Set(options.repositories.map((name) => name.toLowerCase()));
    this.pullRequests = options.pullRequests ?? [];
    this.limit = options.limit ?? 5_000;
    this.remaining = this.limit;
    this.now = options.now ?? Date.now;
  }

  pullRequest(repository: string, number: number): FakePullRequest {
    const found = this.pullRequests.find((entry) => entry.repository === repository && entry.number === number);
    if (!found) throw new Error(`No fake pull request ${repository}#${number}`);
    return found;
  }

  get responder(): ScriptedResponder {
    return (request) => this.answer(request);
  }

  private answer(request: RecordedGitHubRequest): Response {
    this.served.push(request);
    const scripted = this.script?.(request);
    if (scripted) return scripted;
    if (!request.url.endsWith("/graphql") || !request.json?.query) {
      return jsonResponse({ message: "Not Found" }, 404);
    }
    const variables = request.json.variables ?? {};
    const data: Record<string, unknown> = {};
    const errors: Array<{ type: string; message: string; path: string[] }> = [];
    for (let index = 0; `o${index}` in variables; index += 1) {
      const alias = `e${index}`;
      const nameWithOwner = `${String(variables[`o${index}`])}/${String(variables[`n${index}`])}`.toLowerCase();
      if (!this.repositories.has(nameWithOwner)) {
        data[alias] = null;
        errors.push({ type: "NOT_FOUND", message: `Could not resolve to a Repository with the name '${nameWithOwner}'.`, path: [alias] });
        continue;
      }
      const repository: Record<string, unknown> = { nameWithOwner };
      const inRepository = this.pullRequests.filter((entry) => entry.repository === nameWithOwner);
      if (`p${index}` in variables) {
        const found = inRepository.find((entry) => entry.number === variables[`p${index}`]);
        repository.pullRequest = found ? this.node(found) : null;
        if (!found) {
          errors.push({ type: "NOT_FOUND", message: "Could not resolve to a PullRequest.", path: [alias, "pullRequest"] });
        }
      } else if (`h${index}` in variables) {
        const nodes = inRepository
          .filter((entry) => entry.headRefName === variables[`h${index}`])
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 30);
        repository.pullRequests = { nodes: nodes.map((entry) => this.node(entry)) };
      } else if (`s${index}` in variables) {
        const states = variables[`s${index}`] as string[];
        const first = variables[`f${index}`] as number;
        const nodes = inRepository
          .filter((entry) => states.includes(entry.state))
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, first);
        repository.pullRequests = { nodes: nodes.map((entry) => this.node(entry)) };
      }
      data[alias] = repository;
    }
    if (/\brateLimit\s*\{/u.test(request.json.query)) {
      this.remaining = Math.max(0, this.remaining - 1);
      data.rateLimit = {
        cost: 1,
        limit: this.limit,
        remaining: this.remaining,
        resetAt: new Date(this.now() + 3_600_000).toISOString(),
      };
    }
    return jsonResponse(errors.length > 0 ? { data, errors } : { data });
  }

  private node(entry: FakePullRequest): Record<string, unknown> {
    return {
      number: entry.number,
      title: entry.title,
      url: `https://${this.host}/${entry.repository}/pull/${entry.number}`,
      state: entry.state,
      isDraft: entry.isDraft === true,
      headRefName: entry.headRefName,
      baseRefName: entry.baseRefName,
      headRefOid: entry.headRefOid,
      author: { login: "octocat" },
      reviewDecision: null,
      mergeable: "MERGEABLE",
      updatedAt: new Date(entry.updatedAt).toISOString(),
      headRepositoryOwner: { login: entry.headOwner },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: entry.checks.map((check) => ({
                    __typename: "CheckRun",
                    name: check.name,
                    status: check.status,
                    conclusion: check.conclusion ?? null,
                    detailsUrl: null,
                    startedAt: null,
                    completedAt: null,
                    checkSuite: null,
                  })),
                },
              },
            },
          },
        ],
      },
    };
  }
}
