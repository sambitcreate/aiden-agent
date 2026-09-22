// Chat ↔ pull request orchestration.
//
// Owns the lifecycle of a chat's linked PRs: link by URL or chooser, unlink,
// refresh snapshots from GitHub, post-push detection, and `gh pr create` with
// durable unknown-outcome reconciliation. All GitHub traffic goes through the
// existing `gh` CLI adapter — nothing here touches tokens or the git config,
// and unlinking/deleting never performs a GitHub mutation.

import * as os from "node:os";
import { randomUUID } from "node:crypto";
import {
  canonicalGitHubPullRequestUrl,
  isSafeChatPullRequestChatId,
  parseExpectedHeadSha,
  parsePullRequestRepository,
  parseGitHubPullRequestUrl,
  pullRequestRefKey,
  type ChatPullRequestCreateIntent,
  type ChatPullRequestLink,
  type ChatPullRequestPendingCreate,
  type ChatPullRequestRef,
  type ChatPullRequestSnapshot,
  type ChatPullRequestView,
} from "../../renderer/shared/chat-pull-requests.js";
import type {
  ChatPullRequestCandidatesResult,
  ChatPullRequestCreateResult,
  ChatPullRequestDetectResult,
  ChatPullRequestLinkResult,
  ChatPullRequestListResult,
} from "../../renderer/shared/chat-pull-requests.js";
import type { ChatPullRequestStore } from "./chat-pull-request-store.js";
import type { GitHubPullRequestService } from "./github-pull-request.js";
import { pullRequestIdentityFromSummary } from "./github-pull-request.js";
import {
  pullRequestViewFromLink,
  resolveCurrentPullRequest,
  type PullRequestResolverContext,
} from "./pull-request-current-resolver.js";
import {
  intentMatchesRef,
  matchesCreateIntent,
  reconcilePullRequestCreate,
} from "./pull-request-create-reconciliation.js";
import type { GitHubPullRequestSummary } from "./types.js";

export type GitHubAccessForPullRequests = Pick<
  GitHubPullRequestService,
  | "resolveRepository"
  | "getPullRequest"
  | "getPullRequestByUrl"
  | "findForBranch"
  | "listPullRequests"
  | "createPullRequest"
  | "currentPullRequest"
>;

export interface GitInfoLike {
  isRepo: boolean;
  branch?: string;
  hasRemote?: boolean;
}

export interface ChatPullRequestServiceDeps {
  store: Pick<
    ChatPullRequestStore,
    | "list"
    | "listDismissed"
    | "get"
    | "link"
    | "unlink"
    | "updateSnapshot"
    | "deleteChat"
    | "recordCreateIntent"
    | "listCreateIntents"
    | "clearCreateIntent"
  >;
  github: GitHubAccessForPullRequests;
  gitInfo: (cwd: string, signal?: AbortSignal) => Promise<GitInfoLike>;
  /** Chat → its current workspace id (undefined for unbound/scratch chats). */
  chatWorkspaceId: (chatId: string) => Promise<string | undefined>;
  /** Workspace → accessible folder path (undefined when absent/no access). */
  workspaceFolderPath: (workspaceId: string) => Promise<string | undefined>;
  onChanged?: (chatId: string) => void;
}

export type {
  ChatPullRequestCandidatesResult,
  ChatPullRequestCreateResult,
  ChatPullRequestDetectResult,
  ChatPullRequestLinkResult,
  ChatPullRequestListResult,
} from "../../renderer/shared/chat-pull-requests.js";

export type ChatPullRequestPendingIntent = ChatPullRequestPendingCreate;

function snapshotFromSummary(
  summary: GitHubPullRequestSummary,
): ChatPullRequestSnapshot {
  return {
    title: summary.title,
    state: summary.state,
    ...(summary.isDraft ? { isDraft: true } : {}),
    headBranch: summary.headBranch,
    baseBranch: summary.baseBranch,
    ...(summary.headSha ? { headSha: summary.headSha } : {}),
    ...(summary.author ? { author: summary.author } : {}),
    ...(summary.reviewDecision !== undefined
      ? { reviewDecision: summary.reviewDecision }
      : {}),
    ...(summary.mergeable !== undefined
      ? { mergeable: summary.mergeable }
      : {}),
    ...(summary.checksState !== undefined
      ? { checksState: summary.checksState }
      : {}),
    syncedAt: Date.now(),
  };
}

