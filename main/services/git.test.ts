import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GitService, GitServiceError, parseGitStatus, parseRemoteRefs } from "./git.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" },
  });
  return String(result.stdout).trim();
}

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-git-test-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  return directory;
}

async function createRepository(t: test.TestContext): Promise<string> {
  const root = await temporaryDirectory(t);
  const repository = path.join(root, "repository");
  await fs.mkdir(repository);
  await git(repository, ["init", "--initial-branch=main"]);
  await git(repository, ["config", "user.email", "aiden@example.test"]);
  await git(repository, ["config", "user.name", "Aiden Test"]);
  await fs.writeFile(path.join(repository, "README.md"), "initial\n", "utf8");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "Initial commit"]);
  return repository;
}

test("parseGitStatus handles NUL-delimited paths and rename pairs", () => {
  const raw = [
    "# branch.oid 1234567890abcdef",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -3",
    "1 .M N... 100644 100644 100644 a a tab\tname.txt",
    "2 R. N... 100644 100644 100644 a b R100 new\nname.txt",
    "old\nname.txt",
    "? untracked\nfile.txt",
    "",
  ].join("\u0000");

  assert.deepEqual(parseGitStatus(raw), {
    branch: "main",
    detached: false,
    unborn: false,
    uncommitted: 3,
    upstream: "origin/main",
    ahead: 2,
    behind: 3,
  });
});

test("parseRemoteRefs resolves a non-origin default and omits symbolic HEAD refs", () => {
  const raw = [
    "refs/remotes/upstream/HEAD",
    "refs/remotes/upstream/main",
    "\nrefs/remotes/upstream/main",
    "",
    "\nrefs/remotes/upstream/topic",
    "",
    "\n",
  ].join("\u0000");
  assert.deepEqual(parseRemoteRefs(raw), {
    branches: ["upstream/main", "upstream/topic"],
    defaultBranch: "main",
  });
});

test("GitService reads NUL-safe status and executes unusual branch names without a shell", async (t) => {
  const repository = await createRepository(t);
  const service = new GitService({ cacheTtlMs: 0 });
  await fs.writeFile(path.join(repository, "tab\tname.txt"), "tab\n", "utf8");
  await fs.writeFile(path.join(repository, "line\nbreak.txt"), "line\n", "utf8");

  const status = await service.info(repository);
  assert.equal(status.isRepo, true);
  assert.equal(status.branch, "main");
  assert.equal(status.uncommitted, 2);

  const marker = path.join(repository, "SHOULD_NOT_EXIST");
  const unusualBranch = "feature/safe;touch-SHOULD_NOT_EXIST";
  await service.createBranch(repository, unusualBranch);
  assert.equal(await git(repository, ["branch", "--show-current"]), unusualBranch);
  await assert.rejects(fs.access(marker));

  await service.checkout(repository, "main");
  assert.equal(await git(repository, ["branch", "--show-current"]), "main");
  await git(repository, ["update-ref", "refs/remotes/origin/remote-only", "HEAD"]);
  await assert.rejects(
    service.checkout(repository, "remote-only"),
    (error) => error instanceof GitServiceError && error.code === "invalid_ref",
  );
  assert.equal(await git(repository, ["show-ref", "--verify", "--quiet", "refs/heads/remote-only"]).catch(() => "missing"), "missing");

  await assert.rejects(
    service.createBranch(repository, "-invalid"),
    (error) => error instanceof GitServiceError && error.code === "invalid_ref",
  );
});

