// Chat ↔ pull request orchestration: URL linking, chooser linking, post-push
// detection, `gh pr create` with durable unknown-outcome reconciliation, and
// the delete/unlink guarantee that nothing here mutates GitHub.

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatPullRequestCreateIntent } from "../../renderer/shared/chat-pull-requests.js";
import {
  ChatPullRequestService,
  type ChatPullRequestServiceDeps,
} from "./chat-pull-request-service.js";
import { ChatPullRequestStore } from "./chat-pull-request-store.js";
import type {
  GitHubPullRequestCreateResult,
  GitHubPullRequestListStatus,
  GitHubPullRequestStatus,
  GitHubPullRequestSummary,
  GitHubRepositoryStatus,
} from "./types.js";

const CHAT = "chat-test-1";
const REPO = "owner/repo";

interface FakeCalls {
  resolveRepository: number;
  getPullRequest: number;
  getPullRequestByUrl: number;
  findForBranch: number;
  listPullRequests: number;
  createPullRequest: number;
  currentPullRequest: number;
}

function summary(
  number: number,
  overrides: Partial<GitHubPullRequestSummary> = {},
) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/${REPO}/pull/${number}`,
    state: "open" as const,
    headBranch: "feature/x",
    baseBranch: "main",
    checksState: "passing" as const,
    checks: [],
    ...overrides,
  };
}

function ready<T extends Record<string, unknown>>(value: T) {
  return { availability: "ready" as const, ...value };
}

function fakeService(
  directory: string,
  github: Partial<
    Record<keyof FakeCalls, (...args: never[]) => Promise<unknown>>
  > = {},
  options: {
    workspaceFolderPath?: string | undefined;
    chatWorkspaceId?: string | undefined;
    branch?: string | undefined;
    onChanged?: (chatId: string) => void;
  } = {},
) {
  const calls: FakeCalls = {
    resolveRepository: 0,
    getPullRequest: 0,
    getPullRequestByUrl: 0,
    findForBranch: 0,
    listPullRequests: 0,
    createPullRequest: 0,
    currentPullRequest: 0,
  };
  const call =
    <T>(name: keyof FakeCalls, fallback: T) =>
    async (...args: never[]): Promise<T> => {
      calls[name] += 1;
      const impl = github[name];
      return (impl ? await impl(...args) : fallback) as T;
    };
  const deps: ChatPullRequestServiceDeps = {
    store: new ChatPullRequestStore(() => directory),
    github: {
      resolveRepository: call<GitHubRepositoryStatus>("resolveRepository", {
        availability: "ready",
        repository: { host: "github.com", nameWithOwner: REPO },
      }),
      getPullRequest: call<GitHubPullRequestStatus>("getPullRequest", {
        availability: "no-pull-request",
      }),
      getPullRequestByUrl: call<GitHubPullRequestStatus>(
        "getPullRequestByUrl",
        {
          availability: "no-pull-request",
        },
      ),
      findForBranch: call<GitHubPullRequestListStatus>("findForBranch", {
        availability: "ready",
        pullRequests: [],
      }),
      listPullRequests: call<GitHubPullRequestListStatus>("listPullRequests", {
        availability: "ready",
        pullRequests: [],
      }),
      createPullRequest: call<GitHubPullRequestCreateResult>(
        "createPullRequest",
        {
          kind: "failed",
          availability: "error",
          message: "not configured",
        },
      ),
      currentPullRequest: call<GitHubPullRequestStatus>("currentPullRequest", {
        availability: "no-pull-request",
      }),
    },
    gitInfo: async () => ({
      isRepo: true,
      ...(options.branch !== undefined
        ? { branch: options.branch }
        : { branch: "feature/x" }),
    }),
    chatWorkspaceId: async () => options.chatWorkspaceId ?? "workspace-1",
    workspaceFolderPath: async () =>
      options.workspaceFolderPath === undefined
        ? "/work/repo"
        : options.workspaceFolderPath,
    onChanged: options.onChanged,
  };
  return { service: new ChatPullRequestService(deps), calls, deps };
}

test("link resolves canonical identity through gh and stores it", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service, calls } = fakeService(directory, {
    getPullRequestByUrl: async () =>
      ready({ pullRequest: summary(12) }) as GitHubPullRequestStatus,
  });

  const result = await service.link(CHAT, {
    url: "https://github.com/Owner/Repo/pull/12",
  });
  assert.equal(result.ok, true);
  assert.equal(calls.getPullRequestByUrl, 1);
  if (result.ok) {
    assert.equal(result.pullRequest.repository, REPO);
    assert.equal(result.pullRequest.state, "open");
    assert.equal(result.pullRequest.checksState, "passing");
  }
  const links = await service.list(CHAT);
  assert.equal(links.links.length, 1);
  assert.equal(links.links[0]?.source, "manual");
});

test("link rejects a non-pull-request URL without calling GitHub", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service, calls } = fakeService(directory);
  const result = await service.link(CHAT, {
    url: "https://example.com/not-a-pr",
  });
  assert.equal(result.ok, false);
  assert.equal(calls.getPullRequestByUrl, 0);
});

test("linking the same PR twice deduplicates; unlink removes it", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service } = fakeService(directory, {
    getPullRequestByUrl: async () =>
      ready({ pullRequest: summary(12) }) as GitHubPullRequestStatus,
  });
  const url = "https://github.com/owner/repo/pull/12";
  assert.equal((await service.link(CHAT, { url })).ok, true);
  assert.equal((await service.link(CHAT, { url })).ok, true);
  assert.equal((await service.list(CHAT)).links.length, 1);

  const ref = { host: "github.com", repository: REPO, number: 12 };
  assert.deepEqual(await service.unlink(CHAT, ref), { ok: true });
  assert.deepEqual(await service.unlink(CHAT, ref), { ok: false });
});

test("detectAfterPush offers unlinked open PRs and refreshes linked ones", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let found: GitHubPullRequestSummary[] = [summary(41, { title: "Old title" })];
  const { service } = fakeService(directory, {
    getPullRequestByUrl: async () =>
      ready({ pullRequest: summary(41) }) as GitHubPullRequestStatus,
    findForBranch: async () =>
      ready({ pullRequests: found }) as GitHubPullRequestListStatus,
  });
  await service.link(CHAT, { url: "https://github.com/owner/repo/pull/41" });

  // Pushed head matches a linked PR → snapshot refreshed, not offered again.
  found = [summary(41, { title: "New title" })];
  const detected = await service.detectAfterPush(CHAT, {
    workspaceId: "workspace-1",
    headBranch: "feature/x",
  });
  assert.equal(detected.availability, "ready");
  assert.equal(detected.matches.length, 0);
  assert.equal(detected.refreshed.length, 1);
  assert.equal((await service.list(CHAT)).links[0]?.title, "New title");

  // A sibling open PR on the same branch is offered for linking.
  found = [summary(41), summary(42)];
  const second = await service.detectAfterPush(CHAT, {
    workspaceId: "workspace-1",
    headBranch: "feature/x",
  });
  assert.equal(second.matches.length, 1);
  assert.equal(second.matches[0]?.number, 42);
  assert.equal(second.refreshed.length, 1);
});

test("detectAfterPush on a branch with no PR returns an empty match list", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service } = fakeService(directory);
  const detected = await service.detectAfterPush(CHAT, {
    workspaceId: "workspace-1",
    headBranch: "feature/x",
  });
  assert.equal(detected.availability, "ready");
  assert.deepEqual(detected.matches, []);
});

test("a successful create links the new PR and records no pending intent", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service } = fakeService(directory, {
    createPullRequest: async () =>
      ({
        kind: "created",
        pullRequest: summary(50, { isDraft: true }),
      }) as GitHubPullRequestCreateResult,
  });
  const result = await service.create(CHAT, {
    workspaceId: "workspace-1",
    title: "New work",
    baseBranch: "main",
    headBranch: "feature/x",
    draft: true,
  });
  assert.equal(result.kind, "created");
  const links = (await service.list(CHAT)).links;
  assert.equal(links.length, 1);
  assert.equal(links[0]?.source, "created");
  assert.equal(links[0]?.isDraft, true);
  assert.deepEqual(await service.pendingCreates(CHAT), []);
});

test("an unknown create outcome with one match adopts it — never a blind retry", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service, calls } = fakeService(directory, {
    createPullRequest: async () =>
      ({
        kind: "unknown",
        message: "timed out",
      }) as GitHubPullRequestCreateResult,
    findForBranch: async () =>
      ready({ pullRequests: [summary(77)] }) as GitHubPullRequestListStatus,
  });
  const result = await service.create(CHAT, {
    workspaceId: "workspace-1",
    title: "New work",
    baseBranch: "main",
    headBranch: "feature/x",
  });
  assert.equal(result.kind, "created");
  assert.equal(calls.createPullRequest, 1);
  const links = (await service.list(CHAT)).links;
  assert.equal(links[0]?.number, 77);
  assert.equal(links[0]?.source, "created");
});

test("an unknown outcome with zero matches stays pending instead of allowing a duplicate retry", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service } = fakeService(directory, {
    createPullRequest: async () =>
      ({
        kind: "unknown",
        message: "timed out",
      }) as GitHubPullRequestCreateResult,
    findForBranch: async () =>
      ready({ pullRequests: [] }) as GitHubPullRequestListStatus,
  });
  const result = await service.create(CHAT, {
    workspaceId: "workspace-1",
    title: "New work",
    baseBranch: "main",
    headBranch: "feature/x",
  });
  assert.equal(result.kind, "pending");
  assert.equal((await service.pendingCreates(CHAT)).length, 1);
});

test("an unknown outcome with several matches is ambiguous and keeps the intent", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service } = fakeService(directory, {
    createPullRequest: async () =>
      ({
        kind: "unknown",
        message: "timed out",
      }) as GitHubPullRequestCreateResult,
    findForBranch: async () =>
      ready({
        pullRequests: [summary(1), summary(2)],
      }) as GitHubPullRequestListStatus,
    getPullRequest: async () =>
      ready({ pullRequest: summary(2) }) as GitHubPullRequestStatus,
  });
  const result = await service.create(CHAT, {
    workspaceId: "workspace-1",
    title: "New work",
    baseBranch: "main",
    headBranch: "feature/x",
  });
  assert.equal(result.kind, "ambiguous");
  if (result.kind === "ambiguous") assert.equal(result.candidates.length, 2);
  // Re-driving the pending intent keeps it ambiguous and returns candidates.
  const pending = await service.reconcilePending(CHAT);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.candidates?.length, 2);

  // Adopting a candidate links it and clears the intent.
  const adopted = await service.adoptCandidate(
    CHAT,
    pending[0]!.intent.operationId,
    {
      host: "github.com",
      repository: REPO,
      number: 2,
    },
  );
  assert.equal(adopted.ok, true);
  assert.deepEqual(await service.pendingCreates(CHAT), []);
  assert.equal((await service.list(CHAT)).links[0]?.number, 2);
});

test("adopting a candidate outside the intent is rejected and keeps it pending", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service, calls } = fakeService(directory, {
    createPullRequest: async () =>
      ({
        kind: "unknown",
        message: "timed out",
      }) as GitHubPullRequestCreateResult,
    findForBranch: async () =>
      ready({
        pullRequests: [summary(1), summary(2)],
      }) as GitHubPullRequestListStatus,
    // The fetched PR does not match the recorded intent (wrong head branch).
    getPullRequest: async () =>
      ready({
        pullRequest: summary(2, { headBranch: "other" }),
      }) as GitHubPullRequestStatus,
  });
  await service.create(CHAT, {
    workspaceId: "workspace-1",
    title: "New work",
    baseBranch: "main",
    headBranch: "feature/x",
  });
  const pending = await service.pendingCreates(CHAT);
  const operationId = pending[0]!.intent.operationId;

  // A ref outside the intent's repository never reaches GitHub.
  const foreign = await service.adoptCandidate(CHAT, operationId, {
    host: "github.com",
    repository: "other/repo",
    number: 2,
  });
  assert.equal(foreign.ok, false);
  assert.equal(calls.getPullRequest, 0);

  // A fetched summary that contradicts the intent is refused; intent survives.
  const mismatched = await service.adoptCandidate(CHAT, operationId, {
    host: "github.com",
    repository: REPO,
    number: 2,
  });
  assert.equal(mismatched.ok, false);
  assert.equal((await service.pendingCreates(CHAT)).length, 1);
});

test("detectAfterPush only offers PRs whose head matches the pushed commit", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service } = fakeService(directory, {
    findForBranch: async () =>
      ready({
        pullRequests: [
          summary(41, { headSha: "b".repeat(40) }),
          summary(42, { headSha: "a".repeat(40) }),
        ],
      }) as GitHubPullRequestListStatus,
  });
  const detected = await service.detectAfterPush(CHAT, {
    workspaceId: "workspace-1",
    headBranch: "feature/x",
    expectedHeadSha: "a".repeat(40),
  });
  assert.deepEqual(
    detected.matches.map((view) => view.number),
    [42],
  );
});

test("a create lost across restart reconciles on the next pending pass", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  // First session: `gh pr create` outcome never makes it back (crash before
  // reconcile). Simulate by recording the intent directly, as the crash
  // boundary leaves it.
  const intent: ChatPullRequestCreateIntent = {
    operationId: "op-crash",
    host: "github.com",
    repository: REPO,
    headBranch: "feature/x",
    baseBranch: "main",
    expectedHeadSha: "a".repeat(40),
    title: "New work",
    requestedAt: 1_700,
  };
  const first = new ChatPullRequestStore(() => directory);
  await first.recordCreateIntent(CHAT, intent);

  // "Restart": a fresh service over the same store reconciles and adopts the
  // PR GitHub did create — without issuing another create.
  const { service, calls } = fakeService(directory, {
    findForBranch: async () =>
      ready({
        pullRequests: [summary(88, { headSha: "a".repeat(40) })],
      }) as GitHubPullRequestListStatus,
  });
  const pending = await service.reconcilePending(CHAT);
  assert.equal(calls.createPullRequest, 0);
  assert.deepEqual(pending, []);
  const links = (await service.list(CHAT)).links;
  assert.equal(links.length, 1);
  assert.equal(links[0]?.number, 88);
  assert.equal(links[0]?.source, "created");
});

test("unavailable reconciliation keeps the intent pending", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service } = fakeService(directory, {
    createPullRequest: async () =>
      ({ kind: "unknown", message: "killed" }) as GitHubPullRequestCreateResult,
    findForBranch: async () =>
      ({
        availability: "unauthenticated",
        message: "gh auth login required",
      }) as GitHubPullRequestListStatus,
  });
  const result = await service.create(CHAT, {
    workspaceId: "workspace-1",
    title: "New work",
    baseBranch: "main",
    headBranch: "feature/x",
  });
  assert.equal(result.kind, "pending");
  assert.equal((await service.pendingCreates(CHAT)).length, 1);
});

test("current resolves through the precedence model with workspace context", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service } = fakeService(directory, {
    getPullRequestByUrl: async () =>
      ready({
        pullRequest: summary(12, { headBranch: "other" }),
      }) as GitHubPullRequestStatus,
    currentPullRequest: async () =>
      ready({ pullRequest: summary(9) }) as GitHubPullRequestStatus,
  });
  // Discovered workspace PR wins when nothing is linked.
  const discovered = await service.current(CHAT);
  assert.equal(discovered.reason, "discovered");
  assert.equal(discovered.pullRequest?.linked, false);

  await service.link(CHAT, { url: "https://github.com/owner/repo/pull/12" });
  const current = await service.current(CHAT);
  assert.equal(current.reason, "recent-open");
  assert.equal(current.pullRequest?.linked, true);
});

test("deleteChat removes the link file and never calls GitHub", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service, calls } = fakeService(directory, {
    getPullRequestByUrl: async () =>
      ready({ pullRequest: summary(12) }) as GitHubPullRequestStatus,
  });
  await service.link(CHAT, { url: "https://github.com/owner/repo/pull/12" });
  const callsBefore = { ...calls };
  await service.deleteChat(CHAT);
  assert.deepEqual(await readdir(directory), []);
  assert.deepEqual(calls, callsBefore);
});

test("detectAfterPush treats an unreadable head SHA as unverifiable, not absent", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service } = fakeService(directory, {
    findForBranch: async () =>
      ready({
        pullRequests: [summary(41, { headSha: undefined })],
      }) as GitHubPullRequestListStatus,
  });
  const detected = await service.detectAfterPush(CHAT, {
    workspaceId: "workspace-1",
    headBranch: "feature/x",
    expectedHeadSha: "a".repeat(40),
  });
  // The unreadable PR could be the pushed result: no "No pull request exists"
  // ready state and no Create affordance may be offered.
  assert.equal(detected.availability, "error");
  assert.equal(detected.matches.length, 0);
  assert.match(detected.message ?? "", /head commit could not be read/);
});

test("an unknown create reconciles against the normalized intent SHA", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service } = fakeService(directory, {
    createPullRequest: async () =>
      ({ kind: "unknown", message: "killed" }) as GitHubPullRequestCreateResult,
    findForBranch: async () =>
      ready({
        pullRequests: [summary(88, { headSha: "a".repeat(40) })],
      }) as GitHubPullRequestListStatus,
  });
  const result = await service.create(CHAT, {
    workspaceId: "workspace-1",
    title: "New work",
    baseBranch: "main",
    headBranch: "feature/x",
    // Renderer supplied the SHA uppercase; the persisted intent lowercases it,
    // and reconciliation must compare that canonical copy.
    expectedHeadSha: "A".repeat(40),
  });
  assert.equal(result.kind, "created");
  if (result.kind === "created") assert.equal(result.pullRequest.number, 88);
  assert.equal((await service.pendingCreates(CHAT)).length, 0);
});

test("invalid supplied SHA cannot start detection or creation", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service, calls } = fakeService(directory);
  for (const expectedHeadSha of ["invalid", "", "a".repeat(65), " aaaa"]) {
    const input = {
      workspaceId: "workspace-1",
      headBranch: "feature/x",
      expectedHeadSha,
    };
    await assert.rejects(
      service.detectAfterPush(CHAT, input),
      /expectedHeadSha/,
    );
    await assert.rejects(
      service.create(CHAT, { ...input, title: "Title", baseBranch: "main" }),
      /expectedHeadSha/,
    );
  }
  assert.equal(calls.findForBranch, 0);
  assert.equal(calls.createPullRequest, 0);
  assert.deepEqual(await service.pendingCreates(CHAT), []);
});

test("failed link publication retains the successful create intent for restart", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service, deps } = fakeService(directory, {
    createPullRequest: async () => ({
      kind: "created",
      pullRequest: summary(12),
    }),
  });
  deps.store.link = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(
    service.create(CHAT, {
      workspaceId: "workspace-1",
      headBranch: "feature/x",
      baseBranch: "main",
      title: "Title",
    }),
    /disk full/,
  );
  assert.equal(
    (await new ChatPullRequestStore(() => directory).listCreateIntents(CHAT))
      .length,
    1,
  );
});

test("unlink survives restart and suppresses automatic current-PR discovery until explicitly relinked", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const github = {
    getPullRequestByUrl: async () => ready({ pullRequest: summary(12) }),
    currentPullRequest: async () => ready({ pullRequest: summary(12) }),
  };
  const { service } = fakeService(directory, github);
  await service.link(CHAT, { url: summary(12).url });
  await service.unlink(CHAT, {
    host: "github.com",
    repository: REPO,
    number: 12,
  });
  const restarted = fakeService(directory, github).service;
  assert.equal((await restarted.current(CHAT)).reason, "none");
  assert.deepEqual((await restarted.list(CHAT)).links, []);
  await restarted.link(CHAT, { url: summary(12).url });
  assert.equal((await restarted.current(CHAT)).pullRequest?.number, 12);
});

test("only explicit manual resolution clears an unknown create that is absent from lookup", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service, calls } = fakeService(directory, {
    createPullRequest: async () => ({
      kind: "unknown",
      message: "network error",
    }),
  });
  const input = {
    workspaceId: "workspace-1",
    headBranch: "feature/x",
    baseBranch: "main",
    title: "Title",
  };
  assert.equal((await service.create(CHAT, input)).kind, "pending");
  assert.equal((await service.create(CHAT, input)).kind, "failed");
  assert.equal(calls.createPullRequest, 1);
  const [pending] = await service.pendingCreates(CHAT);
  await service.dismissPending(CHAT, pending.intent.operationId);
  assert.deepEqual(await service.pendingCreates(CHAT), []);
  assert.equal((await service.create(CHAT, input)).kind, "pending");
  assert.equal(calls.createPullRequest, 2);
});