function viewFromSummary(
  summary: GitHubPullRequestSummary,
  extras: Partial<ChatPullRequestView>,
): ChatPullRequestView {
  const identity = pullRequestIdentityFromSummary(summary);
  return {
    host: identity?.host ?? extras.host ?? "github.com",
    repository: identity?.repository ?? extras.repository ?? "",
    number: summary.number,
    url: summary.url,
    linked: false,
    title: summary.title,
    state: summary.state,
    ...(summary.isDraft ? { isDraft: true } : {}),
    headBranch: summary.headBranch,
    baseBranch: summary.baseBranch,
    ...(summary.headSha ? { headSha: summary.headSha } : {}),
    ...(summary.author ? { author: summary.author } : {}),
    ...(summary.reviewDecision !== undefined
      ? { reviewDecision: summary.reviewDecision }
      : {}),
    ...(summary.mergeable !== undefined
      ? { mergeable: summary.mergeable }
      : {}),
    ...(summary.checksState !== undefined
      ? { checksState: summary.checksState }
      : {}),
    syncedAt: Date.now(),
    ...extras,
  };
}

function repoSelector(host: string, repository: string): string {
  return host === "github.com" ? repository : `${host}/${repository}`;
}

export class ChatPullRequestService {
  constructor(private readonly deps: ChatPullRequestServiceDeps) {}

  private async chatContext(
    chatId: string,
    workspaceIdOverride?: string,
    signal?: AbortSignal,
  ): Promise<{
    folderPath?: string;
    branch?: string;
    host?: string;
    repository?: string;
  }> {
    const workspaceId =
      workspaceIdOverride ?? (await this.deps.chatWorkspaceId(chatId));
    const folderPath = workspaceId
      ? await this.deps.workspaceFolderPath(workspaceId)
      : undefined;
    if (!folderPath) return {};
    const context: {
      folderPath?: string;
      branch?: string;
      host?: string;
      repository?: string;
    } = {
      folderPath,
    };
    const [info, repo] = await Promise.all([
      this.deps.gitInfo(folderPath, signal).catch(() => undefined),
      this.deps.github
        .resolveRepository(folderPath, signal)
        .catch(() => undefined),
    ]);
    if (info?.isRepo && info.branch) context.branch = info.branch;
    if (repo?.availability === "ready" && repo.repository) {
      context.host = repo.repository.host;
      context.repository = repo.repository.nameWithOwner;
    }
    return context;
  }

  private async cwdFor(chatId: string): Promise<string> {
    const workspaceId = await this.deps.chatWorkspaceId(chatId);
    const folderPath = workspaceId
      ? await this.deps.workspaceFolderPath(workspaceId)
      : undefined;
    return folderPath ?? os.homedir();
  }

  private notify(chatId: string): void {
    this.deps.onChanged?.(chatId);
  }

  async list(chatId: string): Promise<ChatPullRequestListResult> {
    const links = await this.deps.store.list(chatId);
    return {
      links: [...links]
        .sort((a, b) => b.linkedAt - a.linkedAt)
        .map(pullRequestViewFromLink),
    };
  }

  /**
   * Resolve the chat's current PR. Reads workspace branch + repo and live
   * branch discovery when a folder is available; never mutates links.
   */
  async current(chatId: string): Promise<{
    pullRequest: ChatPullRequestView | undefined;
    reason:
      | "workspace-branch"
      | "created"
      | "recent-open"
      | "recent-linked"
      | "discovered"
      | "none";
    message?: string;
  }> {
    const links = await this.deps.store.list(chatId);
    const context = await this.chatContext(chatId);
    const resolverContext: PullRequestResolverContext = {
      host: context.host,
      repository: context.repository,
      branch: context.branch,
    };
    let message: string | undefined;
    if (context.folderPath && context.branch) {
      const discovered = await this.deps.github.currentPullRequest(
        context.folderPath,
      );
      const dismissed = await this.deps.store.listDismissed(chatId);
      const identity =
        discovered.pullRequest &&
        pullRequestIdentityFromSummary(discovered.pullRequest);
      if (
        discovered.availability === "ready" &&
        discovered.pullRequest &&
        identity &&
        !dismissed.some(
          (ref) => pullRequestRefKey(ref) === pullRequestRefKey(identity),
        )
      ) {
        resolverContext.discovered = viewFromSummary(discovered.pullRequest, {
          linked: false,
        });
      } else if (discovered.availability !== "no-pull-request") {
        message = discovered.message;
      }
    }
    const resolved = resolveCurrentPullRequest(links, resolverContext);
    return { ...resolved, ...(message ? { message } : {}) };
  }

