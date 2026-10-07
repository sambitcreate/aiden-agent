// The main process's one GitHub client: a credential source, the rate-limit
// gate, the transport, and the pull request service built on them.

import { logger } from "../../platform.js";
import { GitHubPullRequestService } from "../github-pull-request.js";
import { GitHubApi } from "./github-api.js";
import { GitHubCredentialSource } from "./github-credentials.js";
import { isWellKnownGitHubHost, LocalRepositoryResolver } from "./github-local-repository.js";
import { DirectPullRequestReader } from "./github-pull-request-graphql.js";
import { GitHubRateLimitGate } from "./github-request-gate.js";

const credentials = new GitHubCredentialSource();

export const githubGate = new GitHubRateLimitGate({ log: (line) => logger.info("github", line) });

export const githubApi = new GitHubApi({ credentials, gate: githubGate });

const repositories = new LocalRepositoryResolver({
  isGitHubHost: async (host) => isWellKnownGitHubHost(host) || (await credentials.resolve(host)).ok,
});

export const githubPullRequests = new GitHubPullRequestService({
  reader: new DirectPullRequestReader(githubApi),
  repositories,
});

export const githubCurrentPullRequest = (folderPath: string, signal?: AbortSignal) =>
  githubPullRequests.currentPullRequest(folderPath, signal);
