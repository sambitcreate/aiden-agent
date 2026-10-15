import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { GitRepoWatcher, resolveGitWatchTargets } from "./git-repo-watcher.js";

async function makeRepo(t: test.TestContext) {
  const root = realpathSync(await fs.mkdtemp(path.join(tmpdir(), "aiden-git-watch-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Synthetic");
  git(repo, "config", "user.email", "s@example.test");
  await fs.writeFile(path.join(repo, "src", "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "init");
  return { root, repo, git };
}

function recorder() {
  const events: { workspaceId: string; generation: number }[] = [];
  return {
    events,
    notify: (workspaceId: string, generation: number) => events.push({ workspaceId, generation }),
    async waitFor(count: number) {
      const deadline = Date.now() + 5_000;
      while (events.length < count) {
        if (Date.now() > deadline) assert.fail(`expected ${count} change notifications, saw ${events.length}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

test("resolves the administrative and shared Git directories for checkouts, subfolders and linked worktrees", async (t) => {
  const { root, repo, git } = await makeRepo(t);
  const gitDir = path.join(repo, ".git");
  assert.deepEqual(await resolveGitWatchTargets(repo), { gitDir, commonDir: gitDir });
  assert.deepEqual(await resolveGitWatchTargets(path.join(repo, "src")), { gitDir, commonDir: gitDir });

  const linked = path.join(root, "linked");
  git(repo, "worktree", "add", "-b", "feature", linked);
  assert.deepEqual(await resolveGitWatchTargets(linked), {
    gitDir: path.join(gitDir, "worktrees", "linked"),
    commonDir: gitDir,
  });

  const plain = path.join(root, "plain");
  await fs.mkdir(plain);
  // tmpdir() is not inside a repository, so discovery must stop at the filesystem root.
  assert.equal(await resolveGitWatchTargets(plain), undefined);
});

test("a commit produces one debounced notification and later changes advance the generation", async (t) => {
  const { repo, git } = await makeRepo(t);
  const seen = recorder();
  const watcher = new GitRepoWatcher({ notify: seen.notify });
  t.after(() => watcher.dispose());
  await watcher.observe("ws-1", repo);

  await fs.writeFile(path.join(repo, "src", "a.txt"), "a\nb\n");
  git(repo, "commit", "-am", "second");
  await seen.waitFor(1);
  await settle();
  // index, HEAD reflog and the branch ref all change; the burst collapses into one push.
  assert.deepEqual(seen.events, [{ workspaceId: "ws-1", generation: 1 }]);

  git(repo, "checkout", "-q", "-b", "topic");
  await seen.waitFor(2);
  assert.equal(seen.events[seen.events.length - 1]?.generation, 2);
  assert.equal(watcher.generation("ws-1"), seen.events[seen.events.length - 1]?.generation);
});

test("unstaged working-tree edits do not notify because only Git metadata is watched", async (t) => {
  const { repo } = await makeRepo(t);
  const seen = recorder();
  const watcher = new GitRepoWatcher({ notify: seen.notify, debounceMs: 20 });
  t.after(() => watcher.dispose());
  await watcher.observe("ws-1", repo);
  await fs.writeFile(path.join(repo, "src", "a.txt"), "edited\n");
  await fs.writeFile(path.join(repo, "src", "new.txt"), "new\n");
  await settle();
  assert.deepEqual(seen.events, []);
});

test("a linked worktree is told when another checkout moves a shared branch", async (t) => {
  const { root, repo, git } = await makeRepo(t);
  const linked = path.join(root, "linked");
  git(repo, "worktree", "add", "-b", "feature", linked);
  const seen = recorder();
  const watcher = new GitRepoWatcher({ notify: seen.notify, debounceMs: 20 });
  t.after(() => watcher.dispose());
  await watcher.observe("linked", linked);
  // The main checkout commits on main: refs live in the common dir, not the linked gitdir.
  git(repo, "commit", "--allow-empty", "-m", "elsewhere");
  await seen.waitFor(1);
  assert.equal(seen.events[0]?.workspaceId, "linked");
});

test("idle workspaces stop being watched until they are read again", async (t) => {
  const { repo, git } = await makeRepo(t);
  let clock = 0;
  const seen = recorder();
  const watcher = new GitRepoWatcher({ notify: seen.notify, debounceMs: 20, idleMs: 1_000, now: () => clock });
  t.after(() => watcher.dispose());
  await watcher.observe("ws-1", repo);
  clock = 500;
  watcher.evictIdle();
  assert.equal(watcher.watchedWorkspaceCount, 1);
  clock = 1_000;
  watcher.evictIdle();
  assert.equal(watcher.watchedWorkspaceCount, 0);

  git(repo, "commit", "--allow-empty", "-m", "while idle");
  await settle();
  assert.deepEqual(seen.events, []);

  await watcher.observe("ws-1", repo);
  git(repo, "commit", "--allow-empty", "-m", "after reading again");
  await seen.waitFor(1);
});

test("non-repository folders are tolerated and never notify", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "aiden-git-watch-plain-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const seen = recorder();
  const watcher = new GitRepoWatcher({ notify: seen.notify, debounceMs: 20 });
  t.after(() => watcher.dispose());
  await watcher.observe("plain", root);
  await fs.writeFile(path.join(root, "file.txt"), "x");
  await settle(200);
  assert.deepEqual(seen.events, []);
});