  /** Link a pull request by pasted URL — canonical identity comes from `gh`. */
  async link(
    chatId: string,
    input: { url: string },
  ): Promise<ChatPullRequestLinkResult> {
    const ref = parseGitHubPullRequestUrl(input.url);
    if (!ref) {
      return {
        ok: false,
        message: "That is not a valid GitHub pull request URL.",
      };
    }
    const cwd = await this.cwdFor(chatId);
    const status = await this.deps.github.getPullRequestByUrl(cwd, input.url);
    if (status.availability !== "ready" || !status.pullRequest) {
      return {
        ok: false,
        message:
          status.message ?? "The pull request could not be found on GitHub.",
      };
    }
    return this.linkSummary(chatId, status.pullRequest, "manual");
  }

  /** Link a pull request the caller already identified (chooser, post-push). */
  async linkExisting(
    chatId: string,
    ref: ChatPullRequestRef,
    source: ChatPullRequestLink["source"] = "manual",
  ): Promise<ChatPullRequestLinkResult> {
    const cwd = await this.cwdFor(chatId);
    const status = await this.deps.github.getPullRequest(
      cwd,
      repoSelector(ref.host, ref.repository),
      ref.number,
    );
    if (status.availability !== "ready" || !status.pullRequest) {
      return {
        ok: false,
        message:
          status.message ?? "The pull request could not be read from GitHub.",
      };
    }
    return this.linkSummary(chatId, status.pullRequest, source);
  }

  private async linkSummary(
    chatId: string,
    summary: GitHubPullRequestSummary,
    source: ChatPullRequestLink["source"],
    operationId?: string,
  ): Promise<ChatPullRequestLinkResult> {
    const identity = pullRequestIdentityFromSummary(summary);
    if (!identity) {
      return {
        ok: false,
        message: "GitHub did not report a canonical pull request URL.",
      };
    }
    const link = await this.deps.store.link(
      chatId,
      {
        host: identity.host,
        repository: identity.repository,
        number: identity.number,
        url: identity.url || canonicalGitHubPullRequestUrl(identity),
        source,
        linkedAt: Date.now(),
        snapshot: snapshotFromSummary(summary),
      },
      operationId,
    );
    this.notify(chatId);
    return { ok: true, pullRequest: pullRequestViewFromLink(link) };
  }

  /** Remove the Aiden-side relationship only — never touches GitHub. */
  async unlink(
    chatId: string,
    ref: ChatPullRequestRef,
  ): Promise<{ ok: boolean }> {
    const removed = await this.deps.store.unlink(chatId, ref);
    if (removed) this.notify(chatId);
    return { ok: removed };
  }

  /**
   * Refresh cached snapshots from GitHub. Failures keep the stale snapshot —
   * the cache is display state, not authority. `ref` limits to one link.
   */
  async refresh(
    chatId: string,
    ref?: ChatPullRequestRef,
  ): Promise<ChatPullRequestListResult> {
    const links = await this.deps.store.list(chatId);
    const targets = ref
      ? links.filter(
          (link) => pullRequestRefKey(link) === pullRequestRefKey(ref),
        )
      : links;
    const cwd = await this.cwdFor(chatId);
    let changed = false;
    for (const link of targets) {
      const status = await this.deps.github.getPullRequest(
        cwd,
        repoSelector(link.host, link.repository),
        link.number,
      );
      if (status.availability !== "ready" || !status.pullRequest) continue;
      await this.deps.store.updateSnapshot(
        chatId,
        link,
        snapshotFromSummary(status.pullRequest),
      );
      changed = true;
    }
    if (changed) this.notify(chatId);
    return this.list(chatId);
  }