test("GitService reports remotes, upstream divergence, default branch, and remote refs", async (t) => {
  const root = await temporaryDirectory(t);
  const remote = path.join(root, "remote.git");
  const repository = path.join(root, "primary");
  const peer = path.join(root, "peer");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await fs.mkdir(repository);
  await git(repository, ["init", "--initial-branch=main"]);
  await git(repository, ["config", "user.email", "aiden@example.test"]);
  await git(repository, ["config", "user.name", "Aiden Test"]);
  await fs.writeFile(path.join(repository, "base.txt"), "base\n", "utf8");
  await git(repository, ["add", "base.txt"]);
  await git(repository, ["commit", "-m", "Base"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await git(repository, ["push", "-u", "origin", "main"]);
  await git(repository, ["remote", "set-head", "origin", "--auto"]);

  await fs.writeFile(path.join(repository, "local.txt"), "local\n", "utf8");
  await git(repository, ["add", "local.txt"]);
  await git(repository, ["commit", "-m", "Local"]);

  await git(root, ["clone", remote, peer]);
  await git(peer, ["config", "user.email", "peer@example.test"]);
  await git(peer, ["config", "user.name", "Peer Test"]);
  await fs.writeFile(path.join(peer, "remote.txt"), "remote\n", "utf8");
  await git(peer, ["add", "remote.txt"]);
  await git(peer, ["commit", "-m", "Remote"]);
  await git(peer, ["push", "origin", "main"]);
  await git(repository, ["fetch", "origin"]);

  const service = new GitService({ cacheTtlMs: 0 });
  const info = await service.info(repository);
  assert.equal(info.upstream, "origin/main");
  assert.equal(info.ahead, 1);
  assert.equal(info.behind, 1);
  assert.equal(info.defaultBranch, "main");
  assert.equal(info.hasRemote, true);

  const branches = await service.branches(repository);
  assert.deepEqual(branches.branches, ["main"]);
  assert.deepEqual(branches.remoteBranches, ["origin/main"]);
});

test("GitService serializes mutations by common directory", async (t) => {
  const repository = await createRepository(t);
  const service = new GitService({ cacheTtlMs: 0 });

  await Promise.all([
    service.createBranch(repository, "feature/first"),
    service.createBranch(repository, "feature/second"),
  ]);

  const refs = (await git(repository, ["for-each-ref", "--format=%(refname:short)", "refs/heads/feature"])).split(
    "\n",
  );
  assert.deepEqual(refs.sort(), ["feature/first", "feature/second"]);

  await assert.rejects(service.createBranch(repository, "feature/first"));
  await service.createBranch(repository, "feature/after-failure");
  assert.equal(await git(repository, ["branch", "--show-current"]), "feature/after-failure");
});

test("GitService creates, lists, and removes managed worktrees", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const service = new GitService({ cacheTtlMs: 0 });

  const created = await service.createWorktree(repository, root, "codex/isolated");
  assert.equal(created.branch, "codex/isolated");
  assert.equal(created.current, true);
  assert.equal(path.relative(await fs.realpath(root), created.path).startsWith(".."), false);
  assert.equal((await fs.stat(created.path)).isDirectory(), true);
  assert.equal(await git(repository, ["branch", "--show-current"]), "main");

  const worktrees = await service.worktrees(repository);
  assert.equal(worktrees.length, 2);
  assert.equal(worktrees.some((worktree) => worktree.branch === "codex/isolated"), true);
  await assert.rejects(
    service.createWorktree(repository, root, "codex/isolated"),
    (error) => error instanceof GitServiceError && error.code === "invalid_ref",
  );

  await fs.writeFile(path.join(created.path, "dirty.txt"), "dirty\n", "utf8");
  await assert.rejects(
    service.deleteManagedWorktree(repository, created.path, created.branch, created.createdFromHead),
    (error) => error instanceof GitServiceError && error.code === "dirty_worktree",
  );
  await fs.rm(path.join(created.path, "dirty.txt"));

  const deleted = await service.deleteManagedWorktree(
    repository,
    created.path,
    created.branch,
    created.createdFromHead,
  );
  assert.equal(deleted.branchDeleted, true);
  await assert.rejects(fs.access(created.path));
  assert.equal((await service.worktrees(repository)).length, 1);
});

test("GitService bounds subprocess time and output", async (t) => {
  const root = await temporaryDirectory(t);
  const slowGit = path.join(root, "slow-git");
  const childPidFile = path.join(root, "child.pid");
  await fs.writeFile(slowGit, `#!/bin/sh\nsleep 30 &\necho $! > '${childPidFile}'\nwait\n`, {
    encoding: "utf8",
    mode: 0o700,
  });
  const slowService = new GitService({ gitBinary: slowGit, readTimeoutMs: 250 });
  await assert.rejects(
    slowService.info(root),
    (error) => error instanceof GitServiceError && error.code === "timeout",
  );
  const childPid = Number((await fs.readFile(childPidFile, "utf8")).trim());
  let childAlive = true;
  for (let attempt = 0; attempt < 10 && childAlive; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    try {
      process.kill(childPid, 0);
    } catch {
      childAlive = false;
    }
  }
  assert.equal(childAlive, false, "timeout should terminate descendants in Git's process group");

  const repository = await createRepository(t);
  for (let index = 0; index < 20; index += 1) {
    await git(repository, ["branch", `long-branch-name-${index.toString().padStart(2, "0")}`]);
  }
  const boundedService = new GitService({ cacheTtlMs: 0, maxBufferBytes: 160 });
  await assert.rejects(
    boundedService.branches(repository),
    (error) => error instanceof GitServiceError && error.code === "output_limit",
  );
});

test("GitService preserves nested workspace scope in managed worktrees", async (t) => {
  const repository = await createRepository(t);
  const nested = path.join(repository, "packages", "app");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, "index.ts"), "export {};\n", "utf8");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "Add nested workspace"]);
  const root = await temporaryDirectory(t);
  const service = new GitService({ cacheTtlMs: 0 });

  const created = await service.createWorktree(nested, root, "codex/nested");
  assert.equal(created.workspacePath, path.join(created.path, "packages", "app"));
  assert.equal((await fs.stat(created.workspacePath)).isDirectory(), true);
  await service.rollbackWorktree(nested, created);
});

