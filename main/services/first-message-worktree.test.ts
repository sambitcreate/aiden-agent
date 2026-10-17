import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseChatFirstMessage } from "../handlers/chat-first-message-params.js";
import {
  createFirstMessageCommitter,
  createWorktreeFirstMessageCommitter,
} from "./chat-first-message-commit.js";
import { createChatStore } from "./chat-store-core.js";
import { ChatTurnAdmission } from "./chat-turn-admission.js";
import {
  createFileFirstMessageWorktreeLedger,
  createFirstMessageWorktreeCoordinator,
  type FirstMessageWorktreeLedger,
} from "./first-message-worktree.js";
import { GitService } from "./git.js";
import type { Workspace } from "./types.js";
import type { RegisteredSkill } from "./skill-registry.js";
import { WorkspaceOperationRegistry, admitOwnedWorkspaceOperation } from "./workspace-operation-registry.js";
import { createWorkspaceWorktreeApplicationService } from "./workspace-worktree-application-service.js";
import type { FirstMessageWorktreeProgress } from "../../renderer/shared/worktree-on-send.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" },
  });
  return String(result.stdout).trim();
}

async function temporaryDirectory(t: test.TestContext, prefix = "aiden-wt-send-"): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  return directory;
}

async function commit(cwd: string, file: string, contents: string, message: string): Promise<string> {
  await fs.writeFile(path.join(cwd, file), contents, "utf8");
  await git(cwd, ["add", file]);
  await git(cwd, ["-c", "core.hooksPath=/dev/null", "commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** A bare `origin` and a clone of it (`repository`) on `main`, with a hook probe installed. */
async function repositories(t: test.TestContext) {
  const root = await temporaryDirectory(t);
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const repository = path.join(root, "repository");
  await git(root, ["init", "--bare", "--initial-branch=main", origin]);
  await git(root, ["init", "--initial-branch=main", seed]);
  for (const cwd of [seed]) {
    await git(cwd, ["config", "user.email", "aiden@example.test"]);
    await git(cwd, ["config", "user.name", "Aiden Test"]);
  }
  await commit(seed, "README.md", "initial\n", "Initial commit");
  await git(seed, ["remote", "add", "origin", origin]);
  await git(seed, ["-c", "core.hooksPath=/dev/null", "push", "origin", "main"]);
  await git(root, ["-c", "core.hooksPath=/dev/null", "clone", origin, repository]);
  await git(repository, ["config", "user.email", "aiden@example.test"]);
  await git(repository, ["config", "user.name", "Aiden Test"]);
  const marker = path.join(root, "hook-ran");
  for (const hook of ["post-checkout", "reference-transaction", "post-merge"]) {
    await fs.writeFile(
      path.join(repository, ".git", "hooks", hook),
      `#!/bin/sh\necho ${hook} >> ${JSON.stringify(marker)}\n`,
      { mode: 0o755 },
    );
  }
  return { root, origin, seed, repository, marker };
}

function documentOwner() {
  let destroyed = false;
  const listeners = new Set<() => void>();
  return {
    documentId: randomUUID(),
    isDestroyed: () => destroyed,
    onInvalidated: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    invalidate: () => {
      destroyed = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** The real managed-worktree service over a real GitService, with an in-memory workspace list. */
async function harness(
  t: test.TestContext,
  repository: string,
  options: {
    ledger?: (file: string) => FirstMessageWorktreeLedger;
    resolveSkill?: (workspaceId: string, invocationId: string) => Promise<RegisteredSkill>;
  } = {},
) {
  const userData = await temporaryDirectory(t, "aiden-wt-send-data-");
  const worktreeRoot = path.join(userData, "worktrees");
  const service = new GitService({ cacheTtlMs: 0 });
  const workspaces = new Map<string, Workspace>();
  const source: Workspace = {
    id: "workspace-source",
    name: "Repository",
    folderPath: repository,
    permission: "ask",
    createdAt: 1,
    updatedAt: 1,
  };
  workspaces.set(source.id, source);
  // The same folder registered again, for a draft that moves workspace.
  workspaces.set("workspace-other", { ...source, id: "workspace-other", name: "Other" });
  let nextWorkspace = 0;
  const createCalls: string[] = [];
  const resolve = async (id: string) => {
    const workspace = workspaces.get(id);
    if (!workspace?.folderPath) throw new Error(`Workspace ${id} was not found.`);
    if (workspace.permission === "none") throw new Error(`${workspace.name} does not allow local file access.`);
    return { folderPath: await fs.realpath(workspace.folderPath), workspace };
  };
  const worktrees = createWorkspaceWorktreeApplicationService({
    environment: {
      resolve,
      run: async (owner, id, operation) => {
        const controller = new AbortController();
        const detach = owner.onInvalidated(() => controller.abort());
        try {
          return await operation(await resolve(id), controller.signal);
        } finally {
          detach();
        }
      },
      runRecord: async () => { throw new Error("unexpected runRecord"); },
    },
    ensureWorktreeRoot: async () => {
      await fs.mkdir(worktreeRoot, { recursive: true });
      return worktreeRoot;
    },
    ensureSnapshotRoot: async () => path.join(userData, "snapshots"),
    createWorktree: (folderPath, root, branch, signal, options) => {
      createCalls.push(branch);
      return service.createWorktree(folderPath, root, branch, signal, options);
    },
    resolveWorktreeBase: (folderPath, baseRef, signal) => service.resolveWorktreeBase(folderPath, baseRef, signal),
    fetchWorktreeBase: (folderPath, upstream, signal) => service.fetchWorktreeBase(folderPath, upstream, signal),
    localBranchNames: (folderPath, signal) => service.localBranchNames(folderPath, signal),
    rollbackOwnedWorktree: (folderPath, branch, token, head) => service.rollbackOwnedWorktree(folderPath, branch, token, head),
    rollbackWorktree: (folderPath, created, options) => service.rollbackWorktree(folderPath, created, options),
    deleteManagedWorktree: async () => { throw new Error("unexpected delete"); },
    managedWorktreeDeletionPending: async () => false,
    managedWorktreeRegistered: async () => false,
    managedWorktreeUsable: async () => false,
    finalizeManagedWorktreeDeletion: async () => undefined,
    workspacePathExists: async () => false,
    checkoutBytes: (folderPath, commitish) => service.managedWorktreeCheckoutBytes(folderPath, commitish),
    checkCreateCapacity: async () => undefined,
    checkWorktreeAllocation: async () => undefined,
    checkSnapshotCapacity: async () => undefined,
    provisionIncludedFiles: async () => [],
    repositoryPaths: (folderPath) => service.repositoryPaths(folderPath),
    dirtyState: async () => { throw new Error("unexpected dirty state"); },
    expandIgnoredPaths: async () => [],
    snapshotContentBytes: async () => 0,
    captureWorktreeSnapshot: async () => { throw new Error("unexpected snapshot"); },
    snapshotRefCommit: async () => undefined,
    deleteSnapshotRef: async () => true,
    restoreManagedCheckout: async () => { throw new Error("unexpected restore"); },
    applyWorktreeSnapshot: async () => undefined,
    resumeManagedCheckout: async () => { throw new Error("unexpected resume"); },
    saveWorkspace: async (workspace) => {
      workspaces.set(workspace.id, workspace);
      return workspace;
    },
    removeWorkspace: async (id) => { workspaces.delete(id); },
    beginWorkspaceMutation: () => () => undefined,
    workspaceIsChanging: () => false,
    cancelWorkspaceOperations: async () => undefined,
    closeWorkspaceTerminals: async () => undefined,
    cancelWorkspaceGeneration: async () => undefined,
    cancelWorkspaceSchedules: async () => undefined,
    resumeWorkspaceSchedules: async () => undefined,
    createWorkspaceId: () => `workspace-worktree-${++nextWorkspace}`,
    now: () => 5,
    notifyChanged: () => undefined,
    logError: () => undefined,
  });
  const ledgerFile = path.join(userData, "first-message-worktrees.json");
  const coordinatorFor = (ledger: FirstMessageWorktreeLedger) => createFirstMessageWorktreeCoordinator({
    ledger,
    createFromBase: (owner, id, request) => worktrees.createFromBase(owner, id, request),
    discardInterruptedWorktree: (owner, id, attempt) => worktrees.discardInterruptedWorktree(owner, id, attempt),
    getWorkspace: async (id) => workspaces.get(id),
  });
  const fileLedger = () => createFileFirstMessageWorktreeLedger({ filePath: async () => ledgerFile });
  const coordinator = coordinatorFor(options.ledger?.(ledgerFile) ?? fileLedger());
  const resolveSkill = options.resolveSkill ?? (async () => { throw new Error("Skill is unavailable"); });

  const chatDirectory = path.join(userData, "chats");
  await fs.mkdir(chatDirectory);
  const store = createChatStore(async () => chatDirectory);
  const turns = new ChatTurnAdmission();
  const registry = new WorkspaceOperationRegistry();
  const commitPlain = createFirstMessageCommitter({
    store,
    beginTurn: (chatId, turnId, ownerId) => turns.tryBegin(chatId, turnId, ownerId, false),
    requiresReconciliation: (ownerId) => turns.requiresAppendReconciliation(ownerId),
    markReconciliation: (ownerId) => turns.markAppendReconciliationRequired(ownerId),
    clearReconciliation: (ownerId) => turns.clearAppendReconciliationRequired(ownerId),
    admitWorkspace: (workspaceId, document) => admitOwnedWorkspaceOperation(registry, document, workspaceId),
    workspaceExists: async (workspaceId) => workspaces.has(workspaceId),
    resolveSkill,
  });
  const commitInWorktree = createWorktreeFirstMessageCommitter({
    commit: commitPlain,
    ensureWorktree: (request, seed, owner, onProgress) => coordinator.ensure(request, seed, owner, onProgress),
    resolveSkill,
  });
  const owner = documentOwner();
  t.after(() => owner.invalidate());
  return {
    service, worktrees, workspaces, source, coordinator, coordinatorFor, fileLedger, ledgerFile, store, turns,
    commitInWorktree, owner, createCalls, worktreeRoot,
  };
}

let nextTurn = 0;
function firstMessage(content: string, worktree: Record<string, unknown>, draftId = randomUUID()) {
  return {
    draftId,
    workspaceId: "workspace-source",
    providerId: "openai",
    model: "test-model",
    turnId: `turn-${++nextTurn}`,
    message: { role: "user", content },
    worktree: { sourceWorkspaceId: "workspace-source", idempotencyKey: draftId, ...worktree },
  };
}

async function branchOf(worktreePath: string): Promise<string> {
  return git(worktreePath, ["symbolic-ref", "--short", "HEAD"]);
}

test("a worktree from a local base starts at that base, not the checkout's HEAD, and runs no hooks", async (t) => {
  const repos = await repositories(t);
  const mainCommit = await git(repos.repository, ["rev-parse", "main"]);
  await git(repos.repository, ["-c", "core.hooksPath=/dev/null", "switch", "-c", "feature"]);
  await commit(repos.repository, "feature.txt", "feature\n", "Feature work");
  const h = await harness(t, repos.repository);

  const result = await h.worktrees.createFromBase(h.owner, h.source.id, {
    baseRef: "main",
    fromOrigin: false,
    autoName: { seed: "Fix the Login redirect on Safari!" },
  });

  assert.equal(result.branch, "aiden/fix-the-login-redirect-on-safari");
  assert.equal(result.baseSource, "local");
  assert.equal(result.startPoint, "main");
  assert.equal(result.baseCommit, mainCommit);
  const worktreePath = result.workspace.managedWorktree!.worktreePath;
  assert.equal(await git(worktreePath, ["rev-parse", "HEAD"]), mainCommit);
  assert.equal(await branchOf(worktreePath), "aiden/fix-the-login-redirect-on-safari");
  await assert.rejects(fs.access(path.join(worktreePath, "feature.txt")));
  // The source checkout stays where it was.
  assert.equal(await branchOf(repos.repository), "feature");
  await assert.rejects(fs.readFile(repos.marker, "utf8"), { code: "ENOENT" });
  // The existing create path (explicit name, from HEAD) is unchanged.
  const plain = await h.worktrees.create(h.owner, h.source.id, "manual/from-head");
  assert.equal(
    await git(plain.managedWorktree!.worktreePath, ["rev-parse", "HEAD"]),
    await git(repos.repository, ["rev-parse", "HEAD"]),
  );
});

test("from origin fetches only the base branch and starts at the remote commit, without hooks", async (t) => {
  const repos = await repositories(t);
  const h = await harness(t, repos.repository);
  const localMain = await git(repos.repository, ["rev-parse", "main"]);
  const remoteMain = await commit(repos.seed, "remote.txt", "remote\n", "Remote work");
  await git(repos.seed, ["-c", "core.hooksPath=/dev/null", "push", "origin", "main"]);
  await git(repos.seed, ["-c", "core.hooksPath=/dev/null", "push", "origin", "main:other"]);
  await git(repos.seed, ["tag", "v1"]);
  await git(repos.seed, ["-c", "core.hooksPath=/dev/null", "push", "origin", "v1"]);
  const progress: string[] = [];

  const result = await h.worktrees.createFromBase(h.owner, h.source.id, {
    baseRef: "main",
    fromOrigin: true,
    branchName: "aiden/explicit",
    onProgress: (event) => progress.push(`${event.phase}:${event.startPoint}`),
  });

  assert.equal(result.baseSource, "fetched");
  assert.equal(result.startPoint, "origin/main");
  assert.equal(result.baseCommit, remoteMain);
  assert.equal(result.branch, "aiden/explicit");
  assert.equal(await git(result.workspace.managedWorktree!.worktreePath, ["rev-parse", "HEAD"]), remoteMain);
  assert.deepEqual(progress, ["fetching:origin/main", "creating:origin/main"]);
  // Only main's tracking ref moved: no other branch, no tags, local main untouched.
  assert.equal(await git(repos.repository, ["rev-parse", "refs/remotes/origin/main"]), remoteMain);
  assert.equal(await git(repos.repository, ["rev-parse", "main"]), localMain);
  assert.equal(await git(repos.repository, ["for-each-ref", "refs/remotes/origin/other", "refs/tags"]), "");
  await assert.rejects(fs.readFile(repos.marker, "utf8"), { code: "ENOENT" });
});

test("from origin without an upstream falls back to the local base and says so", async (t) => {
  const repos = await repositories(t);
  await git(repos.repository, ["-c", "core.hooksPath=/dev/null", "branch", "local-only"]);
  const h = await harness(t, repos.repository);
  const result = await h.worktrees.createFromBase(h.owner, h.source.id, {
    baseRef: "local-only",
    fromOrigin: true,
    autoName: { seed: "" },
  });
  assert.equal(result.baseSource, "no-upstream");
  assert.equal(result.startPoint, "local-only");
  assert.equal(result.branch, "aiden/new-chat");
});

test("auto names avoid existing branches and invalid bases are refused before anything is created", async (t) => {
  const repos = await repositories(t);
  await git(repos.repository, ["-c", "core.hooksPath=/dev/null", "branch", "aiden/fix-login"]);
  const h = await harness(t, repos.repository);
  const first = await h.worktrees.createFromBase(h.owner, h.source.id, {
    baseRef: "main", fromOrigin: false, autoName: { seed: "Fix login" },
  });
  const second = await h.worktrees.createFromBase(h.owner, h.source.id, {
    baseRef: "origin/main", fromOrigin: false, autoName: { seed: "fix   LOGIN" },
  });
  assert.equal(first.branch, "aiden/fix-login-2");
  assert.equal(second.branch, "aiden/fix-login-3");
  assert.equal(second.startPoint, "origin/main");

  for (const baseRef of ["does-not-exist", "-main", "main..x", "refs/heads/main"]) {
    await assert.rejects(
      h.worktrees.createFromBase(h.owner, h.source.id, { baseRef, fromOrigin: false, autoName: { seed: "x" } }),
      /branch/iu,
      baseRef,
    );
  }
  await assert.rejects(
    h.worktrees.createFromBase(h.owner, h.source.id, { baseRef: "main", fromOrigin: false, branchName: "aiden/fix-login" }),
    /already exists/u,
  );
  // An existing explicit name is refused before Git is asked to create anything.
  assert.deepEqual(h.createCalls, ["aiden/fix-login-2", "aiden/fix-login-3"]);
  assert.equal([...h.workspaces.values()].filter((workspace) => workspace.managedWorktree).length, 2);
});

test("first send in New worktree saves the chat in the new worktree workspace", async (t) => {
  const repos = await repositories(t);
  const h = await harness(t, repos.repository);
  const progress: FirstMessageWorktreeProgress[] = [];
  const input = firstMessage("Fix the login redirect", { baseRef: "main", fromOrigin: true });

  const result = await h.commitInWorktree(parseChatFirstMessage(input), h.owner, (event) => progress.push(event));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const workspace = h.workspaces.get(result.worktree.workspaceId);
  assert.equal(workspace?.managedWorktree?.branch, "aiden/fix-the-login-redirect");
  assert.equal(result.chat.workspaceId, result.worktree.workspaceId);
  assert.equal((await h.store.get(input.draftId))?.workspaceId, result.worktree.workspaceId);
  assert.equal(result.worktree.baseSource, "fetched");
  assert.equal(result.worktree.reused, false);
  assert.deepEqual(progress.map((event) => event.phase), ["fetching", "creating", "ready"]);
  assert.ok(progress.every((event) => event.draftId === input.draftId));
});

test("a worktree failure saves no chat and a retry with a usable base succeeds", async (t) => {
  const repos = await repositories(t);
  const h = await harness(t, repos.repository);
  const draftId = randomUUID();

  const failed = await h.commitInWorktree(
    parseChatFirstMessage(firstMessage("Ship it", { baseRef: "gone", fromOrigin: false }, draftId)),
    h.owner,
  );
  assert.equal(failed.ok, false);
  if (failed.ok) return;
  assert.equal(failed.code, "worktree-failed");
  assert.match(failed.detail ?? "", /gone/u);
  assert.equal(await h.store.get(draftId) ?? undefined, undefined);
  assert.deepEqual(await h.store.list(), []);
  assert.equal([...h.workspaces.values()].some((workspace) => workspace.managedWorktree), false);

  const retried = await h.commitInWorktree(
    parseChatFirstMessage(firstMessage("Ship it", { baseRef: "main", fromOrigin: false }, draftId)),
    h.owner,
  );
  assert.equal(retried.ok, true);
  assert.equal((await h.store.get(draftId))?.messages.length, 1);
});

test("double sends and retries of one draft create exactly one worktree", async (t) => {
  const repos = await repositories(t);
  const h = await harness(t, repos.repository);
  const input = firstMessage("Refactor the parser", { baseRef: "main", fromOrigin: false });

  const [first, second] = await Promise.all([
    h.commitInWorktree(parseChatFirstMessage(input), h.owner),
    h.commitInWorktree(parseChatFirstMessage(input), h.owner),
  ]);
  assert.ok(first.ok && second.ok);
  assert.equal(first.worktree.workspaceId, second.worktree.workspaceId);
  assert.deepEqual([first.worktree.reused, second.worktree.reused].sort(), [false, true]);

  // A later retry (for example after a reload) returns the same worktree and chat.
  h.turns.releaseMatching(input.draftId, input.turnId, h.owner.documentId);
  const replay = await h.commitInWorktree(parseChatFirstMessage(input), documentOwner());
  assert.ok(replay.ok);
  assert.equal(replay.worktree.workspaceId, first.worktree.workspaceId);
  assert.equal(replay.chat.messages[0]?.id, first.chat.messages[0]?.id);

  assert.deepEqual(h.createCalls, ["aiden/refactor-the-parser"]);
  assert.equal(
    (await git(repos.repository, ["worktree", "list", "--porcelain"])).split("\n").filter((line) => line.startsWith("worktree ")).length,
    2,
  );
});

test("after a restart, the attempt that saved its workspace but not its outcome is adopted", async (t) => {
  const repos = await repositories(t);
  // The `ready` write is lost, as if Aiden quit right after saving the workspace.
  const h = await harness(t, repos.repository, {
    ledger: (file) => {
      const inner = createFileFirstMessageWorktreeLedger({ filePath: async () => file });
      return {
        get: (key) => inner.get(key),
        delete: (key) => inner.delete(key),
        put: async (record) => {
          if (record.state === "ready") throw new Error("Injected crash");
          await inner.put(record);
        },
      };
    },
  });
  const input = firstMessage("Interrupted run", { baseRef: "main", fromOrigin: false });
  const first = await h.commitInWorktree(parseChatFirstMessage(input), h.owner);
  assert.ok(first.ok);
  const persisted = JSON.parse(await fs.readFile(h.ledgerFile, "utf8")) as { records: Array<{ key: string; state: string }> };
  assert.equal(persisted.records.find((record) => record.key === input.draftId)?.state, "pending");

  // A fresh coordinator reads the ledger from disk, as after a restart.
  const restarted = h.coordinatorFor(h.fileLedger());
  const adopted = await restarted.ensure(parseChatFirstMessage(input).worktree!, "Interrupted run", h.owner);
  assert.equal(adopted.workspaceId, first.worktree.workspaceId);
  assert.equal(adopted.reused, true);
  assert.deepEqual(h.createCalls, ["aiden/interrupted-run"]);
});

test("a retry never adopts a worktree this draft did not create", async (t) => {
  const repos = await repositories(t);
  const h = await harness(t, repos.repository);
  // The user's own managed worktree on feature/x.
  const theirs = await h.worktrees.create(h.owner, h.source.id, "feature/x");
  const draftId = randomUUID();
  const send = () => h.commitInWorktree(
    parseChatFirstMessage(firstMessage("Use feature x", { baseRef: "main", fromOrigin: false, branchName: "feature/x" }, draftId)),
    h.owner,
  );

  const failed = await send();
  assert.equal(failed.ok, false);
  assert.match(failed.ok ? "" : failed.code === "worktree-failed" ? failed.detail ?? "" : "", /already exists/u);
  const retried = await send();
  assert.equal(retried.ok, false, "the retry must not adopt the user's worktree");
  assert.equal(await h.store.get(draftId) ?? undefined, undefined);
  assert.equal(await h.fileLedger().get(draftId), undefined, "nothing is recorded for an existing branch");

  // Even a record naming that branch (but not that workspace's identity) is not adopted.
  await h.fileLedger().put({
    key: draftId, sourceWorkspaceId: h.source.id, state: "pending", baseRef: "main", fromOrigin: false,
    branch: "feature/x", workspaceId: "workspace-never-saved", ownershipToken: randomUUID(),
    baseCommit: await git(repos.repository, ["rev-parse", "main"]), startPoint: "main", baseSource: "local",
    updatedAt: Date.now(),
  });
  const auto = await h.commitInWorktree(
    parseChatFirstMessage(firstMessage("Use feature x", { baseRef: "main", fromOrigin: false }, draftId)),
    h.owner,
  );
  assert.ok(auto.ok);
  assert.notEqual(auto.worktree.workspaceId, theirs.id);
  assert.equal(auto.worktree.branch, "aiden/use-feature-x");
  assert.equal((await h.store.get(draftId))?.workspaceId, auto.worktree.workspaceId);
});

test("an interrupted attempt's unsaved worktree is rolled back, then created again", async (t) => {
  const repos = await repositories(t);
  const h = await harness(t, repos.repository);
  const draftId = randomUUID();
  const ownershipToken = randomUUID();
  const mainCommit = await git(repos.repository, ["rev-parse", "main"]);
  await fs.mkdir(h.worktreeRoot, { recursive: true });
  // Git created and claimed the worktree, then Aiden quit before saving it.
  const orphan = await h.service.createWorktree(repos.repository, h.worktreeRoot, "aiden/orphan", undefined, {
    startPoint: mainCommit,
    ownershipToken,
  });
  await h.fileLedger().put({
    key: draftId, sourceWorkspaceId: h.source.id, state: "pending", baseRef: "main", fromOrigin: false,
    requestedBranchName: "aiden/orphan", branch: "aiden/orphan", workspaceId: "workspace-never-saved",
    ownershipToken, baseCommit: mainCommit, startPoint: "main", baseSource: "local", updatedAt: Date.now(),
  });

  const result = await h.commitInWorktree(
    parseChatFirstMessage(firstMessage("Again", { baseRef: "main", fromOrigin: false, branchName: "aiden/orphan" }, draftId)),
    h.owner,
  );

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.worktree.branch, "aiden/orphan");
  await assert.rejects(fs.access(orphan.path), { code: "ENOENT" });
  const registered = (await git(repos.repository, ["worktree", "list", "--porcelain"]))
    .split("\n").filter((line) => line.startsWith("worktree "));
  assert.equal(registered.length, 2, "the checkout plus exactly one managed worktree");
});

test("a removed worktree does not block the draft: the retry creates a fresh one", async (t) => {
  const repos = await repositories(t);
  const h = await harness(t, repos.repository);
  const input = firstMessage("Short lived", { baseRef: "main", fromOrigin: false });
  const first = await h.commitInWorktree(parseChatFirstMessage(input), h.owner);
  assert.ok(first.ok);
  // The user deleted the worktree before the draft sent again.
  const managed = h.workspaces.get(first.worktree.workspaceId)!.managedWorktree!;
  await git(repos.repository, ["worktree", "remove", "--force", managed.worktreePath]);
  await git(repos.repository, ["branch", "-D", managed.branch]);
  h.workspaces.delete(first.worktree.workspaceId);

  const fresh = await h.coordinator.ensure(parseChatFirstMessage(input).worktree!, "Short lived", h.owner);
  assert.equal(fresh.reused, false);
  assert.notEqual(fresh.workspaceId, first.worktree.workspaceId);
  assert.equal(h.workspaces.get(fresh.workspaceId)?.managedWorktree?.branch, "aiden/short-lived");
});

test("a retry with different settings reports the existing worktree instead of reusing it silently", async (t) => {
  const repos = await repositories(t);
  const h = await harness(t, repos.repository);
  const draftId = randomUUID();
  const first = await h.coordinator.ensure(
    { sourceWorkspaceId: h.source.id, baseRef: "main", fromOrigin: false, idempotencyKey: draftId }, "Tune it", h.owner);
  for (const changed of [{ baseRef: "origin/main" }, { fromOrigin: true }, { branchName: "aiden/custom" }]) {
    const result = await h.commitInWorktree(
      parseChatFirstMessage(firstMessage("Tune it", { baseRef: "main", fromOrigin: false, ...changed }, draftId)),
      h.owner,
    );
    assert.deepEqual(result, {
      ok: false,
      code: "worktree-settings-changed",
      reason: "This draft already created worktree aiden/tune-it from main. Send again with those settings, or start a new chat to use different ones.",
      worktree: { workspaceId: first.workspaceId, branch: "aiden/tune-it", baseRef: "main", fromOrigin: false },
    }, JSON.stringify(changed));
  }
  assert.equal(await h.store.get(draftId) ?? undefined, undefined);
  assert.deepEqual(h.createCalls, ["aiden/tune-it"]);
});

test("a draft that failed in one workspace can send from another; a created worktree pins it", async (t) => {
  const repos = await repositories(t);
  const h = await harness(t, repos.repository);
  const mainCommit = await git(repos.repository, ["rev-parse", "main"]);
  for (const state of ["pending", "failed"] as const) {
    const draftId = randomUUID();
    // An attempt in the first workspace that never saved a worktree.
    await h.fileLedger().put({
      key: draftId, sourceWorkspaceId: h.source.id, state, baseRef: "main", fromOrigin: false,
      branch: `aiden/moved-${state}`, workspaceId: "workspace-never-saved", ownershipToken: randomUUID(),
      baseCommit: mainCommit, startPoint: "main", baseSource: "local", updatedAt: Date.now(),
    });
    const request = { sourceWorkspaceId: "workspace-other", baseRef: "main", fromOrigin: false, idempotencyKey: draftId };
    const moved = await h.coordinator.ensure(request, `Moved ${state}`, h.owner);
    assert.equal(moved.branch, `aiden/moved-${state}`, state);

    await assert.rejects(
      h.coordinator.ensure({ ...request, sourceWorkspaceId: h.source.id }, "Moved", h.owner),
      /another workspace/u,
      state,
    );
  }
});

test("a slash skill chosen in the draft's workspace runs in the new worktree chat", async (t) => {
  const repos = await repositories(t);
  const skill: RegisteredSkill = {
    stableId: "configured:review", invocationId: `sk1_${"a".repeat(43)}`,
    toolKey: "skill_review", name: "Review", description: "Review changes",
    instructions: "Inspect the diff carefully.", source: "configured", enabled: true, available: true,
  };
  const resolved: string[] = [];
  const h = await harness(t, repos.repository, {
    // Like the registry: an invocation id is valid only in the workspace that minted it.
    resolveSkill: async (workspaceId, invocationId) => {
      resolved.push(workspaceId);
      if (workspaceId !== "workspace-source" || invocationId !== skill.invocationId) {
        throw new Error("Skill selection expired or changed.");
      }
      return skill;
    },
  });
  const skillInvocation = { version: 1, invocationId: skill.invocationId, displayName: "Review", source: "configured" };
  const input = { ...firstMessage("Review the diff", { baseRef: "main", fromOrigin: false }), skillInvocation };

  const result = await h.commitInWorktree(parseChatFirstMessage(input), h.owner);

  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.chat.messages[0]?.skill, { version: 1, name: "Review", source: "configured" });
  assert.ok(resolved.every((workspaceId) => workspaceId === "workspace-source"));
  let preparedWorkspace: string | undefined;
  assert.equal(h.turns.handoff(input.draftId, input.turnId, h.owner.documentId, (prepared) => {
    preparedWorkspace = prepared?.workspaceId;
  }), true);
  assert.equal(preparedWorkspace, result.worktree.workspaceId, "generation runs in the worktree chat");

  // A stale selection fails before any worktree is created.
  const stale = { ...firstMessage("Review again", { baseRef: "main", fromOrigin: false }),
    skillInvocation: { ...skillInvocation, invocationId: `sk1_${"b".repeat(43)}` } };
  await assert.rejects(h.commitInWorktree(parseChatFirstMessage(stale), h.owner), /expired/u);
  assert.deepEqual(h.createCalls, ["aiden/review-the-diff"]);
});

test("the first-message parser ties a worktree request to its draft and workspace", () => {
  const draftId = randomUUID();
  const valid = firstMessage("Hi", { baseRef: "main", fromOrigin: true }, draftId);
  assert.deepEqual(parseChatFirstMessage(valid).worktree, {
    sourceWorkspaceId: "workspace-source",
    baseRef: "main",
    fromOrigin: true,
    idempotencyKey: draftId,
  });
  assert.equal(parseChatFirstMessage({ ...valid, worktree: undefined }).worktree, undefined);
  for (const worktree of [
    { ...valid.worktree, idempotencyKey: randomUUID() },
    { ...valid.worktree, sourceWorkspaceId: "workspace-other" },
    { ...valid.worktree, baseRef: "a b" },
    { ...valid.worktree, branchName: "bad..name" },
    { ...valid.worktree, fromOrigin: "yes" },
    { ...valid.worktree, path: "/tmp" },
  ]) {
    assert.throws(() => parseChatFirstMessage({ ...valid, worktree }), Error, JSON.stringify(worktree));
  }
});