  /**
   * Chooser candidates: open PRs on the workspace branch first, then other open
   * PRs in the repository — each marked when already linked to this chat.
   */
  async candidates(
    chatId: string,
    workspaceId?: string,
  ): Promise<ChatPullRequestCandidatesResult> {
    const context = await this.chatContext(chatId, workspaceId);
    if (!context.folderPath) {
      return {
        availability: "not-repo",
        message: "This chat is not attached to a workspace folder.",
        pullRequests: [],
      };
    }
    const links = await this.deps.store.list(chatId);
    const linkedKeys = new Set(links.map((link) => pullRequestRefKey(link)));
    const views: ChatPullRequestView[] = [];
    const seen = new Set<string>();
    const push = (summary: GitHubPullRequestSummary) => {
      const identity = pullRequestIdentityFromSummary(summary);
      if (!identity) return;
      const key = pullRequestRefKey(identity);
      if (seen.has(key)) return;
      seen.add(key);
      const link = links.find((entry) => pullRequestRefKey(entry) === key);
      views.push(
        viewFromSummary(summary, {
          linked: linkedKeys.has(key),
          ...(link ? { source: link.source, linkedAt: link.linkedAt } : {}),
        }),
      );
    };

    if (context.branch) {
      const forBranch = await this.deps.github.findForBranch(
        context.folderPath,
        context.branch,
      );
      if (forBranch.availability !== "ready") {
        return {
          availability: forBranch.availability,
          message: forBranch.message,
          pullRequests: [],
        };
      }
      for (const summary of forBranch.pullRequests ?? []) {
        if (summary.state === "open") push(summary);
      }
    }
    const open = await this.deps.github.listPullRequests(context.folderPath, {
      state: "open",
      limit: 30,
    });
    if (open.availability !== "ready") {
      // Branch results are still useful if the wider list call failed.
      return views.length > 0
        ? { availability: "ready", pullRequests: views }
        : {
            availability: open.availability,
            message: open.message,
            pullRequests: [],
          };
    }
    for (const summary of open.pullRequests ?? []) push(summary);
    return { availability: "ready", pullRequests: views };
  }

  /**
   * Post-push detection: look up the pushed head branch on GitHub and report
   * open matches. Matches already linked to this chat are refreshed instead of
   * offered for linking.
   */
  async detectAfterPush(
    chatId: string,
    input: {
      workspaceId: string;
      headBranch: string;
      expectedHeadSha?: string;
      repository?: string;
    },
  ): Promise<ChatPullRequestDetectResult> {
    const expectedSha = parseExpectedHeadSha(input.expectedHeadSha);
    const repository = parsePullRequestRepository(input.repository);
    const folderPath = await this.deps.workspaceFolderPath(input.workspaceId);
    if (!folderPath) {
      return {
        availability: "not-repo",
        message: "This workspace has no accessible folder.",
        matches: [],
        refreshed: [],
      };
    }
    const found = await this.deps.github.findForBranch(
      folderPath,
      input.headBranch,
      undefined,
      repository,
    );
    if (found.availability !== "ready" || !found.pullRequests) {
      return {
        availability: found.availability,
        message: found.message,
        matches: [],
        refreshed: [],
      };
    }
    const links = await this.deps.store.list(chatId);
    const matches: ChatPullRequestView[] = [];
    const refreshed: ChatPullRequestView[] = [];
    const unverifiable: GitHubPullRequestSummary[] = [];
    for (const summary of found.pullRequests) {
      if (summary.state !== "open") continue;
      // `gh pr list --head` matches the branch name, not the commit: only a PR
      // whose head still points at the pushed SHA can be offered as this push's
      // result — a same-named PR from another source stays unoffered.
      if (expectedSha && summary.headSha === undefined) {
        unverifiable.push(summary);
        continue;
      }
      if (expectedSha && summary.headSha !== expectedSha) continue;
      const identity = pullRequestIdentityFromSummary(summary);
      if (!identity) continue;
      const existing = links.find(
        (link) => pullRequestRefKey(link) === pullRequestRefKey(identity),
      );
      if (existing) {
        const updated = await this.deps.store.updateSnapshot(
          chatId,
          existing,
          snapshotFromSummary(summary),
        );
        if (updated) refreshed.push(pullRequestViewFromLink(updated));
      } else {
        matches.push(
          viewFromSummary(summary, {
            host: identity.host,
            repository: identity.repository,
            linked: false,
          }),
        );
      }
    }
    if (refreshed.length > 0) this.notify(chatId);
    // A same-branch PR whose head SHA could not be read may itself be the
    // pushed result: surfacing an explicit error keeps "Create pull request"
    // off the table instead of inviting a duplicate create.
    if (
      unverifiable.length > 0 &&
      matches.length === 0 &&
      refreshed.length === 0
    ) {
      return {
        availability: "error",
        message:
          "GitHub lists a pull request for this branch, but its head commit could not be read. Refresh or check GitHub before creating another.",
        matches: [],
        refreshed: [],
      };
    }
    return { availability: "ready", matches, refreshed };
  }