test("GitService serializes mutations across linked worktree paths", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const service = new GitService({ cacheTtlMs: 0 });
  const created = await service.createWorktree(repository, root, "codex/linked");

  await Promise.all([
    service.createBranch(repository, "feature/from-main"),
    service.createBranch(created.path, "feature/from-linked"),
  ]);
  const refs = await git(repository, ["for-each-ref", "--format=%(refname:short)", "refs/heads/feature"]);
  assert.deepEqual(refs.split("\n").sort(), ["feature/from-linked", "feature/from-main"]);
});

test("GitService retries a read that crosses a mutation epoch", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const wrapper = path.join(root, "delayed-git");
  const started = path.join(root, "status-started");
  const snapshot = path.join(root, "status-snapshot");
  await fs.writeFile(
    wrapper,
    `#!/bin/sh\nif [ "$1" = "status" ] && [ ! -f '${started}' ]; then\n  /usr/bin/git "$@" > '${snapshot}' || exit $?\n  touch '${started}'\n  sleep 1\n  cat '${snapshot}'\n  exit 0\nfi\nexec /usr/bin/git "$@"\n`,
    { encoding: "utf8", mode: 0o700 },
  );
  const service = new GitService({ cacheTtlMs: 5_000, gitBinary: wrapper, readTimeoutMs: 3_000 });
  const pendingInfo = service.info(repository);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fs.access(started);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  await fs.access(started);
  await service.createBranch(repository, "feature/during-read");
  assert.equal((await pendingInfo).branch, "feature/during-read");
  assert.equal((await service.info(repository)).branch, "feature/during-read");
});

test("GitService rolls back a worktree when add times out after Git created it", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const wrapper = path.join(root, "git-wrapper");
  await fs.writeFile(
    wrapper,
    '#!/bin/sh\nif [ "$1" = "worktree" ] && [ "$2" = "add" ]; then\n  /usr/bin/git "$@" || exit $?\n  sleep 30\n  exit 0\nfi\nexec /usr/bin/git "$@"\n',
    { encoding: "utf8", mode: 0o700 },
  );
  const service = new GitService({ gitBinary: wrapper, mutationTimeoutMs: 100, readTimeoutMs: 2_000 });
  await assert.rejects(
    service.createWorktree(repository, root, "codex/timeout"),
    (error) => error instanceof GitServiceError && error.code === "timeout",
  );
  assert.equal((await service.worktrees(repository)).length, 1);
  await assert.rejects(git(repository, ["show-ref", "--verify", "refs/heads/codex/timeout"]));
});

test("GitService rejects branch/worktree creation in an unborn repository", async (t) => {
  const root = await temporaryDirectory(t);
  const repository = path.join(root, "unborn");
  await fs.mkdir(repository);
  await git(repository, ["init", "--initial-branch=main"]);
  const service = new GitService({ cacheTtlMs: 0 });
  const info = await service.info(repository);
  assert.equal(info.unborn, true);
  assert.equal(info.branch, "main");
  assert.deepEqual((await service.branches(repository)).branches, ["main"]);
  await assert.rejects(
    service.createBranch(repository, "feature/no-head"),
    (error) => error instanceof GitServiceError && error.code === "unborn",
  );
  await assert.rejects(
    service.createWorktree(repository, path.join(root, "worktrees"), "feature/no-head"),
    (error) => error instanceof GitServiceError && error.code === "unborn",
  );
});

test("GitService strips inherited repository-routing environment variables", async (t) => {
  const repository = await createRepository(t);
  const other = await createRepository(t);
  const previousGitDir = process.env.GIT_DIR;
  const previousWorkTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = path.join(other, ".git");
  process.env.GIT_WORK_TREE = other;
  try {
    const info = await new GitService({ cacheTtlMs: 0 }).info(repository);
    assert.equal(info.isRepo, true);
    assert.equal(info.branch, "main");
  } finally {
    if (previousGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDir;
    if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = previousWorkTree;
  }
});

test("GitService redacts credentials from command failures", async (t) => {
  const root = await temporaryDirectory(t);
  const failingGit = path.join(root, "failing-git");
  await fs.writeFile(
    failingGit,
    "#!/bin/sh\necho \"fatal: unable to access 'https://secret-token@example.test/repo?access_token=also-secret'\" >&2\nexit 1\n",
    { encoding: "utf8", mode: 0o700 },
  );
  const service = new GitService({ gitBinary: failingGit });
  await assert.rejects(service.info(root), (error) => {
    assert.equal(error instanceof GitServiceError, true);
    assert.equal((error as GitServiceError).message.includes("secret-token"), false);
    assert.equal((error as GitServiceError).message.includes("also-secret"), false);
    assert.equal((error as GitServiceError).message.includes("***"), true);
    return true;
  });
});

test("GitService fails soft for non-repositories", async (t) => {
  const directory = await temporaryDirectory(t);
  assert.deepEqual(await new GitService().info(directory), { isRepo: false });
});