  /**
   * Create a pull request after push. Records durable intent before invoking
   * `gh pr create`; an unknown outcome is reconciled against GitHub — adopted
   * on a single match, kept pending on none, and surfaced for the
   * user to pick when multiple PRs match.
   */
  async create(
    chatId: string,
    input: {
      workspaceId: string;
      title: string;
      body?: string;
      baseBranch: string;
      headBranch: string;
      expectedHeadSha?: string;
      repository?: string;
      draft?: boolean;
    },
  ): Promise<ChatPullRequestCreateResult> {
    const expectedSha = parseExpectedHeadSha(input.expectedHeadSha);
    const repository = parsePullRequestRepository(input.repository);
    const folderPath = await this.deps.workspaceFolderPath(input.workspaceId);
    if (!folderPath) {
      return {
        kind: "failed",
        message: "This workspace has no accessible folder.",
      };
    }
    const repo = await this.deps.github.resolveRepository(
      folderPath,
      undefined,
      repository,
    );
    if (repo.availability !== "ready" || !repo.repository) {
      return {
        kind: "failed",
        message:
          repo.message ??
          "This workspace's remote repository could not be identified on GitHub.",
      };
    }
    const intent: ChatPullRequestCreateIntent = {
      operationId: randomUUID(),
      host: repo.repository.host,
      repository: repo.repository.nameWithOwner,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      ...(expectedSha ? { expectedHeadSha: expectedSha } : {}),
      title: input.title,
      requestedAt: Date.now(),
    };
    let recordedIntent: ChatPullRequestCreateIntent;
    try {
      recordedIntent = await this.deps.store.recordCreateIntent(chatId, intent);
    } catch (error) {
      return {
        kind: "failed",
        message:
          error instanceof Error
            ? error.message
            : "The pull request creation intent could not be recorded.",
      };
    }
    const result = await this.deps.github.createPullRequest(folderPath, {
      title: input.title,
      body: input.body,
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      draft: input.draft,
      repository: `${recordedIntent.host}/${recordedIntent.repository}`,
    });
    if (result.kind === "created") {
      if (!matchesCreateIntent(recordedIntent, result.pullRequest)) {
        return {
          kind: "pending",
          message:
            "The created pull request no longer matches the recorded intent. Refresh to reconcile it.",
        };
      }
      const linked = await this.linkSummary(
        chatId,
        result.pullRequest,
        "created",
        recordedIntent.operationId,
      );
      return linked.ok
        ? { kind: "created", pullRequest: linked.pullRequest }
        : { kind: "failed", message: linked.message };
    }
    if (result.kind === "failed") {
      await this.deps.store.clearCreateIntent(
        chatId,
        recordedIntent.operationId,
      );
      return { kind: "failed", message: result.message };
    }
    return this.reconcileIntent(
      chatId,
      folderPath,
      recordedIntent,
      result.message,
    );
  }

  /** Reconcile one pending intent; returns the same vocabulary as `create`. */
  private async reconcileIntent(
    chatId: string,
    cwd: string,
    intent: ChatPullRequestCreateIntent,
    cause: string,
  ): Promise<ChatPullRequestCreateResult> {
    const outcome = await reconcilePullRequestCreate({
      github: this.deps.github,
      cwd,
      intent,
    });
    switch (outcome.kind) {
      case "adopted": {
        const linked = await this.linkSummary(
          chatId,
          outcome.pullRequest,
          "created",
          intent.operationId,
        );
        return linked.ok
          ? { kind: "created", pullRequest: linked.pullRequest }
          : { kind: "failed", message: linked.message };
      }
      case "none":
        // A lagging list read or a retargeted PR cannot prove non-creation.
        return {
          kind: "pending",
          message:
            cause ||
            "GitHub has not exposed a matching pull request yet. The creation remains pending; refresh or check GitHub before retrying.",
        };
      case "multiple":
        return { kind: "ambiguous", candidates: outcome.candidates };
      case "unavailable":
        return { kind: "pending", message: outcome.message };
    }
  }

  /** Explicit user resolution after checking GitHub; never a remote mutation. */
  async dismissPending(chatId: string, operationId: string): Promise<void> {
    await this.deps.store.clearCreateIntent(chatId, operationId);
    this.notify(chatId);
  }

  /** Pending create intents + ambiguous candidates for the renderer to surface. */
  async pendingCreates(
    chatId: string,
  ): Promise<ChatPullRequestPendingIntent[]> {
    const intents = await this.deps.store.listCreateIntents(chatId);
    return intents.map((intent) => ({ intent }));
  }

  /**
   * Adopt one candidate after an ambiguous reconciliation. `operationId` scopes
   * the choice to the recorded intent; the chosen ref is linked and the intent
   * cleared.
   */
  async adoptCandidate(
    chatId: string,
    operationId: string,
    ref: ChatPullRequestRef,
  ): Promise<ChatPullRequestLinkResult> {
    const intents = await this.deps.store.listCreateIntents(chatId);
    const intent = intents.find((entry) => entry.operationId === operationId);
    if (!intent) {
      return {
        ok: false,
        message: "The pull request creation is no longer pending.",
      };
    }
    if (!intentMatchesRef(intent, ref)) {
      return {
        ok: false,
        message: "That pull request is not in the pending create's repository.",
      };
    }
    // Re-fetch and prove the chosen PR is the recorded create — repository and
    // head/base branches, plus the expected head SHA when one was captured —
    // before the durable intent is cleared.
    const cwd = await this.cwdFor(chatId);
    const status = await this.deps.github.getPullRequest(
      cwd,
      repoSelector(ref.host, ref.repository),
      ref.number,
    );
    if (status.availability !== "ready" || !status.pullRequest) {
      return {
        ok: false,
        message:
          status.message ?? "The pull request could not be read from GitHub.",
      };
    }
    if (!matchesCreateIntent(intent, status.pullRequest)) {
      return {
        ok: false,
        message: "That pull request does not match the pending create.",
      };
    }
    const linked = await this.linkSummary(
      chatId,
      status.pullRequest,
      "created",
      operationId,
    );
    return linked;
  }

  /**
   * Re-drive every recorded intent, e.g. after restart. `resolveFolderPath`
   * supplies a cwd the branch lookup can run in — without a workspace folder
   * the intents stay pending rather than being guessed at.
   */
  async reconcilePending(
    chatId: string,
  ): Promise<ChatPullRequestPendingIntent[]> {
    const intents = await this.deps.store.listCreateIntents(chatId);
    if (intents.length === 0) return [];
    const cwd = await this.cwdFor(chatId);
    const resolved = new Map<string, ChatPullRequestCreateResult>();
    for (const intent of intents) {
      resolved.set(
        intent.operationId,
        await this.reconcileIntent(chatId, cwd, intent, ""),
      );
    }
    // Only intents still recorded (ambiguous/unavailable) survive reconcile;
    // attach their candidates so the renderer can offer "Use this PR".
    const remaining = await this.deps.store.listCreateIntents(chatId);
    return remaining.map((intent) => {
      const result = resolved.get(intent.operationId);
      return result?.kind === "ambiguous"
        ? { intent, candidates: result.candidates }
        : { intent };
    });
  }

  /** Chat deletion: drop the whole link file. Never calls GitHub. */
  async deleteChat(chatId: string): Promise<void> {
    if (!isSafeChatPullRequestChatId(chatId)) return;
    await this.deps.store.deleteChat(chatId);
  }
}
